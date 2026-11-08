import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '../db/types.js';
import { failure, type ServiceResult } from './errors.js';

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

/** Deadlock victim or serialization failure: safe to re-run the whole transaction once. */
export function isRetryable(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === '40P01' || code === '40001';
}

/** Test hooks shared by the write paths. */
export interface Faults {
  /** Runs at the start of every attempt (inside the transaction). */
  onAttempt?: (attempt: number) => Promise<void> | void;
  /** Runs right after the host lock is taken, before the clock is read. */
  afterHostLock?: () => Promise<void> | void;
  /** Runs after every write, just before COMMIT. */
  beforeCommit?: () => Promise<void> | void;
}

export interface WriteTxOptions {
  db: Kysely<DB>;
  lockTimeoutMs?: number;
  faults?: Faults;
}

const MAX_ATTEMPTS = 2;

/**
 * Every write path runs through here (design §5.8):
 *  - SET LOCAL lock_timeout first; a lock wait beyond it (55P03) → 503 HOST_BUSY
 *  - deadlock (40P01) / serialization failure (40001) → re-run the WHOLE transaction once,
 *    then 503 TRY_AGAIN — never a raw 500
 *  - anything else (domain signals, bugs) propagates to the caller
 * A rolled-back attempt leaves nothing behind (incl. idempotency keys), so re-running is safe.
 */
export async function writeTx<R>(opts: WriteTxOptions, fn: (trx: Transaction<DB>) => Promise<R>): Promise<R | ServiceResult<never>> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await opts.db.transaction().execute(async (trx) => {
        await setLockTimeout(trx, opts.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS);
        await opts.faults?.onAttempt?.(attempt);
        return fn(trx);
      });
    } catch (err) {
      if (isLockTimeout(err)) return failure(503, 'HOST_BUSY', 'This calendar is busy right now; please retry in a moment');
      if (isRetryable(err)) {
        if (attempt < MAX_ATTEMPTS) continue;
        return failure(503, 'TRY_AGAIN', 'The request collided with another one; please retry');
      }
      throw err;
    }
  }
}
