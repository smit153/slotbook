import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { testDb, truncateAll } from '../../helpers/db.js';
import { assertSeatInvariant } from '../../helpers/invariants.js';
import { GUEST } from '../../helpers/flows.js';
import { makeApp, nextIp } from '../../helpers/app.js';
import { NY, dbNow, scenario, type Scenario } from '../../helpers/scenario.js';
import { DateTime } from 'luxon';
import type { Database } from '../../../src/server/db/kysely.js';

/** First Sunday of November (US DST end) that is more than 2 days after the DB's now. */
async function nextUsFallBack(d: Database): Promise<string> {
  const now = DateTime.fromJSDate(await dbNow(d), { zone: NY });
  for (let year = now.year; ; year++) {
    const nov1 = DateTime.fromObject({ year, month: 11, day: 1 }, { zone: NY });
    const sunday = nov1.plus({ days: (7 - nov1.weekday) % 7 });
    if (sunday > now.plus({ days: 2 })) return sunday.toISODate()!;
  }
}

const db = testDb({ max: 40 });
afterAll(() => db.destroy());
beforeEach(() => truncateAll(db));
afterEach(() => assertSeatInvariant(db));

const MIN = 60_000;
const holdBody = (sc: Scenario, start = sc.slot) => ({ host: sc.hostSlug, slug: sc.ev.slug, start_at: start.toISOString() });
const postHold = (app: FastifyInstance, sc: Scenario, o: { key?: string; ip?: string; start?: Date; headers?: Record<string, string> } = {}) =>
  app.inject({
    method: 'POST', url: '/api/holds', remoteAddress: o.ip ?? nextIp(),
    headers: { 'idempotency-key': o.key ?? randomUUID(), ...o.headers }, payload: holdBody(sc, o.start),
  });

describe('POST /api/holds', () => {
  it('R1 over HTTP: 20 parallel requests for one seat → 1 × 201, 19 × 409', async () => {
    const sc = await scenario(db);
    const app = await makeApp(db, { lockTimeoutMs: 30_000 }); // correctness, not the fail-fast timeout
    const res = await Promise.all(Array.from({ length: 20 }, () => postHold(app, sc)));
    const codes = res.map((r) => r.statusCode);
    expect(codes.filter((c) => c === 201)).toHaveLength(1);
    expect(codes.filter((c) => c === 409)).toHaveLength(19);
    expect(res.find((r) => r.statusCode === 409)!.json().error.code).toBe('SLOT_UNAVAILABLE');
    await app.close();
  });

  it('R5 over HTTP: same key twice → same body, the replay says Idempotent-Replayed: true', async () => {
    const sc = await scenario(db);
    const app = await makeApp(db);
    const key = randomUUID();
    const a = await postHold(app, sc, { key });
    const b = await postHold(app, sc, { key });
    expect([a.statusCode, b.statusCode]).toEqual([201, 201]);
    expect(a.headers['idempotent-replayed']).toBeUndefined();
    expect(b.headers['idempotent-replayed']).toBe('true');
    const { server_now: _a, ...ra } = a.json();
    const { server_now: _b, ...rb } = b.json();
    expect(rb).toEqual(ra);
    expect(a.headers['cache-control']).toBe('no-store');
    await app.close();
  });

  it('missing Idempotency-Key → 400 IDEMPOTENCY_KEY_REQUIRED', async () => {
    const sc = await scenario(db);
    const app = await makeApp(db);
    const res = await app.inject({ method: 'POST', url: '/api/holds', payload: holdBody(sc) });
    expect([res.statusCode, res.json().error.code]).toEqual([400, 'IDEMPOTENCY_KEY_REQUIRED']);
    await app.close();
  });

  it('R22 over HTTP: the 4th hold from one IP → 429 HOLD_LIMIT with Retry-After', async () => {
    const sc = await scenario(db);
    const app = await makeApp(db);
    for (let i = 0; i < 3; i++) expect((await postHold(app, sc, { ip: '198.51.100.9', start: new Date(sc.slot.getTime() + i * 30 * MIN) })).statusCode).toBe(201);
    const fourth = await postHold(app, sc, { ip: '198.51.100.9', start: new Date(sc.slot.getTime() + 90 * MIN) });
    expect([fourth.statusCode, fourth.json().error.code, fourth.headers['retry-after']]).toEqual([429, 'HOLD_LIMIT', '60']);
    await app.close();
  });

  it('TRUST_PROXY=1: the client IP comes from X-Forwarded-For (one proxy hop); without it, spoofing does nothing', async () => {
    const sc = await scenario(db);
    const behindProxy = await makeApp(db, { env: { TRUST_PROXY: '1' } });
    for (let i = 0; i < 3; i++) {
      // Same proxy peer, three different real clients → no cap hit.
      const r = await postHold(behindProxy, sc, { ip: '10.0.0.1', headers: { 'x-forwarded-for': `203.0.113.${i + 1}` }, start: new Date(sc.slot.getTime() + i * 30 * MIN) });
      expect(r.statusCode).toBe(201);
    }
    const ips = await db.selectFrom('bookings').select('client_ip').orderBy('created_at').execute();
    expect(ips.map((r) => r.client_ip)).toEqual(['203.0.113.1', '203.0.113.2', '203.0.113.3']);
    await behindProxy.close();

    await truncateAll(db);
    const sc2 = await scenario(db);
    const direct = await makeApp(db); // TRUST_PROXY=false
    for (let i = 0; i < 3; i++) await postHold(direct, sc2, { ip: '198.51.100.7', headers: { 'x-forwarded-for': `203.0.113.${i + 1}` }, start: new Date(sc2.slot.getTime() + i * 30 * MIN) });
    const capped = await postHold(direct, sc2, { ip: '198.51.100.7', headers: { 'x-forwarded-for': '203.0.113.99' }, start: new Date(sc2.slot.getTime() + 90 * MIN) });
    expect(capped.statusCode).toBe(429);
    await direct.close();
  });
});

describe('release, confirm and the manage link over HTTP', () => {
  it('hold → confirm (manage_url uses the fragment) → view → reschedule → cancel', async () => {
    const sc = await scenario(db);
    const app = await makeApp(db);
    const { hold_id, hold_secret } = (await postHold(app, sc)).json();

    const bad = await app.inject({ method: 'POST', url: `/api/holds/${hold_id}/confirm`, payload: { hold_secret: 'x', ...GUEST } });
    expect(bad.statusCode).toBe(404);

    const c = await app.inject({ method: 'POST', url: `/api/holds/${hold_id}/confirm`, payload: { hold_secret, ...GUEST } });
    expect(c.statusCode).toBe(200);
    const { manage_token, manage_url, booking } = c.json();
    expect(manage_url).toBe(`/manage#${manage_token}`);
    expect(booking.status).toBe('confirmed');

    const view = await app.inject({ method: 'GET', url: `/api/bookings/${manage_token}` });
    expect(view.statusCode).toBe(200);
    expect(view.json().booking).toMatchObject({ id: hold_id, status: 'confirmed', host: { slug: sc.hostSlug } });
    expect(view.headers['x-robots-tag']).toBe('noindex, nofollow');

    const moved = await app.inject({ method: 'POST', url: `/api/bookings/${manage_token}/reschedule`, payload: { start_at: new Date(sc.slot.getTime() + 60 * MIN).toISOString() } });
    expect(moved.statusCode).toBe(200);

    const cancel1 = await app.inject({ method: 'POST', url: `/api/bookings/${manage_token}/cancel`, payload: {} });
    const cancel2 = await app.inject({ method: 'POST', url: `/api/bookings/${manage_token}/cancel`, payload: {} });
    expect([cancel1.statusCode, cancel2.statusCode]).toEqual([200, 200]);
    await app.close();
  });

  it('a body-less cancel and release are accepted (empty JSON body is not required)', async () => {
    const sc = await scenario(db);
    const app = await makeApp(db);
    const { hold_id, hold_secret } = (await postHold(app, sc)).json();
    const rel = await app.inject({ method: 'POST', url: `/api/holds/${hold_id}/release`, payload: { hold_secret } });
    expect(rel.statusCode).toBe(200);
    const noBody = await app.inject({ method: 'POST', url: `/api/bookings/${'A'.repeat(43)}/cancel` });
    expect(noBody.statusCode).toBe(404);
    await app.close();
  });

  it('expired hold → 410 passes through; unknown manage token → 404', async () => {
    const sc = await scenario(db);
    const app = await makeApp(db);
    const { hold_id, hold_secret } = (await postHold(app, sc)).json();
    await db.updateTable('bookings').set({ expires_at: new Date('2000-01-01T00:00:00Z') }).where('id', '=', hold_id).execute();
    const c = await app.inject({ method: 'POST', url: `/api/holds/${hold_id}/confirm`, payload: { hold_secret, ...GUEST } });
    expect([c.statusCode, c.json().error.code]).toEqual([410, 'HOLD_EXPIRED']);
    expect((await app.inject({ method: 'GET', url: `/api/bookings/${'B'.repeat(43)}` })).statusCode).toBe(404);
    await app.close();
  });
});

describe('GET event + slots', () => {
  it('event info; deactivated → 404', async () => {
    const sc = await scenario(db);
    const app = await makeApp(db);
    const info = await app.inject({ method: 'GET', url: `/api/hosts/${sc.hostSlug}/events/${sc.ev.slug}` });
    expect(info.json()).toMatchObject({ host: { slug: sc.hostSlug, timezone: 'America/New_York' }, event_type: { slug: sc.ev.slug, duration_min: 30 } });
    await db.updateTable('event_types').set({ active: false }).where('id', '=', sc.ev.id).execute();
    expect((await app.inject({ method: 'GET', url: `/api/hosts/${sc.hostSlug}/events/${sc.ev.slug}` })).statusCode).toBe(404);
    await app.close();
  });

  it('slots carry UTC instants plus labels in the requested tz (Berlin) and seats_left', async () => {
    const sc = await scenario(db);
    const app = await makeApp(db);
    const from = sc.slot.toISOString();
    const to = new Date(sc.slot.getTime() + 60 * MIN).toISOString();
    const res = await app.inject({ method: 'GET', url: `/api/hosts/${sc.hostSlug}/events/${sc.ev.slug}/slots?from=${from}&to=${to}&tz=Europe/Berlin` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.tz).toBe('Europe/Berlin');
    expect(body.slots).toHaveLength(2);
    expect(body.slots[0]).toMatchObject({ start_at: from, seats_left: 1, local: { ambiguous: false } });
    expect(body.slots[0].local.label).toMatch(/^Mon \d{1,2} \w{3}, \d{2}:\d{2} GMT\+[12]$/);
    await app.close();
  });

  it('the NEXT US fall-back night: the two 01:00 slots are flagged ambiguous and labelled EDT / EST', async () => {
    // Computed from the DB clock so the test never silently skips (Nov 1 2026 is already past).
    const sc = await scenario(db, { horizon_days: 365 });
    const night = await nextUsFallBack(db);
    await db.insertInto('date_overrides').values({ host_id: sc.hostId, date: night, kind: 'custom' }).execute();
    await db.insertInto('date_override_windows').values({ host_id: sc.hostId, date: night, start_time: '00:00', end_time: '03:00' }).execute();
    const app = await makeApp(db);
    const from = DateTime.fromISO(night, { zone: NY }).toUTC().toISO()!;
    const to = DateTime.fromISO(night, { zone: NY }).plus({ hours: 5 }).toUTC().toISO()!;
    const res = await app.inject({ method: 'GET', url: `/api/hosts/${sc.hostSlug}/events/${sc.ev.slug}/slots?from=${from}&to=${to}` });
    expect(res.statusCode).toBe(200);
    const slots = res.json().slots as Array<{ local: { time: string; label: string; ambiguous: boolean } }>;
    expect(slots).toHaveLength(8);
    const ones = slots.filter((s) => s.local.time.startsWith('01:'));
    expect(ones.map((s) => s.local.label.slice(-3))).toEqual(['EDT', 'EDT', 'EST', 'EST']);
    expect(ones.every((s) => s.local.ambiguous)).toBe(true);
    expect(slots.filter((s) => !s.local.time.startsWith('01:')).every((s) => !s.local.ambiguous)).toBe(true);
    await app.close();
  });

  it('bad queries → 400 (missing range, > 31 days, bad tz); a browser alias tz is fine', async () => {
    const sc = await scenario(db);
    const app = await makeApp(db);
    const base = `/api/hosts/${sc.hostSlug}/events/${sc.ev.slug}/slots`;
    const from = sc.slot.toISOString();
    const long = new Date(sc.slot.getTime() + 32 * 24 * 60 * MIN).toISOString();
    const to = new Date(sc.slot.getTime() + 60 * MIN).toISOString();
    expect((await app.inject({ method: 'GET', url: base })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: `${base}?from=${from}&to=${long}` })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: `${base}?from=${from}&to=${to}&tz=Mars/Base` })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: `${base}?from=${from}&to=${to}&tz=Asia/Calcutta` })).statusCode).toBe(200);
    await app.close();
  });
});
