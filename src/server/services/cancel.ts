import type { Transaction } from 'kysely';
import type { Database } from '../db/kysely.js';
import type { DB } from '../db/types.js';
import { looksLikeManageToken, manageTokenHash } from '../auth/secrets.js';
import { guestCancelSchema, hostCancelSchema, uuidSchema } from '../../shared/schemas.js';
import { bookingIdByTokenHash, bookingView, enqueueNotification, lockBooking, recordEvent, type BookingView } from './booking-common.js';
import { failure, type ServiceResult } from './errors.js';
import { assertTransition } from './transitions.js';
import { writeTx, type Faults } from './tx.js';
import { handOffFreeSeats } from './waitlist-handoff.js';

export interface CancelDeps {
  db: Database;
  lockTimeoutMs?: number;
  faults?: Faults;
}

export interface Cancelled {
  booking: BookingView;
}

/** POST /api/bookings/{token}/cancel — the guest, via the private manage link. */
export async function cancelByGuest(deps: CancelDeps, token: string, body: unknown): Promise<ServiceResult<Cancelled>> {
  const parsed = guestCancelSchema.safeParse(body ?? {});
  if (!parsed.success) return failure(400, 'VALIDATION', 'reason must be at most 500 characters');
  if (!looksLikeManageToken(token)) return failure(404, 'NOT_FOUND', 'Unknown booking');
  const hash = manageTokenHash(token);

  return writeTx(deps, async (trx) => {
    const id = await bookingIdByTokenHash(trx, hash);
    if (!id) return failure(404, 'NOT_FOUND', 'Unknown booking');
    return cancelLocked(trx, deps, id, 'guest', parsed.data.reason || null, null);
  });
}

/** POST /api/host/bookings/{id}/cancel — the authenticated host; a reason is required. */
export async function cancelByHost(deps: CancelDeps, hostId: string, bookingId: string, body: unknown): Promise<ServiceResult<Cancelled>> {
  const parsed = hostCancelSchema.safeParse(body ?? {});
  if (!parsed.success) return failure(400, 'VALIDATION', 'A cancellation reason (1–500 characters) is required');
  if (!uuidSchema.safeParse(bookingId).success) return failure(404, 'NOT_FOUND', 'Unknown booking');
  return writeTx(deps, (trx) => cancelLocked(trx, deps, bookingId, 'host', parsed.data.reason, hostId));
}

async function cancelLocked(
  trx: Transaction<DB>, deps: CancelDeps, bookingId: string,
  by: 'guest' | 'host', reason: string | null, mustBelongToHost: string | null,
): Promise<ServiceResult<Cancelled>> {
  const locked = await lockBooking(trx, bookingId, deps.faults);
  if (!locked) return failure(404, 'NOT_FOUND', 'Unknown booking');
  const { booking, T } = locked;
  if (mustBelongToHost && booking.host_id !== mustBelongToHost) return failure(404, 'NOT_FOUND', 'Unknown booking');

  // Idempotent: cancelling a cancelled booking changes nothing and notifies nobody.
  if (booking.status === 'cancelled') return { status: 200, body: { booking: await bookingView(trx, bookingId) } };
  if (booking.status !== 'confirmed') return failure(409, 'INVALID_STATE', `A ${booking.status} booking cannot be cancelled`);
  // Only upcoming bookings can be cancelled — by the guest or the host (no-shows: known gap).
  if (booking.start_at.getTime() <= T.getTime()) return failure(409, 'BOOKING_STARTED', 'This booking has already started');

  assertTransition('confirmed', 'cancelled');
  await trx.updateTable('bookings').set({
    status: 'cancelled', cancelled_at: T, cancelled_by: by, cancel_reason: reason,
  }).where('id', '=', bookingId).execute(); // trigger frees the seat
  await recordEvent(trx, bookingId, 'cancelled', 'confirmed', 'cancelled', T, { cancelled_by: by, reason });
  await handOffFreeSeats(trx, booking.host_id, T, 'cancel'); // the freed seat goes to the waitlist first
  const view = await bookingView(trx, bookingId);
  await enqueueNotification(trx, 'booking.cancelled', view, T, { cancelled_by: by, reason });

  await deps.faults?.beforeCommit?.();
  return { status: 200, body: { booking: view } };
}
