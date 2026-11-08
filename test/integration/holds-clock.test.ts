import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { createHold } from '../../src/server/services/holds.js';
import { createBooking, createOccupancy, testDb, truncateAll } from '../helpers/db.js';
import { assertSeatInvariant } from '../helpers/invariants.js';
import { APP_SECRET, dbNow, holdRequest, scenario } from '../helpers/scenario.js';

/**
 * Design §5.5 — write paths read the clock AFTER their locks. now() is the transaction start;
 * a transaction that waited for the host lock would otherwise sweep with a stale clock and
 * refuse a slot whose old hold expired during the wait.
 */
const db = testDb({ max: 10 });
const deps = { db, appSecret: APP_SECRET };
afterAll(() => db.destroy());
beforeEach(() => truncateAll(db));
afterEach(() => assertSeatInvariant(db));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll pg_stat_activity until some backend waits on a lock (the new hold is blocked). */
async function waitUntilSomeoneWaitsOnALock(): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const { rows } = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM pg_stat_activity
       WHERE datname = current_database() AND wait_event_type = 'Lock'`.execute(db);
    if (rows[0]!.n > 0) return;
    await sleep(10);
  }
  throw new Error('nobody blocked on the host lock');
}

describe('holds read the clock after taking the host lock', () => {
  it('an old hold that expires WHILE a new hold waits for the host lock does not cause a wrong 409', async () => {
    const sc = await scenario(db, { capacity: 1 });

    // Old hold on the slot, expiring ~1.2 s from now.
    const occ = await createOccupancy(db, sc.ev, sc.slot.toISOString());
    const old = await createBooking(db, occ, sc.ev, 'held');
    await sql`UPDATE bookings SET expires_at = clock_timestamp() + interval '1200 milliseconds' WHERE id = ${old}`.execute(db);
    const { expires_at: oldExpiry } = await db.selectFrom('bookings').select('expires_at').where('id', '=', old).executeTakeFirstOrThrow();

    // Someone else holds the host lock (e.g. a slow booking for another slot).
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

    // The new hold starts its transaction NOW (before the old hold expires) and blocks.
    const pending = createHold(deps, holdRequest(sc));
    await waitUntilSomeoneWaitsOnALock();
    expect((await dbNow(db)).getTime()).toBeLessThan(oldExpiry!.getTime()); // still valid when the wait began

    // Let the old hold expire during the wait, then release the lock.
    while ((await dbNow(db)).getTime() <= oldExpiry!.getTime() + 50) await sleep(50);
    release();
    await blocker;

    const res = await pending;
    expect(res.status).toBe(201);
    const statuses = await db.selectFrom('bookings').select(['id', 'status']).orderBy('created_at').execute();
    expect(statuses).toEqual([
      { id: old, status: 'expired' },
      { id: (res.body as { hold_id: string }).hold_id, status: 'held' },
    ]);
  });

  it("the new hold's expires_at is 5 minutes after it got the lock, not after its transaction began", async () => {
    const sc = await scenario(db, { capacity: 1 });
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

    const pending = createHold(deps, holdRequest(sc));
    await waitUntilSomeoneWaitsOnALock();
    await sleep(700);
    const releasedAt = await dbNow(db);
    release();
    await blocker;

    const body = (await pending).body as { expires_at: string; server_now: string };
    expect(new Date(body.server_now).getTime()).toBeGreaterThanOrEqual(releasedAt.getTime());
    expect(new Date(body.expires_at).getTime() - new Date(body.server_now).getTime()).toBe(5 * 60_000);
  });
});
