import { sql, type Transaction } from 'kysely';
import type { BookingStatus, DB, Json } from '../db/types.js';
import { lockedNow, type Faults } from './tx.js';

export interface LockedBooking {
  id: string;
  host_id: string;
  event_type_id: string;
  occupancy_id: string;
  status: BookingStatus;
  start_at: Date;
  end_at: Date;
  expires_at: Date | null;
  guest_name: string | null;
  guest_email: string | null;
  guest_tz: string | null;
  confirmed_at: Date | null;
}

/**
 * Lock order for booking writes (design §5.1 table): host row, then the booking row, then
 * read the clock ONCE (design §5.5). The unlocked first read only learns the host id, which
 * never changes for a booking. Returns null if the booking does not exist (→ 404).
 */
export async function lockBooking(
  trx: Transaction<DB>, bookingId: string, faults?: Faults,
): Promise<{ booking: LockedBooking; T: Date } | null> {
  const ref = await trx.selectFrom('bookings').select('host_id').where('id', '=', bookingId).executeTakeFirst();
  if (!ref) return null;
  await sql`SELECT id FROM hosts WHERE id = ${ref.host_id} FOR UPDATE`.execute(trx);
  await faults?.afterHostLock?.();
  const booking = await trx.selectFrom('bookings')
    .select(['id', 'host_id', 'event_type_id', 'occupancy_id', 'status', 'start_at', 'end_at', 'expires_at',
      'guest_name', 'guest_email', 'guest_tz', 'confirmed_at'])
    .where('id', '=', bookingId)
    .forUpdate()
    .executeTakeFirstOrThrow();
  const T = await lockedNow(trx);
  return { booking, T };
}

/** Find a booking id by manage token hash (no lock). */
export async function bookingIdByTokenHash(trx: Transaction<DB>, hash: Buffer): Promise<string | null> {
  const row = await trx.selectFrom('bookings').select('id').where('manage_token_hash', '=', hash).executeTakeFirst();
  return row?.id ?? null;
}

export interface BookingView {
  id: string;
  status: BookingStatus;
  start_at: string;
  end_at: string;
  guest_name: string | null;
  guest_email: string | null;
  guest_tz: string | null;
  host: { slug: string; name: string; timezone: string };
  event_type: { slug: string; name: string; duration_min: number };
  cancel_reason: string | null;
  cancelled_by: string | null;
}

export async function bookingView(trx: Transaction<DB>, bookingId: string): Promise<BookingView> {
  const r = await trx.selectFrom('bookings as b')
    .innerJoin('hosts as h', 'h.id', 'b.host_id')
    .innerJoin('event_types as e', 'e.id', 'b.event_type_id')
    .select([
      'b.id', 'b.status', 'b.start_at', 'b.end_at', 'b.guest_name', 'b.guest_email', 'b.guest_tz',
      'b.cancel_reason', 'b.cancelled_by', 'h.slug as host_slug', 'h.name as host_name', 'h.timezone',
      'e.slug as event_slug', 'e.name as event_name', 'e.duration_min',
    ])
    .where('b.id', '=', bookingId)
    .executeTakeFirstOrThrow();
  return {
    id: r.id, status: r.status, start_at: r.start_at.toISOString(), end_at: r.end_at.toISOString(),
    guest_name: r.guest_name, guest_email: r.guest_email, guest_tz: r.guest_tz,
    host: { slug: r.host_slug, name: r.host_name, timezone: r.timezone },
    event_type: { slug: r.event_slug, name: r.event_name, duration_min: r.duration_min },
    cancel_reason: r.cancel_reason, cancelled_by: r.cancelled_by,
  };
}

/** Audit trail row (design §4). */
export async function recordEvent(
  trx: Transaction<DB>, bookingId: string, type: string,
  from: BookingStatus | null, to: BookingStatus | null, at: Date, payload: Record<string, unknown> = {},
): Promise<void> {
  await trx.insertInto('booking_events').values({
    booking_id: bookingId, type, from_status: from, to_status: to, at, payload: JSON.stringify(payload) as unknown as Json,
  }).execute();
}

export type NotificationType = 'booking.confirmed' | 'booking.rescheduled' | 'booking.cancelled';

/**
 * Transactional outbox (design §3.1): written in the SAME transaction as the state change,
 * so a rolled-back change never notifies and a committed one is never lost. The payload
 * never contains a token or secret (design §5.0); a dispatcher would derive the manage
 * link at send time.
 */
export async function enqueueNotification(
  trx: Transaction<DB>, type: NotificationType, view: BookingView, occurredAt: Date, extra: Record<string, unknown> = {},
): Promise<void> {
  const payload = {
    type,
    booking_id: view.id,
    status: view.status,
    start_at: view.start_at,
    end_at: view.end_at,
    host: view.host.slug,
    event_type: view.event_type.slug,
    guest_name: view.guest_name,
    guest_email: view.guest_email,
    guest_tz: view.guest_tz,
    occurred_at: occurredAt.toISOString(),
    ...extra,
  };
  await trx.insertInto('notifications').values({
    booking_id: view.id, type, payload: JSON.stringify(payload) as unknown as Json, created_at: occurredAt, next_attempt_at: occurredAt,
  }).execute();
}

export type ExpiryVia = 'sweeper' | 'hold' | 'reschedule';

/**
 * held → expired for every hold of `hostId` whose expires_at <= T, with ONE audit row per hold,
 * in a single statement. Callers hold the host lock and pass the clock read after it (design
 * §5.5). Used by the sweeper and by the inline sweeps of the hold and reschedule paths, so the
 * audit trail is complete whoever expires a hold. Returns the number of holds expired.
 */
export async function sweepExpiredHolds(trx: Transaction<DB>, hostId: string, T: Date, via: ExpiryVia): Promise<number> {
  const { rows } = await sql<{ n: number }>`
    WITH expired AS (
      UPDATE bookings SET status = 'expired'
       WHERE host_id = ${hostId} AND status = 'held' AND expires_at <= ${T}::timestamptz
      RETURNING id
    ), audited AS (
      INSERT INTO booking_events (booking_id, type, from_status, to_status, at, payload)
      SELECT id, 'expired', 'held', 'expired', ${T}::timestamptz, ${JSON.stringify({ via })}::jsonb FROM expired
      RETURNING 1
    )
    SELECT count(*)::int AS n FROM audited`.execute(trx);
  return rows[0]?.n ?? 0;
}
