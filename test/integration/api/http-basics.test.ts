import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { testDb, truncateAll } from '../../helpers/db.js';
import { assertSeatInvariant } from '../../helpers/invariants.js';
import { makeApp } from '../../helpers/app.js';
import { scenario } from '../../helpers/scenario.js';

const db = testDb();
afterAll(() => db.destroy());
beforeEach(() => truncateAll(db));
afterEach(() => assertSeatInvariant(db));

const holdPayload = (sc: Awaited<ReturnType<typeof scenario>>) => ({ host: sc.hostSlug, slug: sc.ev.slug, start_at: sc.slot.toISOString() });
const pgErr = (code: string) => Object.assign(new Error(`simulated ${code}`), { code });

describe('headers on every response', () => {
  it('security headers + a request id', async () => {
    const app = await makeApp(db);
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.headers['cache-control']).toBeUndefined();
    await app.close();
  });

  it('routes that carry secrets or bookings add no-store + noindex', async () => {
    const app = await makeApp(db);
    const res = await app.inject({ method: 'GET', url: `/api/bookings/${'A'.repeat(43)}` });
    expect(res.statusCode).toBe(404);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-robots-tag']).toBe('noindex, nofollow');
    await app.close();
  });
});

describe('error contract: always {error:{code,message}}, never a stack', () => {
  it('unknown /api route → JSON 404', async () => {
    const app = await makeApp(db);
    const res = await app.inject({ method: 'GET', url: '/api/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
    await app.close();
  });

  it('a form-encoded body → 415; broken JSON → 400', async () => {
    const app = await makeApp(db);
    const form = await app.inject({ method: 'POST', url: '/api/holds', headers: { 'content-type': 'application/x-www-form-urlencoded', 'idempotency-key': 'k-12345678' }, payload: 'a=b' });
    expect(form.statusCode).toBe(415);
    expect(form.json().error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
    const broken = await app.inject({ method: 'POST', url: '/api/holds', headers: { 'content-type': 'application/json', 'idempotency-key': 'k-12345678' }, payload: '{"host":' });
    expect(broken.statusCode).toBe(400);
    expect(broken.json().error.code).toBe('INVALID_JSON');
    await app.close();
  });

  it('an unexpected exception → 500 INTERNAL with the request id, no stack trace', async () => {
    const sc = await scenario(db);
    const app = await makeApp(db, { faults: { onAttempt: () => { throw new Error('kaboom at line 42'); } } });
    const res = await app.inject({ method: 'POST', url: '/api/holds', headers: { 'idempotency-key': 'k-12345678' }, payload: holdPayload(sc) });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: { code: 'INTERNAL', message: 'Something went wrong', request_id: res.headers['x-request-id'] } });
    expect(res.body).not.toContain('kaboom');
    expect(res.body).not.toContain('.ts:');
    await app.close();
  });
});

describe('40P01 / 40001: one automatic retry, then 503 + Retry-After, never 500', () => {
  it('a single deadlock is retried transparently → 201', async () => {
    const sc = await scenario(db);
    const app = await makeApp(db, { faults: { onAttempt: (n) => { if (n === 1) throw pgErr('40P01'); } } });
    const res = await app.inject({ method: 'POST', url: '/api/holds', headers: { 'idempotency-key': 'k-12345678' }, payload: holdPayload(sc) });
    expect(res.statusCode).toBe(201);
    await app.close();
  });

  it.each(['40P01', '40001'])('%s on both attempts → 503 TRY_AGAIN with Retry-After: 1', async (code) => {
    const sc = await scenario(db);
    const app = await makeApp(db, { faults: { onAttempt: () => { throw pgErr(code); } } });
    const res = await app.inject({ method: 'POST', url: '/api/holds', headers: { 'idempotency-key': 'k-12345678' }, payload: holdPayload(sc) });
    expect(res.statusCode).toBe(503);
    expect(res.headers['retry-after']).toBe('1');
    expect(res.json().error.code).toBe('TRY_AGAIN');
    await app.close();
  });

  it('…also when one escapes a code path that does not use writeTx (error-handler safety net)', async () => {
    const app = await makeApp(db);
    app.get('/api/__test/serialization', async () => { throw pgErr('40001'); });
    app.get('/api/__test/lock', async () => { throw pgErr('55P03'); });
    const a = await app.inject({ method: 'GET', url: '/api/__test/serialization' });
    const b = await app.inject({ method: 'GET', url: '/api/__test/lock' });
    expect([a.statusCode, a.headers['retry-after'], a.json().error.code]).toEqual([503, '1', 'TRY_AGAIN']);
    expect([b.statusCode, b.headers['retry-after'], b.json().error.code]).toEqual([503, '1', 'HOST_BUSY']);
    await app.close();
  });

  it('a lock wait beyond lock_timeout → 503 HOST_BUSY with Retry-After', async () => {
    const sc = await scenario(db);
    const app = await makeApp(db, { lockTimeoutMs: 200 });
    let release!: () => void;
    const released = new Promise<void>((r) => { release = r; });
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => { locked = r; });
    const blocker = db.transaction().execute(async (trx) => {
      await sql`SELECT id FROM hosts WHERE id = ${sc.hostId} FOR UPDATE`.execute(trx);
      locked();
      await released;
    });
    await isLocked;
    const res = await app.inject({ method: 'POST', url: '/api/holds', headers: { 'idempotency-key': 'k-12345678' }, payload: holdPayload(sc) });
    release();
    await blocker;
    expect([res.statusCode, res.headers['retry-after'], res.json().error.code]).toEqual([503, '1', 'HOST_BUSY']);
    await app.close();
  });
});
