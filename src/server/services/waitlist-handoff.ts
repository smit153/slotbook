import { sql, type Transaction } from 'kysely';
import type { DB, Json } from '../db/types.js';
import { findOfferedSlot } from '../engine/slots.js';
import { loadAvailabilityInput, type EventTypeRef, type HostRef } from '../db/slot-inputs.js';
import { upsertOccupancy } from '../db/occupancies.js';
import { recordEvent, sweepExpiredHolds, type ExpiryVia } from './booking-common.js';
import { isSlotConflict } from './tx.js';

/** How long a waitlist offer (a hold created for the next guest) lasts (design §13.3). */
export const OFFER_TTL_MIN = 15;


/**
 * Give every free seat of this host's waitlisted sessions to the next waiting guest (§13.2).
 * Called by EVERY write path that holds the host lock, before COMMIT, with the post-lock clock T.
 * Does nothing (no queries beyond one index probe) when the host has no active entries.
 */
export async function handOffFreeSeats(trx: Transaction<DB>, hostId: string, T: Date, via: ExpiryVia): Promise<number> {
  const active = await trx.selectFrom('waitlist_entries').select('id')
    .where('host_id', '=', hostId).where('status', 'in', ['waiting', 'offered']).limit(1).executeTakeFirst();
  if (!active) return 0;

  // 1. Expired holds and offers of this host become `expired`, so their seats count as free.
  await sweepExpiredHolds(trx, hostId, T, via);
  // 2. Offers that are no longer live lapse (their seat is passed on in step 3, same transaction).
  await sql`
    UPDATE waitlist_entries w SET status = 'lapsed', resolved_at = ${T}::timestamptz
      FROM bookings b
     WHERE b.waitlist_entry_id = w.id AND w.host_id = ${hostId} AND w.status = 'offered' AND b.status = 'expired'`.execute(trx);

  // 3. Sessions with someone waiting.
  const sessions = (await sql<{ event_type_id: string; start_at: Date }>`
    SELECT DISTINCT event_type_id, start_at FROM waitlist_entries
     WHERE host_id = ${hostId} AND status = 'waiting' ORDER BY start_at`.execute(trx)).rows;
  if (sessions.length === 0) return 0;

  const h = await trx.selectFrom('hosts').select(['id', 'slug', 'name', 'timezone']).where('id', '=', hostId).executeTakeFirstOrThrow();
  const host: HostRef = { id: h.id, slug: h.slug, name: h.name, timezone: h.timezone };
  let offered = 0;

  for (const s of sessions) {
    const e = await trx.selectFrom('event_types').selectAll().where('id', '=', s.event_type_id).executeTakeFirstOrThrow();
    const ev: EventTypeRef = {
      id: e.id, slug: e.slug, name: e.name, durationMin: e.duration_min, capacity: e.capacity,
      bufferBeforeMin: e.buffer_before_min, bufferAfterMin: e.buffer_after_min, minNoticeMin: e.min_notice_min, horizonDays: e.horizon_days,
    };
    // Offers obey exactly the rules of a public hold (grid, window, notice, horizon), except the IP cap.
    const input = await loadAvailabilityInput(trx, host, ev, { from: s.start_at, to: new Date(s.start_at.getTime() + 1) }, { now: T, withOccupancies: false });
    const slot = e.active ? findOfferedSlot(input, s.start_at) : null;
    if (!slot) {
      // Nobody can be offered this slot any more (min notice reached, deactivated, rules changed).
      await sql`UPDATE waitlist_entries SET status = 'closed', resolved_at = ${T}::timestamptz
                 WHERE event_type_id = ${ev.id} AND start_at = ${s.start_at}::timestamptz AND status = 'waiting'`.execute(trx);
      continue;
    }

    const occ = await trx.selectFrom('occupancies').select(['capacity', 'seats_taken'])
      .where('event_type_id', '=', ev.id).where('start_at', '=', s.start_at).forUpdate().executeTakeFirst();
    // A session at 0 seats is refreshed from the event type when claimed (upsertOccupancy).
    const free = occ && occ.seats_taken > 0 ? occ.capacity - occ.seats_taken : ev.capacity;
    if (free <= 0) continue;

    const next = await trx.selectFrom('waitlist_entries').select(['id', 'name', 'email', 'guest_tz'])
      .where('event_type_id', '=', ev.id).where('start_at', '=', s.start_at).where('status', '=', 'waiting')
      .orderBy('seq').limit(free).forUpdate().execute();

    for (const w of next) {
      await sql`SAVEPOINT offer`.execute(trx);
      try {
        const ref = await upsertOccupancy(trx, {
          hostId: host.id, eventTypeId: ev.id, startAt: s.start_at, endAt: slot.endAt,
          bufferBeforeMin: ev.bufferBeforeMin, bufferAfterMin: ev.bufferAfterMin, capacity: ev.capacity,
        });
        const expiresAt = new Date(Math.min(T.getTime() + OFFER_TTL_MIN * 60_000, ref.startAt.getTime()));
        const booking = await trx.insertInto('bookings').values({
          host_id: host.id, event_type_id: ev.id, occupancy_id: ref.id, status: 'held',
          start_at: ref.startAt, end_at: ref.endAt, expires_at: expiresAt, client_ip: null, waitlist_entry_id: w.id,
        }).returning('id').executeTakeFirstOrThrow();
        await sql`RELEASE SAVEPOINT offer`.execute(trx);

        await trx.updateTable('waitlist_entries').set({ status: 'offered', offered_at: T }).where('id', '=', w.id).execute();
        await recordEvent(trx, booking.id, 'offered', null, 'held', T, { via, waitlist_entry_id: w.id });
        const payload = {
          type: 'waitlist.offered', waitlist_entry_id: w.id, booking_id: booking.id, host: host.slug, event_type: ev.slug,
          start_at: ref.startAt.toISOString(), end_at: ref.endAt.toISOString(), offer_expires_at: expiresAt.toISOString(),
          guest_name: w.name, guest_email: w.email, guest_tz: w.guest_tz, occurred_at: T.toISOString(),
        }; // no token (design §5.0); a dispatcher would derive the waitlist link at send time
        await trx.insertInto('notifications').values({
          booking_id: booking.id, type: 'waitlist.offered', payload: JSON.stringify(payload) as unknown as Json, created_at: T, next_attempt_at: T,
        }).execute();
        offered += 1;
      } catch (err) {
        if (!isSlotConflict(err)) throw err;
        await sql`ROLLBACK TO SAVEPOINT offer`.execute(trx); // the session cannot take more; they keep waiting
        break;
      }
    }
  }
  return offered;
}

