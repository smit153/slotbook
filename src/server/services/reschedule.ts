import { sql } from 'kysely';
import type { Database } from '../db/kysely.js';
import { upsertOccupancy } from '../db/occupancies.js';
import { loadAvailabilityInput } from '../db/slot-inputs.js';
import { findOfferedSlot } from '../engine/slots.js';
import { looksLikeManageToken, manageTokenHash } from '../auth/secrets.js';
import { rescheduleRequestSchema } from '../../shared/schemas.js';
import { bookingIdByTokenHash, bookingView, enqueueNotification, lockBooking, recordEvent, type BookingView } from './booking-common.js';
import { failure, type ServiceResult } from './errors.js';
import { assertTransition } from './transitions.js';
import { isSlotConflict, writeTx, type Faults } from './tx.js';

export interface RescheduleDeps {
  db: Database;
  lockTimeoutMs?: number;
  faults?: Faults;
}

export interface Rescheduled {
  booking: BookingView;
}

/**
 * POST /api/bookings/{token}/reschedule (design §5.3). Same event type only. One transaction:
 * lock host → booking → T; a retry to the slot the booking is already at is a pure no-op;
 * otherwise sweep, re-validate the new start against the RULES (now = T, min notice applies),
 * then move the booking to the new session. The seat trigger releases the old seat before
 * claiming the new one; if the new slot is taken, the move rolls back to a savepoint and the
 * original booking is untouched (409).
 */
export async function rescheduleBooking(deps: RescheduleDeps, token: string, body: unknown): Promise<ServiceResult<Rescheduled>> {
  const parsed = rescheduleRequestSchema.safeParse(body);
  if (!parsed.success) return failure(400, 'VALIDATION', 'start_at (RFC 3339 instant) is required');
  if (!looksLikeManageToken(token)) return failure(404, 'NOT_FOUND', 'Unknown booking');
  const newStart = new Date(parsed.data.start_at);
  const hash = manageTokenHash(token);

  return writeTx(deps, async (trx) => {
    const id = await bookingIdByTokenHash(trx, hash);
    if (!id) return failure(404, 'NOT_FOUND', 'Unknown booking');
    const locked = await lockBooking(trx, id, deps.faults);
    if (!locked) return failure(404, 'NOT_FOUND', 'Unknown booking');
    const { booking, T } = locked;

    if (booking.status !== 'confirmed') return failure(409, 'INVALID_STATE', `A ${booking.status} booking cannot be rescheduled`);
    // A retried reschedule to where the booking already is: nothing to do, nothing to notify.
    if (booking.start_at.getTime() === newStart.getTime()) return { status: 200, body: { booking: await bookingView(trx, id) } };
    if (booking.start_at.getTime() <= T.getTime()) return failure(409, 'BOOKING_STARTED', 'This booking has already started');

    const row = await trx.selectFrom('event_types as e').innerJoin('hosts as h', 'h.id', 'e.host_id')
      .select(['h.id as host_id', 'h.slug as host_slug', 'h.name as host_name', 'h.timezone', 'h.active as host_active',
        'e.id', 'e.slug', 'e.name', 'e.duration_min', 'e.capacity', 'e.buffer_before_min', 'e.buffer_after_min',
        'e.min_notice_min', 'e.horizon_days', 'e.active'])
      .where('e.id', '=', booking.event_type_id)
      .executeTakeFirstOrThrow();
    if (!row.active || !row.host_active) return failure(409, 'EVENT_TYPE_INACTIVE', 'This event type is no longer offered');
    const host = { id: row.host_id, slug: row.host_slug, name: row.host_name, timezone: row.timezone };
    const eventType = {
      id: row.id, slug: row.slug, name: row.name, durationMin: row.duration_min, capacity: row.capacity,
      bufferBeforeMin: row.buffer_before_min, bufferAfterMin: row.buffer_after_min,
      minNoticeMin: row.min_notice_min, horizonDays: row.horizon_days,
    };

    await sql`UPDATE bookings SET status = 'expired'
               WHERE host_id = ${host.id} AND status = 'held' AND expires_at <= ${T}::timestamptz`.execute(trx);

    const input = await loadAvailabilityInput(trx, host, eventType,
      { from: newStart, to: new Date(newStart.getTime() + 1) }, { now: T, withOccupancies: false });
    const slot = findOfferedSlot(input, newStart);
    if (!slot) return failure(422, 'SLOT_NOT_OFFERED', 'That time is not offered for this event type');

    assertTransition('confirmed', 'confirmed');
    await sql`SAVEPOINT move`.execute(trx);
    try {
      const occ = await upsertOccupancy(trx, {
        hostId: host.id, eventTypeId: eventType.id, startAt: newStart, endAt: slot.endAt,
        bufferBeforeMin: eventType.bufferBeforeMin, bufferAfterMin: eventType.bufferAfterMin, capacity: eventType.capacity,
      });
      await trx.updateTable('bookings')
        .set({ occupancy_id: occ.id, start_at: occ.startAt, end_at: occ.endAt })
        .where('id', '=', id)
        .execute(); // trigger: −1 old session, then +1 new session (constraints fire here)
      await sql`RELEASE SAVEPOINT move`.execute(trx);
    } catch (err) {
      if (!isSlotConflict(err)) throw err;
      await sql`ROLLBACK TO SAVEPOINT move`.execute(trx);
      return failure(409, 'SLOT_UNAVAILABLE', 'That time was just taken');
    }

    const previous = { previous_start_at: booking.start_at.toISOString(), previous_end_at: booking.end_at.toISOString() };
    await recordEvent(trx, id, 'rescheduled', 'confirmed', 'confirmed', T, previous);
    const view = await bookingView(trx, id);
    await enqueueNotification(trx, 'booking.rescheduled', view, T, previous);

    await deps.faults?.beforeCommit?.();
    return { status: 200, body: { booking: view } };
  });
}
