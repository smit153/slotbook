import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHold } from '../../src/server/services/holds.js';
import { createBooking, createOccupancy, seatsTaken, testDb, truncateAll } from '../helpers/db.js';
import { assertSeatInvariant } from '../helpers/invariants.js';
import { APP_SECRET, addEventType, holdRequest, scenario } from '../helpers/scenario.js';

/**
 * R1–R4: concurrent holds against real Postgres. Every request is its own transaction on
 * its own pooled connection, from its own IP with its own Idempotency-Key.
 */
const db = testDb({ max: 60 });
const deps = { db, appSecret: APP_SECRET };
afterAll(() => db.destroy());
beforeEach(() => truncateAll(db));
afterEach(() => assertSeatInvariant(db));

type Outcome = { status: number } | { rejected: string };

async function storm(n: number, make: (i: number) => Parameters<typeof createHold>[1]): Promise<Outcome[]> {
  const settled = await Promise.allSettled(Array.from({ length: n }, (_, i) => createHold(deps, make(i))));
  return settled.map((s) => (s.status === 'fulfilled' ? { status: s.value.status } : { rejected: String((s.reason as Error).message) }));
}

function tally(outcomes: Outcome[]) {
  const t = { created: 0, conflict: 0, other: [] as Outcome[] };
  for (const o of outcomes) {
    if ('status' in o && o.status === 201) t.created++;
    else if ('status' in o && o.status === 409) t.conflict++;
    else t.other.push(o);
  }
  return t;
}

describe('R1: 50 parallel holds for the last seat of a 1:1 event', () => {
  it('exactly one 201, forty-nine 409, nothing else', async () => {
    const sc = await scenario(db, { capacity: 1 });
    const t = tally(await storm(50, () => holdRequest(sc)));
    expect(t.other).toEqual([]);
    expect(t).toMatchObject({ created: 1, conflict: 49 });

    const occ = await db.selectFrom('occupancies').select('id').where('event_type_id', '=', sc.ev.id).executeTakeFirstOrThrow();
    expect(await seatsTaken(db, occ.id)).toBe(1);
  });
});

describe('R2: group session with capacity 5, 15 parallel holds', () => {
  it('exactly five 201, ten 409', async () => {
    const sc = await scenario(db, { capacity: 5, duration_min: 60 });
    const t = tally(await storm(15, () => holdRequest(sc)));
    expect(t.other).toEqual([]);
    expect(t).toMatchObject({ created: 5, conflict: 10 });
  });
});

describe('R3: two event types of one host whose times overlap, 20 parallel holds', () => {
  it('exactly one hold wins across both event types', async () => {
    const sc = await scenario(db, { slug: 'short', duration_min: 30 });
    const long = await addEventType(db, sc.hostId, { slug: 'long', duration_min: 60 });
    const t = tally(await storm(20, (i) => holdRequest(sc, { slug: i % 2 === 0 ? 'short' : long.slug })));
    expect(t.other).toEqual([]);
    expect(t).toMatchObject({ created: 1, conflict: 19 });
  });

  it('a buffer-only overlap also allows just one (09:00 + 30 min buffer vs 09:30)', async () => {
    const sc = await scenario(db, { slug: 'buffered', duration_min: 30, buffer_after_min: 30 });
    await addEventType(db, sc.hostId, { slug: 'plain', duration_min: 30 });
    const later = new Date(sc.slot.getTime() + 30 * 60_000);
    const t = tally(await storm(20, (i) =>
      i % 2 === 0 ? holdRequest(sc) : holdRequest(sc, { slug: 'plain', startAt: later })));
    expect(t.other).toEqual([]);
    expect(t).toMatchObject({ created: 1, conflict: 19 });
  });
});

describe('R4: host lock bypassed — the constraints alone hold (parallel raw inserts)', () => {
  it('30 parallel direct inserts on one session of capacity 2 → exactly 2 rows', async () => {
    const sc = await scenario(db, { capacity: 2 });
    const occ = await createOccupancy(db, sc.ev, sc.slot.toISOString());
    const settled = await Promise.allSettled(Array.from({ length: 30 }, () => createBooking(db, occ, sc.ev, 'held')));
    const failures = settled.filter((s) => s.status === 'rejected').map((s) => (s.reason as { constraint?: string }).constraint);
    expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(2);
    expect(new Set(failures)).toEqual(new Set(['occupancies_seats_within_capacity']));
    expect(await seatsTaken(db, occ.id)).toBe(2);
  });

  it('30 parallel direct inserts on 30 mutually overlapping sessions → exactly 1 row', async () => {
    const sc = await scenario(db, { capacity: 1, duration_min: 60 });
    const occs = await Promise.all(Array.from({ length: 30 }, (_, i) =>
      createOccupancy(db, sc.ev, new Date(sc.slot.getTime() + i * 60_000).toISOString())));
    const settled = await Promise.allSettled(occs.map((o) => createBooking(db, o, sc.ev, 'held')));
    const failures = settled.filter((s) => s.status === 'rejected').map((s) => (s.reason as { constraint?: string }).constraint);
    expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(1);
    expect(new Set(failures)).toEqual(new Set(['occupancies_no_overlap']));
  });
});
