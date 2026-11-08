import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { upsertOccupancy } from '../../src/server/db/occupancies.js';
import {
  createBooking, createEventType, createHost, createOccupancy, pgError, seatsTaken, testDb, truncateAll,
} from '../helpers/db.js';
import { assertSeatInvariant } from '../helpers/invariants.js';

/**
 * R4 groundwork: with NO application code and NO host lock, the database alone refuses
 * double bookings. (The parallel version of R1–R4 comes in Phase 4.)
 */
const db = testDb();
afterAll(() => db.destroy());
beforeEach(() => truncateAll(db));
afterEach(() => assertSeatInvariant(db));

const T = '2030-01-07T15:00:00Z'; // a Monday, far from "now"

describe('occupancies: overlap + capacity enforced by Postgres (R4 groundwork)', () => {
  it('1:1 event: a second seat on the same session is refused by the capacity CHECK', async () => {
    const host = await createHost(db);
    const ev = await createEventType(db, host, { capacity: 1 });
    const occ = await createOccupancy(db, ev, T);
    await createBooking(db, occ, ev);

    const err = await pgError(() => createBooking(db, occ, ev));
    expect(err.code).toBe('23514');
    expect(err.constraint).toBe('occupancies_seats_within_capacity');
    expect(await seatsTaken(db, occ.id)).toBe(1);
  });

  it('1:1 event: an overlapping session (different start) is refused by the exclusion constraint', async () => {
    const host = await createHost(db);
    const ev = await createEventType(db, host, { duration_min: 30 });
    const a = await createOccupancy(db, ev, '2030-01-07T15:00:00Z');
    const b = await createOccupancy(db, ev, '2030-01-07T15:15:00Z'); // 0 seats: allowed to exist
    await createBooking(db, a, ev);

    const err = await pgError(() => createBooking(db, b, ev));
    expect(err.code).toBe('23P01');
    expect(err.constraint).toBe('occupancies_no_overlap');
    expect(await seatsTaken(db, b.id)).toBe(0); // the failed statement left no trace
  });

  it('group event (cap 3): exactly 3 seats, the 4th is refused', async () => {
    const host = await createHost(db);
    const ev = await createEventType(db, host, { capacity: 3, duration_min: 60 });
    const occ = await createOccupancy(db, ev, T);
    for (let i = 0; i < 3; i++) await createBooking(db, occ, ev, i === 0 ? 'confirmed' : 'held');

    const err = await pgError(() => createBooking(db, occ, ev));
    expect(err.constraint).toBe('occupancies_seats_within_capacity');
    expect(await seatsTaken(db, occ.id)).toBe(3);
  });

  it('different event types of one host cannot overlap — buffers included', async () => {
    const host = await createHost(db);
    const a = await createEventType(db, host, { duration_min: 30, buffer_after_min: 15 }); // 15:00–15:30, blocks to 15:45
    const b = await createEventType(db, host, { duration_min: 30 });
    const occA = await createOccupancy(db, a, '2030-01-07T15:00:00Z');
    await createBooking(db, occA, a);

    const inBuffer = await createOccupancy(db, b, '2030-01-07T15:40:00Z');
    expect((await pgError(() => createBooking(db, inBuffer, b))).constraint).toBe('occupancies_no_overlap');

    // Ranges are half-open [start, end): starting exactly when the buffer ends is fine.
    const touching = await createOccupancy(db, b, '2030-01-07T15:45:00Z');
    await createBooking(db, touching, b);
    expect(await seatsTaken(db, touching.id)).toBe(1);
  });

  it('different hosts never conflict', async () => {
    const ev1 = await createEventType(db, await createHost(db));
    const ev2 = await createEventType(db, await createHost(db));
    await createBooking(db, await createOccupancy(db, ev1, T), ev1);
    await createBooking(db, await createOccupancy(db, ev2, T), ev2);
  });

  it('a session whose seats all expired/cancelled no longer blocks anything', async () => {
    const host = await createHost(db);
    const ev = await createEventType(db, host);
    const a = await createOccupancy(db, ev, '2030-01-07T15:00:00Z');
    const held = await createBooking(db, a, ev);
    await db.updateTable('bookings').set({ status: 'expired' }).where('id', '=', held).execute();

    const b = await createOccupancy(db, ev, '2030-01-07T15:15:00Z');
    await createBooking(db, b, ev);
    expect(await seatsTaken(db, a.id)).toBe(0);
    expect(await seatsTaken(db, b.id)).toBe(1);
  });

  it('blocked range must cover the meeting (occupancies_blocked_covers)', async () => {
    const host = await createHost(db);
    const ev = await createEventType(db, host);
    const err = await pgError(() =>
      db.insertInto('occupancies').values({
        host_id: host, event_type_id: ev.id,
        start_at: new Date(T), end_at: new Date('2030-01-07T15:30:00Z'),
        blocked: sql<string>`tstzrange('2030-01-07T15:10:00Z', '2030-01-07T15:30:00Z')`,
        capacity: 1,
      }).execute(),
    );
    expect(err.constraint).toBe('occupancies_blocked_covers');
  });
});

describe('upsertOccupancy: refresh-on-zero (R23 groundwork)', () => {
  const spec = (ev: { id: string; host_id: string }, o: { capacity: number; durationMin?: number; bufferAfter?: number }) => ({
    hostId: ev.host_id,
    eventTypeId: ev.id,
    startAt: new Date(T),
    endAt: new Date(new Date(T).getTime() + (o.durationMin ?? 30) * 60_000),
    bufferBeforeMin: 0,
    bufferAfterMin: o.bufferAfter ?? 0,
    capacity: o.capacity,
  });

  it('a 0-seat session is refreshed with the current capacity, end and buffers', async () => {
    const host = await createHost(db);
    const ev = await createEventType(db, host, { capacity: 1 });

    const first = await upsertOccupancy(db, spec(ev, { capacity: 1 }));
    const b = await createBooking(db, { id: first.id, start_at: first.startAt, end_at: first.endAt }, ev);
    await db.updateTable('bookings').set({ status: 'expired' }).where('id', '=', b).execute();

    // Host edits the event type: capacity 1 → 3, duration 30 → 45, buffer after 10.
    const again = await upsertOccupancy(db, spec(ev, { capacity: 3, durationMin: 45, bufferAfter: 10 }));
    expect(again.id).toBe(first.id);
    expect(again.capacity).toBe(3);
    expect(again.endAt.toISOString()).toBe('2030-01-07T15:45:00.000Z');
    const { rows } = await sql<{ upper: Date }>`SELECT upper(blocked) FROM occupancies WHERE id = ${first.id}`.execute(db);
    expect(rows[0]!.upper.toISOString()).toBe('2030-01-07T15:55:00.000Z');

    const occ = { id: again.id, start_at: again.startAt, end_at: again.endAt };
    for (let i = 0; i < 3; i++) await createBooking(db, occ, ev);
    expect(await seatsTaken(db, again.id)).toBe(3);
  });

  it('a live session (≥1 seat) keeps its snapshot even after the event type changes', async () => {
    const host = await createHost(db);
    const ev = await createEventType(db, host, { capacity: 1 });
    const first = await upsertOccupancy(db, spec(ev, { capacity: 1 }));
    await createBooking(db, { id: first.id, start_at: first.startAt, end_at: first.endAt }, ev);

    const again = await upsertOccupancy(db, spec(ev, { capacity: 3, durationMin: 45 }));
    expect(again).toEqual(first); // same id, capacity 1, end 15:30
  });
});
