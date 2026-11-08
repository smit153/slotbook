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
