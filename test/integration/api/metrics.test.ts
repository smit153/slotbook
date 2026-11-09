import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import type { FastifyInstance } from 'fastify';
import { testDb, truncateAll } from '../../helpers/db.js';
import { assertSeatInvariant } from '../../helpers/invariants.js';
import { book } from '../../helpers/flows.js';
import { makeApp, TEST_ORIGIN } from '../../helpers/app.js';
import { APP_SECRET, holdRequest, scenario } from '../../helpers/scenario.js';
import { createHold, type HoldCreated } from '../../../src/server/services/holds.js';
import { confirmHold } from '../../../src/server/services/confirm.js';
import { releaseHold } from '../../../src/server/services/release.js';
import { cancelByGuest } from '../../../src/server/services/cancel.js';
import { runSweepOnce } from '../../../src/server/workers/sweeper.js';
import { RATE_LIMITS } from '../../../src/server/http/rate-limits.js';

/** Phase 12: GET /metrics (Prometheus text). Every number is checked against what was done. */
const db = testDb({ max: 10 });
const deps = { db, appSecret: APP_SECRET };
afterAll(() => db.destroy());
beforeEach(() => truncateAll(db));
afterEach(() => assertSeatInvariant(db));

/** Parse the exposition format strictly: every sample line must belong to a declared metric. */
function parse(text: string): Map<string, number> {
  const declared = new Set<string>();
  const samples = new Map<string, number>();
  for (const line of text.trimEnd().split('\n')) {
    const meta = line.match(/^# (HELP|TYPE) ([a-z_]+) (.+)$/);
    if (meta) { if (meta[1] === 'TYPE') { expect(['gauge', 'counter']).toContain(meta[3]); declared.add(meta[2]!); } continue; }
    const m = line.match(/^([a-z_]+)(\{[a-z_]+="[^"\\]*"(?:,[a-z_]+="[^"\\]*")*\})? (-?\d+(?:\.\d+)?)$/);
    expect(m, `not a valid sample line: ${line}`).not.toBeNull();
    expect(declared, `sample before its # TYPE: ${line}`).toContain(m![1]);
    samples.set(`${m![1]}${m![2] ?? ''}`, Number(m![3]));
  }
  return samples;
}
async function scrape(app: FastifyInstance): Promise<Map<string, number>> {
  const res = await app.inject({ method: 'GET', url: '/metrics' });
  expect(res.statusCode).toBe(200);
  expect(res.headers['content-type']).toMatch(/^text\/plain; version=0\.0\.4/);
  expect(res.headers['cache-control']).toBe('no-store');
  return parse(res.body);
}
const expire = (id: string) => sql`UPDATE bookings SET expires_at = clock_timestamp() - interval '1 second' WHERE id = ${id}`.execute(db);
const hold = async (sc: Awaited<ReturnType<typeof scenario>>, startAt: Date) =>
  (await createHold(deps, holdRequest(sc, { startAt }))).body as HoldCreated;
const at = (sc: Awaited<ReturnType<typeof scenario>>, minutes: number) => new Date(sc.slot.getTime() + minutes * 60_000);

describe('GET /metrics', () => {
  it('an empty database: every series present and zero', async () => {
    const app = await makeApp(db);
    const m = await scrape(app);
    for (const s of ['held', 'confirmed', 'cancelled', 'expired']) expect(m.get(`slotbook_bookings{status="${s}"}`)).toBe(0);
    expect(m.get('slotbook_holds_active')).toBe(0);
    expect(m.get('slotbook_notifications_pending')).toBe(0);
    expect(m.get('slotbook_notification_lag_seconds')).toBe(0);
    await app.close();
  });

  it('bookings by status: one held, two confirmed, one cancelled, one expired', async () => {
    const sc = await scenario(db, { capacity: 1, duration_min: 30 });
    const app = await makeApp(db);
    await hold(sc, at(sc, 0)); // held, still active
    await book(db, sc, { startAt: at(sc, 30) });
    const toCancel = await book(db, sc, { startAt: at(sc, 60) });
    await cancelByGuest(deps, toCancel.token, {});
    const stale = await hold(sc, at(sc, 90));
    await expire(stale.hold_id);
    await runSweepOnce(db);

    const m = await scrape(app);
    expect(m.get('slotbook_bookings{status="held"}')).toBe(1);
    expect(m.get('slotbook_bookings{status="confirmed"}')).toBe(1);
    expect(m.get('slotbook_bookings{status="cancelled"}')).toBe(1);
    expect(m.get('slotbook_bookings{status="expired"}')).toBe(1);
    expect(m.get('slotbook_holds_active')).toBe(1);
    await app.close();
  });

  it('hold expiries by cause (sweeper, a hold sweeping its host, confirm) and releases', async () => {
    const sc = await scenario(db, { capacity: 1, duration_min: 30 });
    const app = await makeApp(db);
    // 1. sweeper
    await expire((await hold(sc, at(sc, 0))).hold_id);
    await runSweepOnce(db);
    // 2. confirm after expiry → 410, recorded as via=confirm
    const late = await hold(sc, at(sc, 30));
    await expire(late.hold_id);
    expect((await confirmHold(deps, late.hold_id, { hold_secret: late.hold_secret, name: 'A', email: 'a@example.test', tz: 'UTC' })).status).toBe(410);
    // 3. a new hold on the host sweeps the stale one inline (via=hold)
    await expire((await hold(sc, at(sc, 60))).hold_id);
    await hold(sc, at(sc, 120));
    // 4. a release is counted separately, not as an expiry
    const gone = await hold(sc, at(sc, 150));
    expect((await releaseHold(deps, gone.hold_id, { hold_secret: gone.hold_secret })).status).toBe(200);

    const m = await scrape(app);
    expect(m.get('slotbook_hold_expiries_total{via="sweeper"}')).toBe(1);
    expect(m.get('slotbook_hold_expiries_total{via="confirm"}')).toBe(1);
    expect(m.get('slotbook_hold_expiries_total{via="hold"}')).toBe(1);
    expect(m.get('slotbook_hold_expiries_total{via="reschedule"}')).toBe(0);
    expect(m.get('slotbook_holds_released_total')).toBe(1);
    await app.close();
  });

  it('notification lag = age of the oldest undelivered notification (database clock); 0 once delivered', async () => {
    const sc = await scenario(db);
    const app = await makeApp(db);
    await book(db, sc);
    await sql`UPDATE notifications SET created_at = clock_timestamp() - interval '90 seconds'`.execute(db);
    let m = await scrape(app);
    expect(m.get('slotbook_notifications_pending')).toBe(1);
    expect(m.get('slotbook_notification_lag_seconds')).toBeGreaterThanOrEqual(90);
    expect(m.get('slotbook_notification_lag_seconds')).toBeLessThan(120);

    await sql`UPDATE notifications SET delivered_at = clock_timestamp()`.execute(db);
    m = await scrape(app);
    expect(m.get('slotbook_notifications_pending')).toBe(0);
    expect(m.get('slotbook_notification_lag_seconds')).toBe(0);
    await app.close();
  });

  it('counts requests refused by each rate limit', async () => {
    const app = await makeApp(db);
    const login = () => app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress: '198.51.100.90', headers: { origin: TEST_ORIGIN }, payload: { email: 'x@example.test', password: 'n' } });
    for (let i = 0; i < RATE_LIMITS.login + 2; i++) await login();
    expect((await scrape(app)).get('slotbook_rate_limited_total{route="login"}')).toBe(2);
    await app.close();
  });
});

describe('/metrics access', () => {
  it('METRICS_TOKEN set: no header or a wrong token → 401; the right bearer token → 200', async () => {
    const app = await makeApp(db, { env: { METRICS_TOKEN: 'metrics-token-0123456789' } });
    expect((await app.inject({ method: 'GET', url: '/metrics' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/metrics', headers: { authorization: 'Bearer wrong-token-0123456789x' } })).statusCode).toBe(401);
    const ok = await app.inject({ method: 'GET', url: '/metrics', headers: { authorization: 'Bearer metrics-token-0123456789' } });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toContain('slotbook_bookings');
    await app.close();
  });

  it('production without METRICS_TOKEN → 404 (the route is effectively off)', async () => {
    const app = await makeApp(db, { env: { NODE_ENV: 'production' } });
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect([res.statusCode, res.json().error.code]).toEqual([404, 'NOT_FOUND']);
    await app.close();
  });
});
