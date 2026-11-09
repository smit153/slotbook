/**
 * After a load-test run: prove nothing was double-booked and the seat counts are exact.
 * Read-only. Same checks as the test suite's invariant (test/helpers/invariants.ts), plus a
 * direct "two confirmed bookings of one host overlap" query (all load-test events are 1:1).
 * Prints one JSON line; exits 1 if any check fails.
 */
import { sql } from 'kysely';
import { createDb } from '../src/server/db/kysely.js';

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const db = createDb({ connectionString: url, max: 1 });
  try {
    const one = async (q: ReturnType<typeof sql<{ n: number }>>) => (await q.execute(db)).rows[0]!.n;

    const seatDrift = await one(sql<{ n: number }>`
      SELECT count(*)::int AS n FROM (
        SELECT o.id FROM occupancies o LEFT JOIN bookings b ON b.occupancy_id = o.id
         GROUP BY o.id
        HAVING o.seats_taken <> count(b.id) FILTER (WHERE b.status IN ('held', 'confirmed'))) x`);
    const overCapacity = await one(sql<{ n: number }>`
      SELECT count(*)::int AS n FROM occupancies WHERE seats_taken > capacity`);
    const occupancyOverlaps = await one(sql<{ n: number }>`
      SELECT count(*)::int AS n FROM occupancies a JOIN occupancies b
        ON a.host_id = b.host_id AND a.id < b.id AND a.blocked && b.blocked
       WHERE a.seats_taken > 0 AND b.seats_taken > 0`);
    const doubleBooked = await one(sql<{ n: number }>`
      SELECT count(*)::int AS n FROM bookings a JOIN bookings b
        ON a.host_id = b.host_id AND a.id < b.id
       AND tstzrange(a.start_at, a.end_at) && tstzrange(b.start_at, b.end_at)
       JOIN hosts h ON h.id = a.host_id
       WHERE a.status = 'confirmed' AND b.status = 'confirmed' AND h.slug LIKE 'load-%'`);
    const timeMismatch = await one(sql<{ n: number }>`
      SELECT count(*)::int AS n FROM bookings b JOIN occupancies o ON o.id = b.occupancy_id
       WHERE b.status IN ('held', 'confirmed') AND (b.start_at <> o.start_at OR b.end_at <> o.end_at)`);
    const byStatus = Object.fromEntries((await sql<{ status: string; n: number }>`
      SELECT status, count(*)::int AS n FROM bookings GROUP BY status ORDER BY status`.execute(db)).rows.map((r) => [r.status, r.n]));

    const checks = { seatDrift, overCapacity, occupancyOverlaps, doubleBooked, timeMismatch };
    const ok = Object.values(checks).every((n) => n === 0);
    console.log(JSON.stringify({ ok, checks, bookings: byStatus }));
    if (!ok) process.exit(1);
  } finally {
    await db.destroy();
  }
}

main().catch((err: unknown) => {
  console.error('[loadtest-verify] failed:', err);
  process.exit(1);
});
