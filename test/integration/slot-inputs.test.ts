import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import { DateTime } from 'luxon';
import { findOfferedSlot, generateSlots } from '../../src/server/engine/slots.js';
import { loadSlotContext } from '../../src/server/db/slot-inputs.js';
import { createBooking, createEventType, createHost, createOccupancy, seatsTaken, testDb, truncateAll } from '../helpers/db.js';
import { assertSeatInvariant } from '../helpers/invariants.js';
import { nextMonday9 as sharedNextMonday9 } from '../helpers/scenario.js';

const db = testDb();
afterAll(() => db.destroy());
beforeEach(() => truncateAll(db));
afterEach(async () => {
  vi.useRealTimers();
  await assertSeatInvariant(db);
});

const NY = 'America/New_York';

async function dbNow(): Promise<Date> {
  const { rows } = await sql<{ now: Date }>`SELECT now() AS now`.execute(db);
  return rows[0]!.now;
}

/** First Monday 09:00 NY at least 7 days ahead (same helper as test/helpers/scenario.ts). */
async function nextMonday9(): Promise<Date> {
  return sharedNextMonday9(db);
}

async function setupHost(o: { capacity?: number } = {}) {
  const hostId = await createHost(db, { slug: 'nyhost', timezone: NY });
  const ev = await createEventType(db, hostId, { slug: 'intro', capacity: o.capacity ?? 1, horizon_days: 60 });
  for (const weekday of [1, 2, 3, 4, 5]) {
    await db.insertInto('availability_rules').values({ host_id: hostId, weekday, start_time: '09:00', end_time: '17:00' }).execute();
  }
  return { hostId, ev };
}

const range = (start: Date) => ({ from: start, to: new Date(start.getTime() + 8 * 3_600_000) });

describe('loadSlotContext: resolution', () => {
  it('returns host, event type and engine input; rules come back as Postgres HH:MM:SS', async () => {
    await setupHost();
    const ctx = await loadSlotContext(db, 'nyhost', 'intro', range(await nextMonday9()));
    expect(ctx).not.toBeNull();
    expect(ctx!.host).toMatchObject({ slug: 'nyhost', timezone: NY });
    expect(ctx!.eventType).toMatchObject({ slug: 'intro', durationMin: 30, capacity: 1 });
    expect(ctx!.input.weeklyRules).toContainEqual({ weekday: 1, start: '09:00:00', end: '17:00:00' });
    expect(generateSlots({ ...ctx!.input, ...range(await nextMonday9()) })).toHaveLength(16);
  });

  it('unknown slugs, a deactivated event type and a deactivated host all resolve to null (→ 404)', async () => {
    const { hostId, ev } = await setupHost();
    const r = range(await nextMonday9());
    expect(await loadSlotContext(db, 'nope', 'intro', r)).toBeNull();
    expect(await loadSlotContext(db, 'nyhost', 'nope', r)).toBeNull();

    await db.updateTable('event_types').set({ active: false }).where('id', '=', ev.id).execute();
    expect(await loadSlotContext(db, 'nyhost', 'intro', r)).toBeNull();

    await db.updateTable('event_types').set({ active: true }).where('id', '=', ev.id).execute();
    await db.updateTable('hosts').set({ active: false }).where('id', '=', hostId).execute();
    expect(await loadSlotContext(db, 'nyhost', 'intro', r)).toBeNull();
  });

  it('loads day-off and custom overrides for the covered host days only', async () => {
    const { hostId } = await setupHost();
    const monday = await nextMonday9();
    const mondayDate = DateTime.fromJSDate(monday, { zone: NY }).toISODate()!;
    const farDate = DateTime.fromJSDate(monday, { zone: NY }).plus({ days: 20 }).toISODate()!;
    await db.insertInto('date_overrides').values([
      { host_id: hostId, date: mondayDate, kind: 'custom' },
      { host_id: hostId, date: farDate, kind: 'off' },
    ]).execute();
    await db.insertInto('date_override_windows').values([
      { host_id: hostId, date: mondayDate, start_time: '13:00', end_time: '14:00' },
      { host_id: hostId, date: mondayDate, start_time: '10:00', end_time: '11:00' },
    ]).execute();

    const ctx = await loadSlotContext(db, 'nyhost', 'intro', range(monday));
    expect(ctx!.input.overrides.get(mondayDate)).toEqual({
      kind: 'custom', windows: [{ start: '10:00:00', end: '11:00:00' }, { start: '13:00:00', end: '14:00:00' }],
    });
    expect(ctx!.input.overrides.has(farDate)).toBe(false);
    const slots = generateSlots({ ...ctx!.input, ...range(monday) });
    expect(slots.map((s) => DateTime.fromJSDate(s.startAt, { zone: NY }).toFormat('HH:mm'))).toEqual(['10:00', '10:30', '13:00', '13:30']);
  });
});

describe('loadSlotContext: `now` comes from Postgres (R14 groundwork)', () => {
  it('input.now is the database clock, even when the process clock is skewed by a year', async () => {
    await setupHost();
    const before = await dbNow();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(before.getTime() + 365 * 86_400_000));

    const ctx = await loadSlotContext(db, 'nyhost', 'intro', range(new Date(before.getTime() + 7 * 86_400_000)));
    vi.useRealTimers();
    const after = await dbNow();
    expect(ctx!.input.now.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(ctx!.input.now.getTime()).toBeLessThanOrEqual(after.getTime());
  });
});

describe('R7: live seats are counted from bookings, not from seats_taken or the sweeper', () => {
  async function bookedSlot(status: 'held' | 'confirmed' | 'cancelled' | 'expired', o: { expiresInMin?: number } = {}) {
    const { ev } = await setupHost();
    const start = await nextMonday9();
    const occ = await createOccupancy(db, ev, start.toISOString());
    const id = await createBooking(db, occ, ev, status);
    if (o.expiresInMin !== undefined) {
      await sql`UPDATE bookings SET expires_at = now() + make_interval(mins => ${o.expiresInMin}::int) WHERE id = ${id}`.execute(db);
    }
    const ctx = await loadSlotContext(db, 'nyhost', 'intro', range(start));
    return { start, occ, ctx: ctx! };
  }

  it('an EXPIRED-but-unswept hold does not block the slot (sweeper never ran)', async () => {
    const { start, occ, ctx } = await bookedSlot('held', { expiresInMin: -1 });
    // Stored counter still says 1 (status is still 'held'): the sweeper hasn't run.
    expect(await seatsTaken(db, occ.id)).toBe(1);
    expect(ctx.input.occupancies).toEqual([]);
    expect(findOfferedSlot(ctx.input, start)).not.toBeNull();
  });

  it('an unexpired hold blocks the slot', async () => {
    const { start, ctx } = await bookedSlot('held', { expiresInMin: 5 });
    expect(ctx.input.occupancies).toHaveLength(1);
    expect(findOfferedSlot(ctx.input, start)).toBeNull();
  });

  it('a confirmed booking blocks the slot; a cancelled one does not', async () => {
    const confirmed = await bookedSlot('confirmed');
    expect(findOfferedSlot(confirmed.ctx.input, confirmed.start)).toBeNull();

    await truncateAll(db);
    const cancelled = await bookedSlot('cancelled');
    expect(findOfferedSlot(cancelled.ctx.input, cancelled.start)).not.toBeNull();
  });

  it('group session: live seats = confirmed + unexpired holds (expired/cancelled ignored)', async () => {
    const { ev } = await setupHost({ capacity: 5 });
    const start = await nextMonday9();
    const occ = await createOccupancy(db, ev, start.toISOString());
    await createBooking(db, occ, ev, 'confirmed');
    await createBooking(db, occ, ev, 'held');
    const stale = await createBooking(db, occ, ev, 'held');
    await sql`UPDATE bookings SET expires_at = now() - interval '1 minute' WHERE id = ${stale}`.execute(db);
    await createBooking(db, occ, ev, 'cancelled');

    const ctx = (await loadSlotContext(db, 'nyhost', 'intro', range(start)))!;
    expect(ctx.input.occupancies).toEqual([expect.objectContaining({ liveSeats: 2, capacity: 5 })]);
    expect(findOfferedSlot(ctx.input, start)).toMatchObject({ seatsLeft: 3 });
  });

  it("another host's sessions are not loaded", async () => {
    await setupHost();
    const otherEv = await createEventType(db, await createHost(db, { slug: 'other', timezone: NY }));
    const start = await nextMonday9();
    await createBooking(db, await createOccupancy(db, otherEv, start.toISOString()), otherEv, 'confirmed');
    const ctx = (await loadSlotContext(db, 'nyhost', 'intro', range(start)))!;
    expect(ctx.input.occupancies).toEqual([]);
    expect(findOfferedSlot(ctx.input, start)).not.toBeNull();
  });
});
