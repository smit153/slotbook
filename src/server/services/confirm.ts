import type { Database } from '../db/kysely.js';
import { deriveManageToken, manageTokenHash, verifyHoldSecret } from '../auth/secrets.js';
import { confirmRequestSchema, uuidSchema } from '../../shared/schemas.js';
import { isKnownTimeZone } from '../../shared/timezones.js';
import { bookingView, enqueueNotification, lockBooking, recordEvent, type BookingView } from './booking-common.js';
import { failure, type ServiceResult } from './errors.js';
import { assertTransition } from './transitions.js';
import { writeTx, type Faults } from './tx.js';

export interface ConfirmDeps {
  db: Database;
  appSecret: string;
  lockTimeoutMs?: number;
  faults?: Faults;
}

export interface Confirmed {
  booking: BookingView;
  /** Returned only here (and on a replay within the window); never stored in plaintext. */
  manage_token: string;
}

/** A retried confirm with the same details gets the same answer for this long (design §5.2). */
export const CONFIRM_REPLAY_WINDOW_MS = 15 * 60_000;

/**
 * POST /api/holds/{id}/confirm (design §5.2). The hold secret is the credential; the clock is
 * read after the host + booking locks, so a hold that expired while we waited is 410.
 */
export async function confirmHold(deps: ConfirmDeps, holdId: string, body: unknown): Promise<ServiceResult<Confirmed>> {
  const parsed = confirmRequestSchema.safeParse(body);
  if (!parsed.success) return failure(400, 'VALIDATION', 'hold_secret, name, email and tz are required');
  if (!isKnownTimeZone(parsed.data.tz)) return failure(400, 'VALIDATION', 'tz must be an IANA time zone');
  if (!uuidSchema.safeParse(holdId).success || !verifyHoldSecret(deps.appSecret, holdId, parsed.data.hold_secret)) {
    return failure(404, 'NOT_FOUND', 'Unknown hold');
  }
  const name = parsed.data.name; // trimmed by the schema
  const email = parsed.data.email; // trimmed + lower-cased by the schema
  const tz = parsed.data.tz;

  return writeTx(deps, async (trx) => {
    const locked = await lockBooking(trx, holdId, deps.faults);
    if (!locked) return failure(404, 'NOT_FOUND', 'Unknown hold');
    const { booking, T } = locked;

    switch (booking.status) {
      case 'held': {
        if (booking.expires_at!.getTime() <= T.getTime()) {
          assertTransition('held', 'expired');
          await trx.updateTable('bookings').set({ status: 'expired' }).where('id', '=', holdId).execute();
          await recordEvent(trx, holdId, 'expired', 'held', 'expired', T, { via: 'confirm' });
          return failure(410, 'HOLD_EXPIRED', 'This hold expired; please pick the slot again');
        }
        assertTransition('held', 'confirmed');
        const token = deriveManageToken(deps.appSecret, holdId);
        await trx.updateTable('bookings').set({
          status: 'confirmed', guest_name: name, guest_email: email, guest_tz: tz,
          manage_token_hash: manageTokenHash(token), confirmed_at: T,
        }).where('id', '=', holdId).execute();
        await recordEvent(trx, holdId, 'confirmed', 'held', 'confirmed', T);
        const view = await bookingView(trx, holdId);
        await enqueueNotification(trx, 'booking.confirmed', view, T);
        await deps.faults?.beforeCommit?.();
        return { status: 200, body: { booking: view, manage_token: token } };
      }
      case 'confirmed': {
        const sameDetails = booking.guest_name === name && booking.guest_email === email;
        const inWindow = T.getTime() < booking.confirmed_at!.getTime() + CONFIRM_REPLAY_WINDOW_MS;
        if (sameDetails && inWindow) {
          return {
            status: 200,
            replayed: true,
            body: { booking: await bookingView(trx, holdId), manage_token: deriveManageToken(deps.appSecret, holdId) },
          };
        }
        return failure(409, 'ALREADY_CONFIRMED', 'This hold was already confirmed');
      }
      case 'expired':
        return failure(410, 'HOLD_EXPIRED', 'This hold expired or was released; please pick the slot again');
      case 'cancelled':
        return failure(409, 'INVALID_STATE', 'This booking was cancelled');
    }
  });
}
