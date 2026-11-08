import { sql } from 'kysely';
import type { Database } from '../db/kysely.js';
import { looksLikeManageToken, manageTokenHash } from '../auth/secrets.js';
import { bookingView, type BookingView } from './booking-common.js';
import { failure, type ServiceResult } from './errors.js';

/** GET /api/host/bookings — the host's own bookings. upcoming = confirmed and not yet started. */
export async function listHostBookings(db: Database, hostId: string, opts: { upcoming: boolean }) {
  let q = db.selectFrom('bookings as b').innerJoin('event_types as e', 'e.id', 'b.event_type_id')
    .select(['b.id', 'b.status', 'b.start_at', 'b.end_at', 'b.guest_name', 'b.guest_email', 'b.guest_tz',
      'b.cancel_reason', 'b.cancelled_by', 'b.cancelled_at', 'e.slug as event_slug', 'e.name as event_name'])
    .where('b.host_id', '=', hostId);
  q = opts.upcoming
    ? q.where('b.status', '=', 'confirmed').where('b.start_at', '>', sql<Date>`now()`).orderBy('b.start_at', 'asc')
    : q.where('b.status', 'in', ['confirmed', 'cancelled']).orderBy('b.start_at', 'desc');
  return q.limit(200).execute();
}

/** GET /api/host/notifications — the outbox/sink for this host's bookings (no tokens inside). */
export async function listHostNotifications(db: Database, hostId: string) {
  return db.selectFrom('notifications as n').innerJoin('bookings as b', 'b.id', 'n.booking_id')
    .select(['n.id', 'n.type', 'n.payload', 'n.created_at', 'n.delivered_at', 'n.attempts'])
    .where('b.host_id', '=', hostId)
    .orderBy('n.id', 'desc')
    .limit(100)
    .execute();
}

/** GET /api/bookings/:token — the guest's view through the private manage link. */
export async function bookingByToken(db: Database, token: string): Promise<ServiceResult<{ booking: BookingView }>> {
  if (!looksLikeManageToken(token)) return failure(404, 'NOT_FOUND', 'Unknown booking');
  return db.transaction().execute(async (trx) => {
    const row = await trx.selectFrom('bookings').select('id').where('manage_token_hash', '=', manageTokenHash(token)).executeTakeFirst();
    if (!row) return failure(404, 'NOT_FOUND', 'Unknown booking');
    return { status: 200, body: { booking: await bookingView(trx, row.id) } };
  });
}
