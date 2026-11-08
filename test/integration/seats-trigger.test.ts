import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import {
  createBooking, createEventType, createHost, createOccupancy, pgError, seatsTaken, testDb, truncateAll,
} from '../helpers/db.js';
import { assertSeatInvariant } from '../helpers/invariants.js';

/** R11: the trigger is the only writer of seats_taken, and it never drifts. */
const db = testDb();
afterAll(() => db.destroy());
beforeEach(() => truncateAll(db));
afterEach(() => assertSeatInvariant(db));

async function setup(o: { capacity?: number } = {}) {
  const host = await createHost(db);
  const ev = await createEventType(db, host, { capacity: o.capacity ?? 3 });
  const occ = await createOccupancy(db, ev, '2030-01-07T15:00:00Z');
  return { host, ev, occ };
}

const setStatus = (id: string, status: 'held' | 'confirmed' | 'cancelled' | 'expired') =>
  sql`UPDATE bookings SET status = ${status}::booking_status,
        cancelled_at = CASE WHEN ${status} = 'cancelled' THEN now() ELSE cancelled_at END,
        cancelled_by = CASE WHEN ${status} = 'cancelled' THEN 'guest' ELSE cancelled_by END
      WHERE id = ${id}`.execute(db);

describe('seats_taken trigger (R11)', () => {
  it('insert held → +1; held → confirmed → unchanged', async () => {
    const { ev, occ } = await setup();
    const id = await createBooking(db, occ, ev, 'held');
    expect(await seatsTaken(db, occ.id)).toBe(1);

    await db.updateTable('bookings').set({
      status: 'confirmed', guest_name: 'G', guest_email: 'g@example.test',
      manage_token_hash: Buffer.alloc(32, 1), confirmed_at: new Date(),
    }).where('id', '=', id).execute();
    expect(await seatsTaken(db, occ.id)).toBe(1);
  });

  it('confirmed → cancelled → −1', async () => {
    const { ev, occ } = await setup();
    const id = await createBooking(db, occ, ev, 'confirmed');
    await setStatus(id, 'cancelled');
    expect(await seatsTaken(db, occ.id)).toBe(0);
  });

  it('held → expired → −1', async () => {
    const { ev, occ } = await setup();
    const id = await createBooking(db, occ, ev, 'held');
    await setStatus(id, 'expired');
    expect(await seatsTaken(db, occ.id)).toBe(0);
  });

  it('inserting an inactive booking (cancelled/expired) takes no seat', async () => {
    const { ev, occ } = await setup();
    await createBooking(db, occ, ev, 'cancelled');
    await createBooking(db, occ, ev, 'expired');
    expect(await seatsTaken(db, occ.id)).toBe(0);
  });

  it('updating unrelated columns never touches the counter', async () => {
    const { ev, occ } = await setup();
    const id = await createBooking(db, occ, ev, 'held');
    await db.updateTable('bookings').set({ guest_tz: 'Europe/Berlin' }).where('id', '=', id).execute();
    await db.updateTable('bookings').set({ status: 'held' }).where('id', '=', id).execute(); // same status
    expect(await seatsTaken(db, occ.id)).toBe(1);
  });

  it('moving an active booking to another session: −1 old, +1 new (reschedule)', async () => {
    const { ev, occ } = await setup();
    const other = await createOccupancy(db, ev, '2030-01-08T15:00:00Z');
    const id = await createBooking(db, occ, ev, 'confirmed');

    await db.updateTable('bookings')
      .set({ occupancy_id: other.id, start_at: other.start_at, end_at: other.end_at })
      .where('id', '=', id).execute();
    expect(await seatsTaken(db, occ.id)).toBe(0);
    expect(await seatsTaken(db, other.id)).toBe(1);
  });

  it('R24 groundwork: moving onto a session that overlaps only its OWN old session succeeds', async () => {
    const { ev, occ } = await setup({ capacity: 1 });
    const shifted = await createOccupancy(db, ev, '2030-01-07T15:15:00Z'); // overlaps 15:00–15:30
    const id = await createBooking(db, occ, ev, 'confirmed');

    // Release-then-claim inside one statement: the old seat is gone before the new one counts.
    await db.updateTable('bookings')
      .set({ occupancy_id: shifted.id, start_at: shifted.start_at, end_at: shifted.end_at })
      .where('id', '=', id).execute();
    expect(await seatsTaken(db, occ.id)).toBe(0);
    expect(await seatsTaken(db, shifted.id)).toBe(1);
  });

  it('moving onto a session that overlaps SOMEONE ELSE is refused, and nothing changes', async () => {
    const { ev, occ } = await setup({ capacity: 1 });
    await createBooking(db, occ, ev, 'confirmed'); // someone else has Jan 7 15:00–15:30
    const mine = await createOccupancy(db, ev, '2030-01-09T15:00:00Z');
    const id = await createBooking(db, mine, ev, 'confirmed');
    const target = await createOccupancy(db, ev, '2030-01-07T15:15:00Z'); // overlaps theirs

    const err = await pgError(() =>
      db.updateTable('bookings')
        .set({ occupancy_id: target.id, start_at: target.start_at, end_at: target.end_at })
        .where('id', '=', id).execute(),
    );
    expect(err.constraint).toBe('occupancies_no_overlap');
    expect(await seatsTaken(db, mine.id)).toBe(1); // statement rolled back: old seat kept
    expect(await seatsTaken(db, target.id)).toBe(0);
  });

  it('moving an inactive booking does not touch either counter', async () => {
    const { ev, occ } = await setup();
    const other = await createOccupancy(db, ev, '2030-01-08T15:00:00Z');
    const id = await createBooking(db, occ, ev, 'cancelled');
    await db.updateTable('bookings').set({ occupancy_id: other.id }).where('id', '=', id).execute();
    expect(await seatsTaken(db, occ.id)).toBe(0);
    expect(await seatsTaken(db, other.id)).toBe(0);
  });

  it('a failed multi-row statement leaves the counter exactly as before', async () => {
    const { ev, occ } = await setup({ capacity: 2 });
    await createBooking(db, occ, ev);
    // Two more seats in ONE statement: the second breaks capacity, so the whole statement rolls back.
    const err = await pgError(() =>
      sql`INSERT INTO bookings (host_id, event_type_id, occupancy_id, status, start_at, end_at, expires_at)
          SELECT ${ev.host_id}::uuid, ${ev.id}::uuid, ${occ.id}::uuid, 'held', ${occ.start_at}::timestamptz, ${occ.end_at}::timestamptz, now() + interval '5 min'
            FROM generate_series(1, 2)`.execute(db),
    );
    expect(err.constraint).toBe('occupancies_seats_within_capacity');
    expect(await seatsTaken(db, occ.id)).toBe(1);
  });
});

describe('bookings are append-only (DELETE blocked)', () => {
  it('DELETE is refused with restrict_violation; row and seat count are untouched', async () => {
    const { ev, occ } = await setup();
    const id = await createBooking(db, occ, ev, 'confirmed');

    const err = await pgError(() => db.deleteFrom('bookings').where('id', '=', id).execute());
    expect(err.code).toBe('23001');
    expect(err.message).toMatch(/append-only/);
    expect(await db.selectFrom('bookings').select('id').where('id', '=', id).executeTakeFirst()).toBeDefined();
    expect(await seatsTaken(db, occ.id)).toBe(1);
  });

  it('also refuses deleting inactive (cancelled/expired) bookings — history is kept', async () => {
    const { ev, occ } = await setup();
    const id = await createBooking(db, occ, ev, 'expired');
    expect((await pgError(() => db.deleteFrom('bookings').where('id', '=', id).execute())).code).toBe('23001');
  });
});

describe('the invariant check itself is not vacuous', () => {
  it('detects a seats_taken value written behind the trigger’s back', async () => {
    const { ev, occ } = await setup();
    await createBooking(db, occ, ev, 'held');
    await db.updateTable('occupancies').set({ seats_taken: 2 }).where('id', '=', occ.id).execute();
    await expect(assertSeatInvariant(db)).rejects.toThrow(/stored invariant/);
    await db.updateTable('occupancies').set({ seats_taken: 1 }).where('id', '=', occ.id).execute(); // restore for afterEach
  });

  it('its sweep releases an expired-but-unswept hold before the live check', async () => {
    const { ev, occ } = await setup();
    const id = await createBooking(db, occ, ev, 'held');
    await db.updateTable('bookings').set({ expires_at: new Date('2000-01-01T00:00:00Z') }).where('id', '=', id).execute();
    await assertSeatInvariant(db); // sweeps it → expired → seat released, both checks pass
    expect(await seatsTaken(db, occ.id)).toBe(0);
  });

  it('detects an active booking whose times differ from its session', async () => {
    const { ev, occ } = await setup();
    const id = await createBooking(db, occ, ev, 'held');
    await db.updateTable('bookings').set({ end_at: new Date('2030-01-07T15:45:00Z') }).where('id', '=', id).execute();
    await expect(assertSeatInvariant(db)).rejects.toThrow(/differ from its occupancy/);
    await db.updateTable('bookings').set({ end_at: occ.end_at }).where('id', '=', id).execute();
  });
});
