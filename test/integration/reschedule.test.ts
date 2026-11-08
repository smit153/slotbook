import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rescheduleBooking, type Rescheduled } from '../../src/server/services/reschedule.js';
import { cancelByGuest } from '../../src/server/services/cancel.js';
import { seatsTaken, testDb, truncateAll } from '../helpers/db.js';
import { assertSeatInvariant } from '../helpers/invariants.js';
import { book, startedBooking } from '../helpers/flows.js';
import { scenario, type Scenario } from '../helpers/scenario.js';

const db = testDb({ max: 20 });
const deps = { db };
afterAll(() => db.destroy());
beforeEach(() => truncateAll(db));
afterEach(() => assertSeatInvariant(db));

const MIN = 60_000;
const at = (sc: Scenario, minutes: number) => new Date(sc.slot.getTime() + minutes * MIN);
const iso = (d: Date) => d.toISOString();
const rescheduled = () => db.selectFrom('notifications').select('payload').where('type', '=', 'booking.rescheduled').execute();
const seatAt = async (sc: Scenario, d: Date) => {
  const o = await db.selectFrom('occupancies').select('id').where('event_type_id', '=', sc.ev.id).where('start_at', '=', d).executeTakeFirst();
  return o ? seatsTaken(db, o.id) : 0;
};

describe('reschedule', () => {
  it('moves the booking: new times, old seat freed, new seat taken, same token, one notification', async () => {
    const sc = await scenario(db);
    const b = await book(db, sc);
    const res = await rescheduleBooking(deps, b.token, { start_at: iso(at(sc, 60)) });

    expect(res.status).toBe(200);
    expect((res.body as Rescheduled).booking).toMatchObject({ id: b.id, status: 'confirmed', start_at: iso(at(sc, 60)), end_at: iso(at(sc, 90)) });
    expect(await seatAt(sc, sc.slot)).toBe(0);
    expect(await seatAt(sc, at(sc, 60))).toBe(1);
    const ns = await rescheduled();
    expect(ns).toHaveLength(1);
    expect(ns[0]!.payload).toMatchObject({ booking_id: b.id, start_at: iso(at(sc, 60)), previous_start_at: iso(sc.slot) });
    expect(JSON.stringify(ns[0]!.payload)).not.toContain(b.token);
    // The manage link keeps working after a reschedule.
    expect((await cancelByGuest(deps, b.token, {})).status).toBe(200);
  });

  it('R10: target taken → 409, the original booking (time, status, seat) is untouched', async () => {
    const sc = await scenario(db);
    const mine = await book(db, sc);
    await book(db, sc, { startAt: at(sc, 60) }); // someone else has 10:00
    const res = await rescheduleBooking(deps, mine.token, { start_at: iso(at(sc, 60)) });

    expect(res).toMatchObject({ status: 409, body: { error: { code: 'SLOT_UNAVAILABLE' } } });
    const row = await db.selectFrom('bookings').select(['status', 'start_at']).where('id', '=', mine.id).executeTakeFirstOrThrow();
    expect(row).toEqual({ status: 'confirmed', start_at: sc.slot });
    expect(await seatAt(sc, sc.slot)).toBe(1);
    expect(await seatAt(sc, at(sc, 60))).toBe(1);
    expect(await rescheduled()).toEqual([]);
  });

  it('R16: a retried reschedule to the same slot is a pure no-op (200, no event, no 2nd notification)', async () => {
    const sc = await scenario(db);
    const b = await book(db, sc);
    expect((await rescheduleBooking(deps, b.token, { start_at: iso(at(sc, 60)) })).status).toBe(200);
    expect((await rescheduleBooking(deps, b.token, { start_at: iso(at(sc, 60)) })).status).toBe(200);
    expect(await rescheduled()).toHaveLength(1);
    const events = await db.selectFrom('booking_events').select('type').where('booking_id', '=', b.id).where('type', '=', 'rescheduled').execute();
    expect(events).toHaveLength(1);
  });

  it('R24: moving onto a time that overlaps only its OWN old session works (release-then-claim)', async () => {
    const sc = await scenario(db, { duration_min: 30, buffer_after_min: 15 }); // 09:00 blocks until 09:45
    const b = await book(db, sc);
    const res = await rescheduleBooking(deps, b.token, { start_at: iso(at(sc, 30)) }); // 09:30
    expect(res.status).toBe(200);
    expect(await seatAt(sc, sc.slot)).toBe(0);
    expect(await seatAt(sc, at(sc, 30))).toBe(1);
  });

  it('two bookings racing for the same free slot → one 200, one 409', async () => {
    const sc = await scenario(db);
    const a = await book(db, sc);
    const b = await book(db, sc, { startAt: at(sc, 30) });
    const results = await Promise.all([
      rescheduleBooking(deps, a.token, { start_at: iso(at(sc, 120)) }),
      rescheduleBooking(deps, b.token, { start_at: iso(at(sc, 120)) }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
  });

  it('re-validates the target against the rules → 422 (off-grid, outside hours, past)', async () => {
    const sc = await scenario(db);
    const b = await book(db, sc);
    for (const t of [at(sc, 10), at(sc, -60), at(sc, -14 * 24 * 60)]) {
      expect((await rescheduleBooking(deps, b.token, { start_at: iso(t) })).status).toBe(422);
    }
    expect(await seatAt(sc, sc.slot)).toBe(1);
  });

  it('a started booking → 409 BOOKING_STARTED; a cancelled one → 409 INVALID_STATE', async () => {
    const sc = await scenario(db);
    const started = await startedBooking(db, sc);
    expect(await rescheduleBooking(deps, started.token, { start_at: iso(at(sc, 60)) }))
      .toMatchObject({ status: 409, body: { error: { code: 'BOOKING_STARTED' } } });

    const b = await book(db, sc);
    await cancelByGuest(deps, b.token, {});
    expect(await rescheduleBooking(deps, b.token, { start_at: iso(at(sc, 60)) }))
      .toMatchObject({ status: 409, body: { error: { code: 'INVALID_STATE' } } });
  });

  it('a deactivated event type cannot be rescheduled into (cancel still works)', async () => {
    const sc = await scenario(db);
    const b = await book(db, sc);
    await db.updateTable('event_types').set({ active: false }).where('id', '=', sc.ev.id).execute();
    expect((await rescheduleBooking(deps, b.token, { start_at: iso(at(sc, 60)) })).status).toBe(409);
    expect((await cancelByGuest(deps, b.token, {})).status).toBe(200);
  });

  it('bad input → 400; unknown token → 404', async () => {
    const sc = await scenario(db);
    const b = await book(db, sc);
    expect((await rescheduleBooking(deps, b.token, { start_at: 'soon' })).status).toBe(400);
    expect((await rescheduleBooking(deps, 'A'.repeat(43), { start_at: iso(at(sc, 60)) })).status).toBe(404);
  });
});
