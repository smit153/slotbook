import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { createHold, type HoldCreated } from '../../src/server/services/holds.js';
import { runSweepOnce, startSweeper } from '../../src/server/workers/sweeper.js';
import { testDb, truncateAll } from '../helpers/db.js';
import { assertSeatInvariant } from '../helpers/invariants.js';
import { book } from '../helpers/flows.js';
import { APP_SECRET, holdRequest, scenario, type Scenario } from '../helpers/scenario.js';

const db = testDb({ max: 10 });
afterAll(() => db.destroy());
beforeEach(() => truncateAll(db));
afterEach(() => assertSeatInvariant(db));

const at = (sc: Scenario, i: number) => new Date(sc.slot.getTime() + i * 30 * 60_000);
const hold = async (sc: Scenario, i: number) =>
  ((await createHold({ db, appSecret: APP_SECRET }, holdRequest(sc, { startAt: at(sc, i) }))).body as HoldCreated).hold_id;
const expire = (ids: string[]) =>
  sql`UPDATE bookings SET expires_at = clock_timestamp() - interval '1 second' WHERE id = ANY(${ids}::uuid[])`.execute(db);
const statuses = async () =>
  Object.fromEntries((await db.selectFrom('bookings').select(['id', 'status']).execute()).map((r) => [r.id, r.status]));

describe('hold sweeper', () => {
  it('expires stale holds on every host; leaves live holds and confirmed bookings alone', async () => {
    const a = await scenario(db);
    const b = await scenario(db, { slug: 'b' });
    const staleA = await hold(a, 0);
    const staleB = await hold(b, 0);
    const live = await hold(a, 1);
    const confirmed = await book(db, a, { startAt: at(a, 2) });
    await expire([staleA, staleB]);

    expect(await runSweepOnce(db)).toMatchObject({ expired: 2, hostsSwept: 2, hostsSkipped: 0 });
    expect(await statuses()).toMatchObject({ [staleA]: 'expired', [staleB]: 'expired', [live]: 'held', [confirmed.id]: 'confirmed' });
    // Seats were released by the trigger (assertSeatInvariant checks counts after the test).
  });

  it('skips a host whose lock is busy (SKIP LOCKED) and sweeps it on a later run', async () => {
    const a = await scenario(db);
    const b = await scenario(db, { slug: 'b' });
    const ha = await hold(a, 0);
    const hb = await hold(b, 0);
    await expire([ha, hb]);

    let release!: () => void;
    const released = new Promise<void>((r) => { release = r; });
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => { locked = r; });
    const busy = db.transaction().execute(async (trx) => {
      await sql`SELECT id FROM hosts WHERE id = ${a.hostId} FOR UPDATE`.execute(trx);
      locked();
      await released;
    });
    await isLocked;

    const started = Date.now();
    const first = await runSweepOnce(db);
    expect(Date.now() - started).toBeLessThan(1_000); // never waited on the busy host
    expect(first).toMatchObject({ expired: 1, hostsSwept: 1, hostsSkipped: 1 });
    expect((await statuses())[ha]).toBe('held');

    release();
    await busy;
    expect(await runSweepOnce(db)).toMatchObject({ expired: 1, hostsSwept: 1 });
    expect((await statuses())[ha]).toBe('expired');
  });

  it('two sweepers at once (two app instances) expire every hold exactly once, without errors', async () => {
    const hosts = await Promise.all(Array.from({ length: 6 }, (_, i) => scenario(db, { slug: `s${i}` })));
    const ids = [];
    for (const sc of hosts) ids.push(await hold(sc, 0), await hold(sc, 1));
    await expire(ids);

    const [r1, r2] = await Promise.all([runSweepOnce(db), runSweepOnce(db)]);
    expect(r1.expired + r2.expired).toBe(12);
    expect(Object.values(await statuses()).every((s) => s === 'expired')).toBe(true);
    const sessions = await db.selectFrom('occupancies').select('seats_taken').execute();
    expect(sessions.every((o) => o.seats_taken === 0)).toBe(true);
  });

  it('purges idempotency keys older than 24 h only', async () => {
    const sc = await scenario(db);
    await hold(sc, 0);
    await hold(sc, 1);
    await sql`UPDATE idempotency_keys SET created_at = clock_timestamp() - interval '25 hours'
               WHERE key = (SELECT key FROM idempotency_keys ORDER BY created_at LIMIT 1)`.execute(db);
    expect((await runSweepOnce(db)).keysPurged).toBe(1);
    expect(await db.selectFrom('idempotency_keys').selectAll().execute()).toHaveLength(1);
  });

  it('startSweeper runs on its interval and stops cleanly', async () => {
    const sc = await scenario(db);
    const id = await hold(sc, 0);
    await expire([id]);
    const results: number[] = [];
    const handle = startSweeper(db, { intervalMs: 50, onResult: (r) => results.push(r.expired) });
    while (!results.includes(1)) await new Promise((r) => setTimeout(r, 20));
    await handle.stop();
    expect((await statuses())[id]).toBe('expired');
  });
});
