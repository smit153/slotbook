import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import type { FastifyInstance } from 'fastify';
import { testDb, truncateAll } from '../../helpers/db.js';
import { assertSeatInvariant } from '../../helpers/invariants.js';
import { book } from '../../helpers/flows.js';
import { loginAs, makeApp, TEST_ORIGIN } from '../../helpers/app.js';
import { scenario, type Scenario } from '../../helpers/scenario.js';

const db = testDb({ max: 10 });
afterAll(() => db.destroy());
beforeEach(() => truncateAll(db));
afterEach(() => assertSeatInvariant(db));

const as = (app: FastifyInstance, cookie: string) => ({
  get: (url: string) => app.inject({ method: 'GET', url, headers: { cookie } }),
  send: (method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
    app.inject({ method, url, headers: { cookie, origin: TEST_ORIGIN }, ...(payload === undefined ? {} : { payload: payload as object }) }),
});

async function setup(o: { lockTimeoutMs?: number } = {}) {
  const sc = await scenario(db);
  const app = await makeApp(db, o);
  const cookie = await loginAs(app, db, sc.hostId);
  return { sc, app, h: as(app, cookie) };
}

describe('settings', () => {
  it('reads and updates name + timezone; Asia/Kolkata and UTC are accepted, nonsense is 422', async () => {
    const { app, h } = await setup();
    const s = await h.get('/api/host/settings');
    expect(s.json()).toMatchObject({ timezone: 'America/New_York' });
    expect(s.json().timezones).toEqual(expect.arrayContaining(['Asia/Kolkata', 'UTC', 'Europe/Berlin']));

    expect((await h.send('PUT', '/api/host/settings', { timezone: 'Asia/Kolkata', name: 'Priya' })).json()).toMatchObject({ timezone: 'Asia/Kolkata', name: 'Priya' });
    expect((await h.send('PUT', '/api/host/settings', { timezone: 'UTC' })).statusCode).toBe(200);
    const bad = await h.send('PUT', '/api/host/settings', { timezone: 'Mars/Olympus' });
    expect([bad.statusCode, bad.json().error.code]).toEqual([422, 'INVALID_TIMEZONE']);
    expect((await h.send('PUT', '/api/host/settings', { email: 'x@y.z' })).statusCode).toBe(400);
    await app.close();
  });
});

describe('event types', () => {
  it('create with defaults → 201; duplicate slug → 409; out-of-range fields → 400', async () => {
    const { app, h } = await setup();
    const created = await h.send('POST', '/api/host/event-types', { name: 'Deep dive', slug: 'deep-dive', duration_min: 90 });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ slug: 'deep-dive', capacity: 1, horizon_days: 30, active: true });

    const dup = await h.send('POST', '/api/host/event-types', { name: 'Again', slug: 'deep-dive', duration_min: 30 });
    expect([dup.statusCode, dup.json().error.code]).toEqual([409, 'SLUG_TAKEN']);
    for (const bad of [{ duration_min: 10 }, { duration_min: 121 }, { buffer_before_min: 31 }, { capacity: 0 }, { slug: 'Bad Slug' }]) {
      expect((await h.send('POST', '/api/host/event-types', { name: 'x', slug: 'ok-slug', duration_min: 30, ...bad })).statusCode).toBe(400);
    }
    expect((await h.get('/api/host/event-types')).json().event_types).toHaveLength(2);
    await app.close();
  });

  it('PATCH active:false deactivates it (public 404, existing bookings intact); there is no DELETE', async () => {
    const { sc, app, h } = await setup();
    const b = await book(db, sc);
    const off = await h.send('PATCH', `/api/host/event-types/${sc.ev.id}`, { active: false });
    expect(off.json()).toMatchObject({ active: false });
    expect((await app.inject({ method: 'GET', url: `/api/hosts/${sc.hostSlug}/events/${sc.ev.slug}` })).statusCode).toBe(404);
    expect((await db.selectFrom('bookings').select('status').where('id', '=', b.id).executeTakeFirstOrThrow()).status).toBe('confirmed');

    expect((await h.send('DELETE', `/api/host/event-types/${sc.ev.id}`)).statusCode).toBe(404);
    expect(await db.selectFrom('event_types').select('id').where('id', '=', sc.ev.id).executeTakeFirst()).toBeDefined();
    await app.close();
  });
});

describe('availability: replace-all, atomic', () => {
  const good = {
    weekly: [{ weekday: 1, start: '09:00', end: '12:00' }, { weekday: 1, start: '13:00', end: '17:00' }, { weekday: 5, start: '20:00', end: '24:00' }],
    overrides: [{ date: '2030-12-24', kind: 'custom', windows: [{ start: '10:00', end: '12:00' }] }, { date: '2030-12-25', kind: 'off' }],
  };

  it('PUT then GET round-trips (incl. 24:00)', async () => {
    const { app, h } = await setup();
    const put = await h.send('PUT', '/api/host/availability', good);
    expect(put.statusCode).toBe(200);
    expect((await h.get('/api/host/availability')).json()).toEqual({
      weekly: good.weekly,
      overrides: [{ date: '2030-12-24', kind: 'custom', windows: [{ start: '10:00', end: '12:00' }] }, { date: '2030-12-25', kind: 'off', windows: [] }],
    });
    await app.close();
  });

  it.each([
    ['overlapping weekly windows', { weekly: [{ weekday: 2, start: '09:00', end: '12:00' }, { weekday: 2, start: '11:00', end: '13:00' }], overrides: [] }, 422, 'OVERLAPPING_WINDOWS'],
    ['end before start', { weekly: [{ weekday: 2, start: '12:00', end: '09:00' }], overrides: [] }, 422, 'INVALID_WINDOW'],
    ['day off with hours', { weekly: [], overrides: [{ date: '2030-12-26', kind: 'off', windows: [{ start: '09:00', end: '10:00' }] }] }, 422, 'INVALID_OVERRIDE'],
    ['custom without hours', { weekly: [], overrides: [{ date: '2030-12-26', kind: 'custom', windows: [] }] }, 422, 'INVALID_OVERRIDE'],
    ['same date twice', { weekly: [], overrides: [{ date: '2030-12-26', kind: 'off' }, { date: '2030-12-26', kind: 'off' }] }, 422, 'DUPLICATE_DATE'],
    ['overlapping override windows', { weekly: [], overrides: [{ date: '2030-12-26', kind: 'custom', windows: [{ start: '09:00', end: '11:00' }, { start: '10:00', end: '12:00' }] }] }, 422, 'OVERLAPPING_WINDOWS'],
    ['bad weekday', { weekly: [{ weekday: 0, start: '09:00', end: '10:00' }], overrides: [] }, 400, 'VALIDATION'],
  ])('%s → %d %s, and the previous availability is untouched', async (_label, body, status, code) => {
    const { app, h } = await setup();
    await h.send('PUT', '/api/host/availability', good);
    const r = await h.send('PUT', '/api/host/availability', body);
    expect([r.statusCode, r.json().error.code]).toEqual([status, code]);
    expect((await h.get('/api/host/availability')).json().weekly).toEqual(good.weekly);
    await app.close();
  });
});

describe('host edits take the host lock (agreed after Phase 4)', () => {
  it('an edit waits behind a held host lock → 503 HOST_BUSY after lock_timeout, then succeeds once free', async () => {
    const { sc, app, h } = await setup({ lockTimeoutMs: 200 });
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
    const blocked = await Promise.all([
      h.send('PATCH', `/api/host/event-types/${sc.ev.id}`, { capacity: 3 }),
      h.send('PUT', '/api/host/availability', { weekly: [], overrides: [] }),
      h.send('PUT', '/api/host/settings', { name: 'x' }),
      h.send('POST', '/api/host/event-types', { name: 'n', slug: 'n', duration_min: 30 }),
    ]);
    release();
    await blocker;
    for (const r of blocked) expect([r.statusCode, r.headers['retry-after']]).toEqual([503, '1']);
    expect((await h.send('PATCH', `/api/host/event-types/${sc.ev.id}`, { capacity: 3 })).statusCode).toBe(200);
    await app.close();
  });
});

describe('host bookings, cancel and notifications', () => {
  it('upcoming list shows confirmed future bookings only; host cancel needs a reason; notifications are listed', async () => {
    const { sc, app, h } = await setup();
    const keep = await book(db, sc);
    const gone = await book(db, sc, { startAt: new Date(sc.slot.getTime() + 60 * 60_000) });

    const noReason = await h.send('POST', `/api/host/bookings/${gone.id}/cancel`, {});
    expect(noReason.statusCode).toBe(400);
    expect((await h.send('POST', `/api/host/bookings/${gone.id}/cancel`, { reason: 'Double-booked myself' })).statusCode).toBe(200);

    const upcoming = (await h.get('/api/host/bookings?upcoming=1')).json().bookings as Array<{ id: string }>;
    expect(upcoming.map((b) => b.id)).toEqual([keep.id]);
    const all = (await h.get('/api/host/bookings')).json().bookings as Array<{ id: string; status: string }>;
    expect(all.map((b) => b.status).sort()).toEqual(['cancelled', 'confirmed']);

    const types = ((await h.get('/api/host/notifications')).json().notifications as Array<{ type: string }>).map((n) => n.type);
    expect(types.sort()).toEqual(['booking.cancelled', 'booking.confirmed', 'booking.confirmed']);
    await app.close();
  });
});

describe('isolation between hosts', () => {
  it("host B cannot see, edit or cancel host A's things (404 / empty lists)", async () => {
    const a: Scenario = await scenario(db);
    const bSc = await scenario(db, { slug: 'b-ev' });
    const booking = await book(db, a);
    const app = await makeApp(db);
    const asB = as(app, await loginAs(app, db, bSc.hostId));

    expect((await asB.get('/api/host/bookings')).json().bookings).toEqual([]);
    expect((await asB.get('/api/host/notifications')).json().notifications).toEqual([]);
    expect((await asB.send('POST', `/api/host/bookings/${booking.id}/cancel`, { reason: 'mine now' })).statusCode).toBe(404);
    expect((await asB.send('PATCH', `/api/host/event-types/${a.ev.id}`, { active: false })).statusCode).toBe(404);
    expect((await asB.get('/api/host/event-types')).json().event_types.map((e: { id: string }) => e.id)).toEqual([bSc.ev.id]);
    expect((await db.selectFrom('bookings').select('status').where('id', '=', booking.id).executeTakeFirstOrThrow()).status).toBe('confirmed');
    await app.close();
  });
});
