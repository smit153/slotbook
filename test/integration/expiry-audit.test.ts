import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { createHold, type HoldCreated } from '../../src/server/services/holds.js';
import { rescheduleBooking } from '../../src/server/services/reschedule.js';
import { runSweepOnce } from '../../src/server/workers/sweeper.js';
import { testDb, truncateAll } from '../helpers/db.js';
import { assertSeatInvariant } from '../helpers/invariants.js';
import { book } from '../helpers/flows.js';
import { APP_SECRET, holdRequest, scenario, type Scenario } from '../helpers/scenario.js';

/** Every held → expired transition leaves exactly one audit row, whoever performed it. */
const db = testDb();
afterAll(() => db.destroy());
beforeEach(() => truncateAll(db));
afterEach(() => assertSeatInvariant(db));

const at = (sc: Scenario, i: number) => new Date(sc.slot.getTime() + i * 30 * 60_000);
const hold = async (sc: Scenario, i: number) =>
  ((await createHold({ db, appSecret: APP_SECRET }, holdRequest(sc, { startAt: at(sc, i) }))).body as HoldCreated).hold_id;
const expire = (ids: string[]) =>
  sql`UPDATE bookings SET expires_at = clock_timestamp() - interval '1 second' WHERE id = ANY(${ids}::uuid[])`.execute(db);
const expiredEvents = () =>
  db.selectFrom('booking_events').select(['booking_id', 'from_status', 'to_status', 'payload'])
    .where('type', '=', 'expired').orderBy('id').execute();

describe('audit rows for hold expiry', () => {
  it('the sweeper writes one expired event per hold it expires (via: sweeper)', async () => {
    const sc = await scenario(db);
    const ids = [await hold(sc, 0), await hold(sc, 1)];
    await expire(ids);
    expect((await runSweepOnce(db)).expired).toBe(2);

    const events = await expiredEvents();
    expect(events.map((e) => e.booking_id).sort()).toEqual([...ids].sort());
    for (const e of events) expect(e).toMatchObject({ from_status: 'held', to_status: 'expired', payload: { via: 'sweeper' } });

    // A second run finds nothing and writes nothing.
    expect((await runSweepOnce(db)).expired).toBe(0);
    expect(await expiredEvents()).toHaveLength(2);
  });

  it("a new hold's inline sweep writes them too (via: hold)", async () => {
    const sc = await scenario(db);
    const stale = await hold(sc, 0);
    await expire([stale]);
    await hold(sc, 1); // sweeps the host under its lock
    expect(await expiredEvents()).toEqual([expect.objectContaining({ booking_id: stale, payload: { via: 'hold' } })]);
  });

  it("a reschedule's inline sweep writes them too (via: reschedule)", async () => {
    const sc = await scenario(db);
    const b = await book(db, sc);
    const stale = await hold(sc, 4);
    await expire([stale]);
    expect((await rescheduleBooking({ db }, b.token, { start_at: at(sc, 2).toISOString() })).status).toBe(200);
    expect(await expiredEvents()).toEqual([expect.objectContaining({ booking_id: stale, payload: { via: 'reschedule' } })]);
  });
});
