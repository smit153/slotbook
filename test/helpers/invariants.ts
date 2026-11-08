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
