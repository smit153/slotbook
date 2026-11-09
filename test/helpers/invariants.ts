import { expect } from 'vitest';
import { sql } from 'kysely';
import type { Database } from '../../src/server/db/kysely.js';

/**
 * R11 — seat-count invariant (design §9.1). Called in afterEach of every integration
 * test that touches bookings, and after the randomized test (Phase 5).
 *
 *  1. stored: seats_taken = #bookings with status held|confirmed          (trigger correctness)
 *  2. live:   after a sweep, seats_taken = #confirmed + #held-not-expired  (sweep + trigger)
 *  3. no two live occupancies of one host overlap                          (exclusion, re-checked)
 *  4. every active booking has its occupancy's exact times                 (no FK can enforce this)
 */
export async function assertSeatInvariant(db: Database): Promise<void> {
  const stored = await sql<{ id: string; seats_taken: number; active: number }>`
    SELECT o.id, o.seats_taken,
           count(b.id) FILTER (WHERE b.status IN ('held', 'confirmed'))::int AS active
      FROM occupancies o LEFT JOIN bookings b ON b.occupancy_id = o.id
     GROUP BY o.id
    HAVING o.seats_taken <> count(b.id) FILTER (WHERE b.status IN ('held', 'confirmed'))`.execute(db);
  expect(stored.rows, 'stored invariant: seats_taken drifted from held+confirmed bookings').toEqual([]);

  // 5. Waitlist offers (design §13.8), on the STORED state (before the sweep below):
  //    an offered entry has exactly one linked held booking; booked → confirmed (or later
  //    cancelled); lapsed/left → expired; waiting/closed → no linked booking at all.
  const badOffers = await sql<{ id: string; status: string; bookings: string }>`
    SELECT w.id, w.status::text AS status, string_agg(b.status::text, ',') AS bookings
      FROM waitlist_entries w LEFT JOIN bookings b ON b.waitlist_entry_id = w.id
     GROUP BY w.id, w.status
    HAVING NOT CASE w.status::text
      WHEN 'offered' THEN count(b.id) = 1 AND bool_and(b.status = 'held')
      WHEN 'booked'  THEN count(b.id) = 1 AND bool_and(b.status IN ('confirmed', 'cancelled'))
      WHEN 'lapsed'  THEN count(b.id) = 1 AND bool_and(b.status = 'expired')
      WHEN 'left'    THEN count(b.id) <= 1 AND coalesce(bool_and(b.status = 'expired'), true)
      ELSE count(b.id) = 0 END`.execute(db);
  expect(badOffers.rows, 'waitlist entry and its offer booking disagree').toEqual([]);

  //    Handoff invariant: no session has a free stored seat while someone waits for it, unless
  //    the slot can no longer be offered (event type inactive, or inside min notice).
  const starved = await sql<{ event_type_id: string; start_at: Date }>`
    SELECT w.event_type_id, w.start_at
      FROM waitlist_entries w
      JOIN event_types e ON e.id = w.event_type_id
      LEFT JOIN occupancies o ON o.event_type_id = w.event_type_id AND o.start_at = w.start_at
     WHERE w.status = 'waiting'
       AND e.active AND w.start_at >= now() + make_interval(mins => e.min_notice_min)
       AND (o.id IS NULL OR o.seats_taken < o.capacity)
     GROUP BY w.event_type_id, w.start_at`.execute(db);
  expect(starved.rows, 'a free seat was not handed to the waitlist').toEqual([]);

  await sql`UPDATE bookings SET status = 'expired' WHERE status = 'held' AND expires_at <= now()`.execute(db);

  const live = await sql<{ id: string }>`
    SELECT o.id
      FROM occupancies o LEFT JOIN bookings b ON b.occupancy_id = o.id
     GROUP BY o.id
    HAVING o.seats_taken <> count(b.id) FILTER (
             WHERE b.status = 'confirmed' OR (b.status = 'held' AND b.expires_at > now()))`.execute(db);
  expect(live.rows, 'live invariant: seats_taken != live bookings after sweep').toEqual([]);

  const overlaps = await sql<{ a: string; b: string }>`
    SELECT a.id AS a, b.id AS b
      FROM occupancies a JOIN occupancies b
        ON a.host_id = b.host_id AND a.id < b.id AND a.blocked && b.blocked
     WHERE a.seats_taken > 0 AND b.seats_taken > 0`.execute(db);
  expect(overlaps.rows, 'two live occupancies of one host overlap').toEqual([]);

  const mismatched = await sql<{ id: string }>`
    SELECT b.id FROM bookings b JOIN occupancies o ON o.id = b.occupancy_id
     WHERE b.status IN ('held', 'confirmed')
       AND (b.start_at <> o.start_at OR b.end_at <> o.end_at)`.execute(db);
  expect(mismatched.rows, 'active booking times differ from its occupancy').toEqual([]);
}
