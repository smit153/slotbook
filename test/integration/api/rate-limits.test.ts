import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { testDb, truncateAll } from '../../helpers/db.js';
import { assertSeatInvariant } from '../../helpers/invariants.js';
import { makeApp, TEST_ORIGIN } from '../../helpers/app.js';
import { scenario } from '../../helpers/scenario.js';
import { RATE_LIMITS } from '../../../src/server/http/rate-limits.js';

/**
 * Phase 12: every public endpoint has a per-IP limit (requests per minute), 429 RATE_LIMITED +
 * Retry-After beyond it. Requests here are cheap on purpose (unknown ids, missing headers): the
 * limiter counts every request, whatever its outcome, and runs before the handler.
 */
const db = testDb();
afterAll(() => db.destroy());
beforeEach(() => truncateAll(db));
afterEach(() => assertSeatInvariant(db));

const TOKEN = 'A'.repeat(43);
const UUID = '00000000-0000-4000-8000-000000000000';
type Req = { method: 'GET' | 'POST'; url: string; payload?: object; headers?: Record<string, string> };
const ROUTES: Array<[keyof typeof RATE_LIMITS, Req]> = [
  ['eventInfo', { method: 'GET', url: '/api/hosts/nobody/events/none' }],
  ['slots', { method: 'GET', url: '/api/hosts/nobody/events/none/slots' }],
  ['hold', { method: 'POST', url: '/api/holds', payload: {} }], // no Idempotency-Key → 400
  ['release', { method: 'POST', url: `/api/holds/${UUID}/release`, payload: { hold_secret: 'x' } }],
  ['confirm', { method: 'POST', url: `/api/holds/${UUID}/confirm`, payload: {} }],
  ['bookingView', { method: 'GET', url: `/api/bookings/${TOKEN}` }],
  ['reschedule', { method: 'POST', url: `/api/bookings/${TOKEN}/reschedule`, payload: {} }],
  ['cancel', { method: 'POST', url: `/api/bookings/${TOKEN}/cancel`, payload: {} }],
  ['waitlistJoin', { method: 'POST', url: '/api/waitlist', payload: {} }], // no Idempotency-Key → 400
  ['waitlistView', { method: 'GET', url: `/api/waitlist/${UUID}` }],
  ['waitlistClaim', { method: 'POST', url: `/api/waitlist/${UUID}/claim` }],
  ['waitlistLeave', { method: 'POST', url: `/api/waitlist/${UUID}/leave` }],
  ['login', { method: 'POST', url: '/api/auth/login', payload: { email: 'x@example.test', password: 'nope' }, headers: { origin: TEST_ORIGIN } }],
];

const send = (app: FastifyInstance, r: Req, ip: string) =>
  app.inject({ method: r.method, url: r.url, payload: r.payload, headers: r.headers, remoteAddress: ip });

describe('per-IP rate limits on every public endpoint', () => {
  it.each(ROUTES)('%s: the limit passes, one more → 429 RATE_LIMITED + Retry-After; another IP is unaffected', async (name, req) => {
    const app = await makeApp(db);
    const limit = RATE_LIMITS[name];
    for (let i = 0; i < limit; i++) expect((await send(app, req, '198.51.100.10')).statusCode).not.toBe(429);
    const over = await send(app, req, '198.51.100.10');
    expect([over.statusCode, over.json().error.code]).toEqual([429, 'RATE_LIMITED']);
    expect(Number(over.headers['retry-after'])).toBeGreaterThan(0);
    expect((await send(app, req, '198.51.100.11')).statusCode).not.toBe(429);
    await app.close();
  });

  it('each route has its own bucket: exhausting slots does not limit holds', async () => {
    const sc = await scenario(db);
    const app = await makeApp(db);
    const slots = ROUTES.find(([n]) => n === 'slots')![1];
    for (let i = 0; i <= RATE_LIMITS.slots; i++) await send(app, slots, '198.51.100.20');
    expect((await send(app, slots, '198.51.100.20')).statusCode).toBe(429);
    const hold = await app.inject({ method: 'POST', url: '/api/holds', remoteAddress: '198.51.100.20', headers: { 'idempotency-key': 'k-bucket-0001' },
      payload: { host: sc.hostSlug, slug: sc.ev.slug, start_at: sc.slot.toISOString() } });
    expect(hold.statusCode).toBe(201);
    await app.close();
  });

  it('a refused hold leaves nothing behind (no booking, no idempotency key)', async () => {
    const sc = await scenario(db);
    const app = await makeApp(db);
    const bad = ROUTES.find(([n]) => n === 'hold')![1];
    for (let i = 0; i < RATE_LIMITS.hold; i++) await send(app, bad, '198.51.100.30');
    const refused = await app.inject({ method: 'POST', url: '/api/holds', remoteAddress: '198.51.100.30', headers: { 'idempotency-key': 'k-refused-001' },
      payload: { host: sc.hostSlug, slug: sc.ev.slug, start_at: sc.slot.toISOString() } });
    expect(refused.statusCode).toBe(429);
    expect(await db.selectFrom('bookings').selectAll().execute()).toEqual([]);
    expect(await db.selectFrom('idempotency_keys').selectAll().execute()).toEqual([]);
    await app.close();
  });

  it('behind a proxy (TRUST_PROXY=1) the limit follows X-Forwarded-For, not the proxy address', async () => {
    const app = await makeApp(db, { env: { TRUST_PROXY: '1' } });
    const r = ROUTES.find(([n]) => n === 'login')![1];
    const viaProxy = (client: string) => app.inject({ ...r, remoteAddress: '10.0.0.1', headers: { ...r.headers, 'x-forwarded-for': client } });
    for (let i = 0; i < RATE_LIMITS.login; i++) await viaProxy('203.0.113.1');
    expect((await viaProxy('203.0.113.1')).statusCode).toBe(429);
    expect((await viaProxy('203.0.113.2')).statusCode).not.toBe(429); // same proxy, different client
    await app.close();
  });

  it('RATE_LIMIT_MULTIPLIER scales every limit (the k6 setup uses 1000)', async () => {
    const app = await makeApp(db, { env: { RATE_LIMIT_MULTIPLIER: '3' } });
    const r = ROUTES.find(([n]) => n === 'login')![1];
    for (let i = 0; i < RATE_LIMITS.login * 3; i++) expect((await send(app, r, '198.51.100.40')).statusCode).not.toBe(429);
    expect((await send(app, r, '198.51.100.40')).statusCode).toBe(429);
    await app.close();
  });
});
