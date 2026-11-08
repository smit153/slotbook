import { sql } from 'kysely';
import type { Database } from '../db/kysely.js';
import { DEFAULT_LOCK_TIMEOUT_MS, lockedNow, setLockTimeout } from '../services/tx.js';

/**
 * Hold sweeper (design §3.1). An optimisation only: every read path counts live seats and
 * every write path sweeps its host under the lock, so correctness never depends on this.
 *
 * Safe with N app instances: each host is swept in its own short transaction that takes the
 * host row with FOR UPDATE SKIP LOCKED — a host that is busy (a booking in flight, or another
 * sweeper) is skipped, never waited on, and its own writers sweep it anyway. Same lock order
 * as the write paths (host row, then bookings), so it cannot deadlock with them.
 */
export interface SweepResult {
  expired: number;
  hostsSwept: number;
  hostsSkipped: number;
  keysPurged: number;
}

export interface SweepOptions {
  /** Idempotency keys older than this are deleted (design §5.1). */
  keyTtlHours?: number;
}

export async function runSweepOnce(db: Database, opts: SweepOptions = {}): Promise<SweepResult> {
  const result: SweepResult = { expired: 0, hostsSwept: 0, hostsSkipped: 0, keysPurged: 0 };

  const { rows: hosts } = await sql<{ host_id: string }>`
    SELECT DISTINCT host_id FROM bookings WHERE status = 'held' AND expires_at <= clock_timestamp()`.execute(db);

  for (const { host_id } of hosts) {
    const expired = await db.transaction().execute(async (trx) => {
      await setLockTimeout(trx, DEFAULT_LOCK_TIMEOUT_MS);
      const got = await sql`SELECT id FROM hosts WHERE id = ${host_id} FOR UPDATE SKIP LOCKED`.execute(trx);
      if (got.rows.length === 0) return null;
      const T = await lockedNow(trx);
      const r = await trx.updateTable('bookings')
        .set({ status: 'expired' })
        .where('host_id', '=', host_id)
        .where('status', '=', 'held')
        .where('expires_at', '<=', T)
        .executeTakeFirst();
      return Number(r.numUpdatedRows);
    });
    if (expired === null) result.hostsSkipped += 1;
    else {
      result.hostsSwept += 1;
      result.expired += expired;
    }
  }

  const purged = await db.deleteFrom('idempotency_keys')
    .where('created_at', '<', sql<Date>`clock_timestamp() - make_interval(hours => ${opts.keyTtlHours ?? 24}::int)`)
    .executeTakeFirst();
  result.keysPurged = Number(purged.numDeletedRows);
  return result;
}

export interface SweeperHandle {
  stop(): Promise<void>;
}

/** Run the sweep every `intervalMs`; never overlaps itself; does not keep the process alive. */
export function startSweeper(
  db: Database,
  opts: SweepOptions & { intervalMs?: number; onResult?: (r: SweepResult) => void; onError?: (err: unknown) => void } = {},
): SweeperHandle {
  let running: Promise<void> | null = null;
  const tick = () => {
    if (running) return;
    running = runSweepOnce(db, opts)
      .then((r) => opts.onResult?.(r))
      .catch((err: unknown) => opts.onError?.(err))
      .finally(() => { running = null; });
  };
  const timer = setInterval(tick, opts.intervalMs ?? 30_000);
  timer.unref();
  return {
    async stop() {
      clearInterval(timer);
      await running;
    },
  };
}
