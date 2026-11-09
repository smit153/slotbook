import { sql } from 'kysely';
import type { Database } from '../../src/server/db/kysely.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Poll pg_stat_activity until some backend is waiting on a lock, i.e. the request under test
 * really is blocked behind the lock the test holds. Use this instead of a fixed sleep: a sleep
 * either wastes time or, on a slow machine (CI), releases the lock before the request got there.
 */
export async function waitUntilSomeoneWaitsOnALock(db: Database, timeoutMs = 10_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const { rows } = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM pg_stat_activity
       WHERE datname = current_database() AND wait_event_type = 'Lock'`.execute(db);
    if (rows[0]!.n > 0) return;
    await sleep(10);
  }
  throw new Error('nobody blocked on the lock');
}
