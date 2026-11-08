import { sql, type Transaction } from 'kysely';
import type { DB } from '../db/types.js';

/**
 * Read the database clock ONCE, after the caller has taken its locks (design §5.5).
 * now() is the transaction START, which is stale if the transaction waited for a lock;
 * clock_timestamp() is the real time at this statement. Callers use the returned value for
 * the sweep, expires_at and every expiry check — never now() again.
 */
export async function lockedNow(trx: Transaction<DB>): Promise<Date> {
  const { rows } = await sql<{ t: Date }>`SELECT clock_timestamp() AS t`.execute(trx);
  return rows[0]!.t;
}

/** The two constraints that mean "someone else has this time" (not a bug). */
const SLOT_CONFLICT_CONSTRAINTS = new Set(['occupancies_no_overlap', 'occupancies_seats_within_capacity']);

export function isSlotConflict(err: unknown): boolean {
  const e = err as { code?: string; constraint?: string } | null;
  return !!e && (e.code === '23P01' || e.code === '23514') && SLOT_CONFLICT_CONSTRAINTS.has(e.constraint ?? '');
}

/** Default per-lock wait on write paths (design §5.8). */
export const DEFAULT_LOCK_TIMEOUT_MS = 2_500;

/**
 * SET LOCAL lock_timeout for this transaction only (set_config(..., is_local = true) is the
 * parameterisable form of SET LOCAL). Every lock wait after this — idempotency-key row, IP
 * advisory lock, host row — gives up after `ms` with SQLSTATE 55P03, so a burst on one host
 * fails fast instead of parking every pooled connection behind that host's lock.
 */
export async function setLockTimeout(trx: Transaction<DB>, ms: number): Promise<void> {
  if (!Number.isInteger(ms) || ms <= 0) throw new RangeError(`lock timeout must be a positive integer, got ${ms}`);
  await sql`SELECT set_config('lock_timeout', ${`${ms}ms`}, true)`.execute(trx);
}

export function isLockTimeout(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === '55P03';
}
