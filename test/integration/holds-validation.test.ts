import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { createHold, type HoldCreated } from '../../src/server/services/holds.js';
import { seatsTaken, testDb, truncateAll } from '../helpers/db.js';
import { assertSeatInvariant } from '../helpers/invariants.js';
import { APP_SECRET, addEventType, dbNow, freshIp, holdRequest, scenario } from '../helpers/scenario.js';

const db = testDb({ max: 40 });
/**
 * Contention tests isolate CORRECTNESS from the fail-fast timeout: with dozens of requests
 * queued on one host lock, the default 2.5 s lock_timeout legitimately turns the tail into
 * 503 HOST_BUSY under a slow/loaded machine (found in Phase 6). The timeout behaviour itself
 * is asserted separately (holds-lock-timeout, and the burst test in holds-concurrency).
 */
const CONTENTION_LOCK_TIMEOUT_MS = 30_000;
const deps = { db, appSecret: APP_SECRET, lockTimeoutMs: CONTENTION_LOCK_TIMEOUT_MS };
afterAll(() => db.destroy());
beforeEach(() => truncateAll(db));
afterEach(() => assertSeatInvariant(db));

const MIN = 60_000;
const code = (r: { body: unknown }) => (r.body as { error?: { code: string } }).error?.code;

describe('R8: a tampered start_at is re-validated on the server', () => {
  it.each([
    ['off-grid (09:10)', 10 * MIN],
    ['before the window (08:30)', -30 * MIN],
    ['meeting would run past 17:00 (16:45)', 7 * 60 * MIN + 45 * MIN],
    ['on a Saturday', 5 * 24 * 60 * MIN],
  ])('%s → 422 SLOT_NOT_OFFERED', async (_label, offset) => {
    const sc = await scenario(db);
    const r = await createHold(deps, holdRequest(sc, { startAt: new Date(sc.slot.getTime() + offset) }));
    expect(r.status).toBe(422);
    expect(code(r)).toBe('SLOT_NOT_OFFERED');
  });

  it('inside min notice, past the horizon and in the past → 422', async () => {
    const sc = await scenario(db, { min_notice_min: 14 * 24 * 60, horizon_days: 30 }); // 2-week notice
    expect((await createHold(deps, holdRequest(sc))).status).toBe(422); // next Monday is within 2 weeks

    const far = await scenario(db, { slug: 'far', horizon_days: 3 });
    expect((await createHold(deps, holdRequest(far))).status).toBe(422); // next Monday is > 3 days out

    const past = await scenario(db, { slug: 'past' });
    const lastWeek = new Date(past.slot.getTime() - 14 * 24 * 60 * MIN);
    expect((await createHold(deps, holdRequest(past, { startAt: lastWeek }))).status).toBe(422);
  });

  it('a malformed start_at → 400 before anything else happens', async () => {
    const sc = await scenario(db);
    for (const bad of ['2026-11-02 09:00', 'next monday', '2026-11-02T09:00:00']) {
      expect(code(await createHold(deps, { ...holdRequest(sc), start_at: bad }))).toBe('VALIDATION');
    }
  });

  it('a taken slot is 409 (decided by the DB), never 422', async () => {
    const sc = await scenario(db);
    expect((await createHold(deps, holdRequest(sc))).status).toBe(201);
    expect(code(await createHold(deps, holdRequest(sc)))).toBe('SLOT_UNAVAILABLE');
  });
});

describe('deactivated host / event type → 404', () => {
  it('when already deactivated', async () => {
    const sc = await scenario(db);
    await db.updateTable('event_types').set({ active: false }).where('id', '=', sc.ev.id).execute();
    expect((await createHold(deps, holdRequest(sc))).status).toBe(404);

    const sc2 = await scenario(db, { slug: 'two' });
    await db.updateTable('hosts').set({ active: false }).where('id', '=', sc2.hostId).execute();
    expect((await createHold(deps, holdRequest(sc2))).status).toBe(404);
  });

  it('when deactivated while the hold waits for the host lock (re-checked under the lock)', async () => {
    const sc = await scenario(db);
    let release!: () => void;
    const released = new Promise<void>((r) => { release = r; });
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => { locked = r; });
    const editor = db.transaction().execute(async (trx) => {
      await sql`SELECT id FROM hosts WHERE id = ${sc.hostId} FOR UPDATE`.execute(trx);
      locked();
      await released;
      await trx.updateTable('event_types').set({ active: false }).where('id', '=', sc.ev.id).execute();
    });
    await isLocked;
    const pending = createHold(deps, holdRequest(sc)); // resolves the ACTIVE event type, then blocks
    await new Promise((r) => setTimeout(r, 150));
    release();
    await editor;
    expect((await pending).status).toBe(404);
    expect(await db.selectFrom('idempotency_keys').selectAll().execute()).toEqual([]); // not stored
  });
});

describe('sessions through the service', () => {
  it('R23: hold → expire → host raises capacity 1 → 3 → three holds fit the refreshed session', async () => {
    const sc = await scenario(db, { capacity: 1 });
    const first = (await createHold(deps, holdRequest(sc))).body as HoldCreated;
    await sql`UPDATE bookings SET expires_at = clock_timestamp() - interval '1 second' WHERE id = ${first.hold_id}`.execute(db);
    await db.updateTable('event_types').set({ capacity: 3 }).where('id', '=', sc.ev.id).execute();

    const results = await Promise.all([1, 2, 3, 4].map(() => createHold(deps, holdRequest(sc))));
    expect(results.map((r) => r.status).sort()).toEqual([201, 201, 201, 409]);
    const occ = await db.selectFrom('occupancies').selectAll().where('event_type_id', '=', sc.ev.id).executeTakeFirstOrThrow();
    expect(occ).toMatchObject({ capacity: 3, seats_taken: 3 });
  });

  it('joining a live group session copies the session snapshot, even after the event type changed', async () => {
    const sc = await scenario(db, { capacity: 3, duration_min: 60 });
    const a = (await createHold(deps, holdRequest(sc))).body as HoldCreated;
    await db.updateTable('event_types').set({ duration_min: 30, capacity: 5 }).where('id', '=', sc.ev.id).execute();
    const b = (await createHold(deps, holdRequest(sc))).body as HoldCreated;
    expect(b.end_at).toBe(a.end_at); // still the 60-min session
    const occ = await db.selectFrom('occupancies').select(['id', 'capacity']).where('event_type_id', '=', sc.ev.id).executeTakeFirstOrThrow();
    expect(occ.capacity).toBe(3);
    expect(await seatsTaken(db, occ.id)).toBe(2);
  });

  it('expires_at = server_now + 5 min, and server_now is the database clock', async () => {
    const sc = await scenario(db);
    const before = await dbNow(db);
    const h = (await createHold(deps, holdRequest(sc))).body as HoldCreated;
    const after = await dbNow(db);
    expect(new Date(h.expires_at).getTime() - new Date(h.server_now).getTime()).toBe(5 * MIN);
    expect(new Date(h.server_now).getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(new Date(h.server_now).getTime()).toBeLessThanOrEqual(after.getTime());
  });
});

describe('mixed run', () => {
  it('200 holds over 2 event types and random slots in 4 waves: no overlap, invariant holds', async () => {
    const sc = await scenario(db, { slug: 'thirty', capacity: 1, duration_min: 30, buffer_after_min: 15 });
    await addEventType(db, sc.hostId, { slug: 'group', capacity: 4, duration_min: 60, buffer_before_min: 15 });
    const day = (d: number) => new Date(sc.slot.getTime() + d * 24 * 60 * MIN);
    const pick = <T,>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)]!;

    let ok = 0;
    for (let wave = 0; wave < 4; wave++) {
      const results = await Promise.all(Array.from({ length: 50 }, () => {
        const slug = pick(['thirty', 'group']);
        const step = slug === 'thirty' ? 30 : 60;
        const slot = new Date(day(pick([0, 1, 2])).getTime() + pick([0, 1, 2, 3, 4, 5]) * step * MIN);
        return createHold(deps, holdRequest(sc, { slug, startAt: slot, ip: freshIp() }));
      }));
      for (const r of results) expect([201, 409]).toContain(r.status);
      ok += results.filter((r) => r.status === 201).length;
    }
    expect(ok).toBeGreaterThan(0);
    // assertSeatInvariant (afterEach) checks seats vs bookings, no overlapping live sessions,
    // and booking times = session times.
  });
});
