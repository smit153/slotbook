import { sql, type Transaction } from 'kysely';
import type { Database } from '../db/kysely.js';
import type { DB } from '../db/types.js';
import { upsertOccupancy } from '../db/occupancies.js';
import { loadAvailabilityInput, type EventTypeRef, type HostRef } from '../db/slot-inputs.js';
import { findOfferedSlot } from '../engine/slots.js';
import { deriveHoldSecret } from '../auth/secrets.js';
import { holdRequestSchema } from '../../shared/schemas.js';
import { failure, type ServiceResult } from './errors.js';
import { isSlotConflict, lockedNow } from './tx.js';

export interface HoldFaults {
  /** Test hook: runs right after the host lock is acquired (before the clock is read). */
  afterHostLock?: () => Promise<void> | void;
  /** Test hook: runs after every write, just before COMMIT (R13 crash simulation). */
  beforeCommit?: () => Promise<void> | void;
}

export interface HoldDeps {
  db: Database;
  appSecret: string;
  /** Hold lifetime in minutes (brief: 5). */
  holdTtlMin?: number;
  faults?: HoldFaults;
}

export interface HoldRequest {
  host: string;
  slug: string;
  start_at: string;
  clientIp: string;
  idempotencyKey: string;
}

export interface HoldCreated {
  hold_id: string;
  hold_secret: string;
  expires_at: string;
  server_now: string;
  start_at: string;
  end_at: string;
}

const DEFAULT_HOLD_TTL_MIN = 5;

class Gone extends Error {}

interface Target {
  host: HostRef;
  eventType: EventTypeRef;
}

/** Resolve the ACTIVE host + event type by slug (no lock; re-checked under the lock). */
async function resolveTarget(db: Database, hostSlug: string, eventSlug: string): Promise<Target | null> {
  const row = await db
    .selectFrom('event_types as e')
    .innerJoin('hosts as h', 'h.id', 'e.host_id')
    .select(['h.id as host_id', 'h.slug as host_slug', 'h.name as host_name', 'h.timezone', 'e.id'])
    .where('h.slug', '=', hostSlug)
    .where('h.active', '=', true)
    .where('e.slug', '=', eventSlug)
    .where('e.active', '=', true)
    .executeTakeFirst();
  if (!row) return null;
  return {
    host: { id: row.host_id, slug: row.host_slug, name: row.host_name, timezone: row.timezone },
    eventType: { id: row.id } as EventTypeRef, // filled under the lock
  };
}

/** Re-read host + event type under the host lock: they may have been deactivated or edited. */
async function lockTarget(trx: Transaction<DB>, t: Target): Promise<Target> {
  const host = await sql<{ id: string; slug: string; name: string; timezone: string; active: boolean }>`
    SELECT id, slug, name, timezone, active FROM hosts WHERE id = ${t.host.id} FOR UPDATE`.execute(trx);
  const h = host.rows[0];
  const e = await trx.selectFrom('event_types').selectAll().where('id', '=', t.eventType.id).executeTakeFirst();
  if (!h?.active || !e?.active) throw new Gone();
  return {
    host: { id: h.id, slug: h.slug, name: h.name, timezone: h.timezone },
    eventType: {
      id: e.id, slug: e.slug, name: e.name, durationMin: e.duration_min, capacity: e.capacity,
      bufferBeforeMin: e.buffer_before_min, bufferAfterMin: e.buffer_after_min,
      minNoticeMin: e.min_notice_min, horizonDays: e.horizon_days,
    },
  };
}

/**
 * POST /api/holds (design §5.1). One transaction:
 *   host lock → T := clock_timestamp() → sweep (expires_at <= T) → re-validate start_at
 *   against the host's RULES (engine, now = T) → SAVEPOINT → claim seat → COMMIT.
 * Overlap/capacity are decided by the database constraints; a violation rolls back to the
 * savepoint and becomes 409 SLOT_UNAVAILABLE.
 */
export async function createHold(deps: HoldDeps, req: HoldRequest): Promise<ServiceResult<HoldCreated>> {
  const parsed = holdRequestSchema.safeParse(req);
  if (!parsed.success) return failure(400, 'VALIDATION', 'host, slug and start_at (RFC 3339 instant) are required');
  const startAt = new Date(parsed.data.start_at);
  const ttlMin = deps.holdTtlMin ?? DEFAULT_HOLD_TTL_MIN;

  const target = await resolveTarget(deps.db, parsed.data.host, parsed.data.slug);
  if (!target) return failure(404, 'NOT_FOUND', 'Unknown host or event type');

  try {
    return await deps.db.transaction().execute(async (trx) => {
      const { host, eventType } = await lockTarget(trx, target);
      await deps.faults?.afterHostLock?.();
      const T = await lockedNow(trx);

      await sql`UPDATE bookings SET status = 'expired'
                 WHERE host_id = ${host.id} AND status = 'held' AND expires_at <= ${T}::timestamptz`.execute(trx);

      const result = await claim(trx, deps, host, eventType, startAt, T, ttlMin, req.clientIp);

      await deps.faults?.beforeCommit?.();
      return result;
    });
  } catch (err) {
    if (err instanceof Gone) return failure(404, 'NOT_FOUND', 'Unknown host or event type');
    throw err;
  }
}

async function claim(
  trx: Transaction<DB>, deps: HoldDeps, host: HostRef, eventType: EventTypeRef,
  startAt: Date, T: Date, ttlMin: number, clientIp: string,
): Promise<ServiceResult<HoldCreated>> {
  // Rules only (no occupancies): grid, window, min notice, horizon, past. Whether the slot
  // is FREE is the database's call, below — so a taken slot is 409, never 422.
  const input = await loadAvailabilityInput(trx, host, eventType, { from: startAt, to: new Date(startAt.getTime() + 1) }, { now: T, withOccupancies: false });
  const slot = findOfferedSlot(input, startAt);
  if (!slot) return failure(422, 'SLOT_NOT_OFFERED', 'That time is not offered for this event type');

  await sql`SAVEPOINT claim`.execute(trx);
  try {
    const occ = await upsertOccupancy(trx, {
      hostId: host.id, eventTypeId: eventType.id, startAt, endAt: slot.endAt,
      bufferBeforeMin: eventType.bufferBeforeMin, bufferAfterMin: eventType.bufferAfterMin,
      capacity: eventType.capacity,
    });
    const expiresAt = new Date(T.getTime() + ttlMin * 60_000);
    const booking = await trx.insertInto('bookings').values({
      host_id: host.id, event_type_id: eventType.id, occupancy_id: occ.id, status: 'held',
      start_at: occ.startAt, end_at: occ.endAt, expires_at: expiresAt, client_ip: clientIp,
    }).returning('id').executeTakeFirstOrThrow();
    await sql`RELEASE SAVEPOINT claim`.execute(trx);

    return {
      status: 201,
      body: {
        hold_id: booking.id,
        hold_secret: deriveHoldSecret(deps.appSecret, booking.id),
        expires_at: expiresAt.toISOString(),
        server_now: T.toISOString(),
        start_at: occ.startAt.toISOString(),
        end_at: occ.endAt.toISOString(),
      },
    };
  } catch (err) {
    if (!isSlotConflict(err)) throw err;
    await sql`ROLLBACK TO SAVEPOINT claim`.execute(trx);
    return failure(409, 'SLOT_UNAVAILABLE', 'That time was just taken');
  }
}
