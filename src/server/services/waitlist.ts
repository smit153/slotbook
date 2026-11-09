import { sql, type Transaction } from 'kysely';
import type { Database } from '../db/kysely.js';
import type { DB, Json } from '../db/types.js';
import { deriveHoldSecret, deriveWaitlistToken, sha256, verifyWaitlistToken } from '../auth/secrets.js';
import { idempotencyKeySchema, uuidSchema, waitlistJoinSchema } from '../../shared/schemas.js';
import { findOfferedSlot } from '../engine/slots.js';
import { loadAvailabilityInput, type EventTypeRef, type HostRef } from '../db/slot-inputs.js';
import { recordEvent } from './booking-common.js';
import { confirmHold, type Confirmed } from './confirm.js';
import { failure, type ServiceResult } from './errors.js';
import { claimKey, storeResponse } from './idempotency.js';
import { Gone, lockTarget, normalizeIp, resolveTarget } from './holds.js';
import { acceptZone } from './zones.js';
import { lockedNow, writeTx, type Faults } from './tx.js';
import { handOffFreeSeats, OFFER_TTL_MIN } from './waitlist-handoff.js';

export { handOffFreeSeats, OFFER_TTL_MIN };

/**
 * Waitlist (design §13). An offer IS a held booking linked to its entry, created in the same
 * transaction that freed the seat, so the seat is never visibly free in between.
 */
export const WAITLIST_CAP = 10;
export const WAITLIST_IP_CAP = 3;
const SCOPE = 'waitlist';

export interface WaitlistDeps {
  db: Database;
  appSecret: string;
  lockTimeoutMs?: number;
  faults?: Faults;
}

export interface Joined {
  entry_id: string;
  waitlist_token: string;
  waitlist_url: string;
  position: number;
}

export interface WaitlistState {
  status: 'waiting' | 'offered' | 'booked' | 'lapsed' | 'left' | 'closed';
  position: number | null;
  offer: { expires_at: string; server_now: string } | null;
  name: string;
  slot: { start_at: string; end_at: string; host: { slug: string; name: string }; event_type: { slug: string; name: string; duration_min: number } };
}

const waitlistUrl = (id: string, token: string) => `/waitlist#${id}.${token}`;

// ───────────────────────────── join ─────────────────────────────

class WaitlistLimit extends Error {}

export interface JoinRequest {
  host: string; slug: string; start_at: string; name: string; email: string; tz: string;
  clientIp: string; idempotencyKey: unknown;
}

/** POST /api/waitlist (§13.5). Lock order: key → per-IP waitlist lock → host (§13.7). */
export async function joinWaitlist(deps: WaitlistDeps, req: JoinRequest): Promise<ServiceResult<Joined>> {
  const parsed = waitlistJoinSchema.safeParse(req);
  if (!parsed.success) return failure(400, 'VALIDATION', 'host, slug, start_at, name, email and tz are required');
  if (!acceptZone(parsed.data.tz)) return failure(400, 'VALIDATION', 'tz must be an IANA time zone');
  const key = idempotencyKeySchema.safeParse(req.idempotencyKey);
  if (!key.success) return failure(400, 'IDEMPOTENCY_KEY_INVALID', 'Idempotency-Key header must be 8–128 visible ASCII characters');
  const clientIp = normalizeIp(req.clientIp);
  if (!clientIp) return failure(400, 'VALIDATION', 'Could not determine the client address');
  const startAt = new Date(parsed.data.start_at);
  const d = parsed.data;
  const hash = sha256(JSON.stringify({ host: d.host, slug: d.slug, start_at: startAt.toISOString(), name: d.name, email: d.email, tz: d.tz }));

  const target = await resolveTarget(deps.db, d.host, d.slug);
  if (!target) return failure(404, 'NOT_FOUND', 'Unknown host or event type');

  try {
    return await writeTx(deps, async (trx) => {
      const claimed = await claimKey(trx, SCOPE, key.data, hash);
      if (claimed.kind === 'mismatch') return failure(422, 'IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used with a different request');
      if (claimed.kind === 'replay') {
        if (claimed.status !== 201) return { status: claimed.status, body: claimed.body } as unknown as ServiceResult<Joined>;
        const b = claimed.body as { entry_id: string; position: number };
        const token = deriveWaitlistToken(deps.appSecret, b.entry_id);
        return { status: 201, body: { entry_id: b.entry_id, waitlist_token: token, waitlist_url: waitlistUrl(b.entry_id, token), position: b.position } };
      }

      await sql`SELECT pg_advisory_xact_lock(2, hashtext(${clientIp}))`.execute(trx);
      const { host, eventType } = await lockTarget(trx, target);
      const T = await lockedNow(trx);

      const { rows: [mine] } = await sql<{ n: number }>`
        SELECT count(*)::int AS n FROM waitlist_entries WHERE client_ip = ${clientIp}::inet AND status IN ('waiting', 'offered')`.execute(trx);
      if ((mine?.n ?? 0) >= WAITLIST_IP_CAP) throw new WaitlistLimit();

      await handOffFreeSeats(trx, host.id, T, 'waitlist');

      const result = await enqueue(trx, deps, host, eventType, startAt, d, clientIp, T);
      const stored = result.status === 201
        ? { entry_id: (result.body as Joined).entry_id, position: (result.body as Joined).position } // never the token
        : result.body;
      await storeResponse(trx, SCOPE, key.data, result.status, stored as unknown as Json);
      return result;
    });
  } catch (err) {
    if (err instanceof Gone) return failure(404, 'NOT_FOUND', 'Unknown host or event type');
    if (err instanceof WaitlistLimit) return failure(429, 'WAITLIST_LIMIT', `At most ${WAITLIST_IP_CAP} waitlist entries at once from one address`);
    throw err;
  }
}

async function enqueue(
  trx: Transaction<DB>, deps: WaitlistDeps, host: HostRef, ev: EventTypeRef, startAt: Date,
  d: { name: string; email: string; tz: string }, clientIp: string, T: Date,
): Promise<ServiceResult<Joined>> {
  const input = await loadAvailabilityInput(trx, host, ev, { from: startAt, to: new Date(startAt.getTime() + 1) }, { now: T, withOccupancies: false });
  if (!findOfferedSlot(input, startAt)) return failure(422, 'SLOT_NOT_OFFERED', 'That time is not offered for this event type');

  const occ = await trx.selectFrom('occupancies').select(['capacity', 'seats_taken'])
    .where('event_type_id', '=', ev.id).where('start_at', '=', startAt).executeTakeFirst();
  const free = occ && occ.seats_taken > 0 ? occ.capacity - occ.seats_taken : ev.capacity;
  const { rows: [w] } = await sql<{ n: number }>`
    SELECT count(*)::int AS n FROM waitlist_entries WHERE event_type_id = ${ev.id} AND start_at = ${startAt}::timestamptz AND status = 'waiting'`.execute(trx);
  const waiting = w?.n ?? 0;
  // A blocked slot (another event type overlaps it) has no session to wait for: not offered.
  if (!occ || occ.seats_taken === 0) {
    if (free - waiting > 0) {
      const blocked = await sql<{ n: number }>`
        SELECT count(*)::int AS n FROM occupancies
         WHERE host_id = ${host.id} AND seats_taken > 0
           AND blocked && tstzrange(${new Date(startAt.getTime() - ev.bufferBeforeMin * 60_000)}::timestamptz,
                                    ${new Date(startAt.getTime() + (ev.durationMin + ev.bufferAfterMin) * 60_000)}::timestamptz, '[)')`.execute(trx);
      if ((blocked.rows[0]?.n ?? 0) > 0) return failure(422, 'SLOT_NOT_OFFERED', 'That time is blocked by another booking and has no waitlist');
      return failure(409, 'SLOT_AVAILABLE', 'That time is free; book it instead of joining the waitlist');
    }
  } else if (free - waiting > 0) {
    return failure(409, 'SLOT_AVAILABLE', 'That time is free; book it instead of joining the waitlist');
  }
  if (waiting >= WAITLIST_CAP) return failure(409, 'WAITLIST_FULL', 'The waitlist for this time is full');

  await sql`SAVEPOINT join_entry`.execute(trx);
  try {
    const row = await trx.insertInto('waitlist_entries').values({
      host_id: host.id, event_type_id: ev.id, start_at: startAt, name: d.name, email: d.email, guest_tz: d.tz, client_ip: clientIp, created_at: T,
    }).returning('id').executeTakeFirstOrThrow();
    await sql`RELEASE SAVEPOINT join_entry`.execute(trx);
    const token = deriveWaitlistToken(deps.appSecret, row.id);
    return { status: 201, body: { entry_id: row.id, waitlist_token: token, waitlist_url: waitlistUrl(row.id, token), position: waiting + 1 } };
  } catch (err) {
    if ((err as { code?: string; constraint?: string }).constraint !== 'waitlist_entries_one_active_per_email') throw err;
    await sql`ROLLBACK TO SAVEPOINT join_entry`.execute(trx);
    return failure(409, 'ALREADY_WAITLISTED', 'This email is already on the waitlist for this time');
  }
}

// ───────────────────────────── status / claim / leave ─────────────────────────────

async function verifiedEntry(deps: WaitlistDeps, entryId: string, token: unknown) {
  if (!uuidSchema.safeParse(entryId).success || !verifyWaitlistToken(deps.appSecret, entryId, token)) return null;
  return deps.db.selectFrom('waitlist_entries').selectAll().where('id', '=', entryId).executeTakeFirst() ?? null;
}

/** Re-run the handoff for the entry's host under its lock (read-repair, §13.2). */
async function repair(deps: WaitlistDeps, hostId: string): Promise<void> {
  await writeTx(deps, async (trx) => {
    await sql`SELECT id FROM hosts WHERE id = ${hostId} FOR UPDATE`.execute(trx);
    await handOffFreeSeats(trx, hostId, await lockedNow(trx), 'waitlist');
  });
}

/** GET /api/waitlist/{id} with the Waitlist-Token header. */
export async function waitlistStatus(deps: WaitlistDeps, entryId: string, token: unknown): Promise<ServiceResult<WaitlistState>> {
  let e = await verifiedEntry(deps, entryId, token);
  if (!e) return failure(404, 'NOT_FOUND', 'Unknown waitlist entry');

  // Read-repair: someone may be owed an offer (or this offer may have lapsed) without any
  // write having happened on the host since. The sweeper would get there too; this is sooner.
  const { rows: [probe] } = await sql<{ live_free: number; offer_expired: boolean }>`
    SELECT (SELECT COALESCE(max(o.capacity), ${0}) - count(b.id) FILTER (
               WHERE b.status = 'confirmed' OR (b.status = 'held' AND b.expires_at > clock_timestamp()))
              FROM occupancies o LEFT JOIN bookings b ON b.occupancy_id = o.id
             WHERE o.event_type_id = ${e.event_type_id} AND o.start_at = ${e.start_at}::timestamptz)::int AS live_free,
           EXISTS (SELECT 1 FROM bookings b WHERE b.waitlist_entry_id = ${e.id} AND b.status = 'held' AND b.expires_at <= clock_timestamp()) AS offer_expired`.execute(deps.db);
  if ((e.status === 'waiting' && (probe?.live_free ?? 0) > 0) || (e.status === 'offered' && probe?.offer_expired)) {
    await repair(deps, e.host_id);
    e = (await deps.db.selectFrom('waitlist_entries').selectAll().where('id', '=', entryId).executeTakeFirstOrThrow());
  }

  const view = await sql<{ start_at: Date; end_at: Date | null; host_slug: string; host_name: string; ev_slug: string; ev_name: string; duration_min: number; now: Date; offer_expires: Date | null; position: number }>`
    SELECT w.start_at, o.end_at, h.slug AS host_slug, h.name AS host_name, e.slug AS ev_slug, e.name AS ev_name, e.duration_min,
           clock_timestamp() AS now,
           (SELECT b.expires_at FROM bookings b WHERE b.waitlist_entry_id = w.id AND b.status = 'held') AS offer_expires,
           (SELECT count(*)::int FROM waitlist_entries x WHERE x.event_type_id = w.event_type_id AND x.start_at = w.start_at
               AND x.status = 'waiting' AND x.seq <= w.seq) AS position
      FROM waitlist_entries w
      JOIN hosts h ON h.id = w.host_id
      JOIN event_types e ON e.id = w.event_type_id
      LEFT JOIN occupancies o ON o.event_type_id = w.event_type_id AND o.start_at = w.start_at
     WHERE w.id = ${entryId}`.execute(deps.db);
  const v = view.rows[0]!;
  const endAt = v.end_at ?? new Date(v.start_at.getTime() + v.duration_min * 60_000);
  return {
    status: 200,
    body: {
      status: e.status,
      position: e.status === 'waiting' ? v.position : null,
      offer: e.status === 'offered' && v.offer_expires ? { expires_at: v.offer_expires.toISOString(), server_now: v.now.toISOString() } : null,
      name: e.name,
      slot: {
        start_at: v.start_at.toISOString(), end_at: endAt.toISOString(),
        host: { slug: v.host_slug, name: v.host_name }, event_type: { slug: v.ev_slug, name: v.ev_name, duration_min: v.duration_min },
      },
    },
  };
}

/** POST /api/waitlist/{id}/claim: confirm the offer with the details given when joining. */
export async function claimOffer(deps: WaitlistDeps, entryId: string, token: unknown): Promise<ServiceResult<Confirmed & { manage_url: string }>> {
  const e = await verifiedEntry(deps, entryId, token);
  if (!e) return failure(404, 'NOT_FOUND', 'Unknown waitlist entry');
  if (e.status === 'lapsed') return failure(410, 'OFFER_EXPIRED', 'This offer expired; the seat went to the next person');
  if (e.status !== 'offered' && e.status !== 'booked') return failure(409, 'NOT_OFFERED', 'There is no offer to claim');
  const offer = await deps.db.selectFrom('bookings').select('id').where('waitlist_entry_id', '=', e.id).executeTakeFirst();
  if (!offer) return failure(409, 'NOT_OFFERED', 'There is no offer to claim');

  // The offer is a hold: confirm it through the one confirm path (expiry → 410 + handoff there).
  const r = await confirmHold(deps, offer.id, { hold_secret: deriveHoldSecret(deps.appSecret, offer.id), name: e.name, email: e.email, tz: e.guest_tz });
  if (r.status === 410) return failure(410, 'OFFER_EXPIRED', 'This offer expired; the seat went to the next person');
  if (r.status !== 200) return r as ServiceResult<never>;
  const body = r.body as Confirmed;
  return { status: 200, body: { ...body, manage_url: `/manage#${body.manage_token}` } };
}

/** POST /api/waitlist/{id}/leave: waiting → left; offered → left + the seat goes to the next guest. */
export async function leaveWaitlist(deps: WaitlistDeps, entryId: string, token: unknown): Promise<ServiceResult<{ status: WaitlistState['status'] }>> {
  const e = await verifiedEntry(deps, entryId, token);
  if (!e) return failure(404, 'NOT_FOUND', 'Unknown waitlist entry');
  return writeTx(deps, async (trx) => {
    await sql`SELECT id FROM hosts WHERE id = ${e.host_id} FOR UPDATE`.execute(trx);
    const T = await lockedNow(trx);
    const cur = await trx.selectFrom('waitlist_entries').select('status').where('id', '=', e.id).forUpdate().executeTakeFirstOrThrow();
    if (cur.status === 'waiting') {
      await trx.updateTable('waitlist_entries').set({ status: 'left', resolved_at: T }).where('id', '=', e.id).execute();
    } else if (cur.status === 'offered') {
      const offer = await trx.selectFrom('bookings').select(['id', 'status']).where('waitlist_entry_id', '=', e.id).forUpdate().executeTakeFirstOrThrow();
      if (offer.status === 'held') {
        await trx.updateTable('bookings').set({ status: 'expired' }).where('id', '=', offer.id).execute(); // trigger frees the seat
        await recordEvent(trx, offer.id, 'released', 'held', 'expired', T, { via: 'waitlist-leave' });
      }
      await trx.updateTable('waitlist_entries').set({ status: 'left', resolved_at: T }).where('id', '=', e.id).execute();
      await handOffFreeSeats(trx, e.host_id, T, 'release');
    } else {
      return { status: 200, body: { status: cur.status } };
    }
    return { status: 200, body: { status: 'left' as const } };
  }) as Promise<ServiceResult<{ status: WaitlistState['status'] }>>;
}

