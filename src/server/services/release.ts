import type { Database } from '../db/kysely.js';
import { verifyHoldSecret } from '../auth/secrets.js';
import { holdSecretBodySchema, uuidSchema } from '../../shared/schemas.js';
import { lockBooking, recordEvent } from './booking-common.js';
import { failure, type ServiceResult } from './errors.js';
import { assertTransition } from './transitions.js';
import { writeTx, type Faults } from './tx.js';
import { handOffFreeSeats } from './waitlist-handoff.js';

export interface ReleaseDeps {
  db: Database;
  appSecret: string;
  lockTimeoutMs?: number;
  faults?: Faults;
}

export interface Released {
  hold_id: string;
  status: 'expired';
}

/**
 * POST /api/holds/{id}/release — the guest gives a hold back (e.g. picked another slot):
 * held → expired, which frees the seat immediately and stops it counting toward the
 * per-IP hold cap. Idempotent: releasing an already expired hold is 200 with no write.
 */
export async function releaseHold(deps: ReleaseDeps, holdId: string, body: unknown): Promise<ServiceResult<Released>> {
  const parsed = holdSecretBodySchema.safeParse(body);
  if (!parsed.success) return failure(400, 'VALIDATION', 'hold_secret is required');
  if (!uuidSchema.safeParse(holdId).success || !verifyHoldSecret(deps.appSecret, holdId, parsed.data.hold_secret)) {
    return failure(404, 'NOT_FOUND', 'Unknown hold');
  }

  return writeTx(deps, async (trx) => {
    const locked = await lockBooking(trx, holdId, deps.faults);
    if (!locked) return failure(404, 'NOT_FOUND', 'Unknown hold');
    const { booking, T } = locked;

    if (booking.status === 'expired') return { status: 200, body: { hold_id: holdId, status: 'expired' as const } };
    if (booking.status !== 'held') return failure(409, 'INVALID_STATE', `A ${booking.status} booking cannot be released`);

    assertTransition('held', 'expired');
    await trx.updateTable('bookings').set({ status: 'expired' }).where('id', '=', holdId).execute(); // trigger frees the seat
    await recordEvent(trx, holdId, 'released', 'held', 'expired', T);
    await handOffFreeSeats(trx, booking.host_id, T, 'release');

    await deps.faults?.beforeCommit?.();
    return { status: 200, body: { hold_id: holdId, status: 'expired' as const } };
  });
}
