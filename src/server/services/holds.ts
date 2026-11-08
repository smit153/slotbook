import { isIP } from 'node:net';
import { sql, type Transaction } from 'kysely';
import type { Database } from '../db/kysely.js';
import type { DB } from '../db/types.js';
import { upsertOccupancy } from '../db/occupancies.js';
import { loadAvailabilityInput, type EventTypeRef, type HostRef } from '../db/slot-inputs.js';
import { findOfferedSlot } from '../engine/slots.js';
import { deriveHoldSecret } from '../auth/secrets.js';
import { holdRequestSchema, idempotencyKeySchema } from '../../shared/schemas.js';
import type { Json } from '../db/types.js';
import { failure, type ServiceResult } from './errors.js';
import { claimKey, holdRequestHash, storeResponse } from './idempotency.js';
import { sweepExpiredHolds } from './booking-common.js';
import { isSlotConflict, lockedNow, writeTx, type Faults } from './tx.js';

const SCOPE = 'hold';

export type HoldFaults = Faults;

export interface HoldDeps {
  db: Database;
  appSecret: string;
  /** Hold lifetime in minutes (brief: 5). */
  holdTtlMin?: number;
  /** Max live (unexpired) holds per client IP across all hosts (design §5.1 step 4). */
  ipHoldCap?: number;
  /** Max wait per lock before giving up with 503 (design §5.8). */
  lockTimeoutMs?: number;
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
const DEFAULT_IP_HOLD_CAP = 3;

class Gone extends Error {}
/** Thrown inside the transaction so it ROLLS BACK: a 429 must not be stored for the key. */
class HoldLimit extends Error {}

/** IPv4-mapped IPv6 (::ffff:1.2.3.4) is the same client as 1.2.3.4. */
export function normalizeIp(ip: string): string | null {
  const v = ip.trim().toLowerCase();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(v);
  const out = mapped ? mapped[1]! : v;
  return isIP(out) ? out : null;
}

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
  const key = idempotencyKeySchema.safeParse(req.idempotencyKey);
  if (!key.success) return failure(400, 'IDEMPOTENCY_KEY_INVALID', 'Idempotency-Key header must be 8–128 visible ASCII characters');
  const clientIp = normalizeIp(req.clientIp);
  if (!clientIp) return failure(400, 'VALIDATION', 'Could not determine the client address');
  const ipCap = deps.ipHoldCap ?? DEFAULT_IP_HOLD_CAP;
  const startAt = new Date(parsed.data.start_at);
  const ttlMin = deps.holdTtlMin ?? DEFAULT_HOLD_TTL_MIN;

  const target = await resolveTarget(deps.db, parsed.data.host, parsed.data.slug);
  if (!target) return failure(404, 'NOT_FOUND', 'Unknown host or event type');

  try {
    return await writeTx(deps, async (trx) => {
      // 1. Claim the key first: a concurrent duplicate waits here, before any other lock.
      const claimed = await claimKey(trx, SCOPE, key.data, holdRequestHash(parsed.data));
      if (claimed.kind === 'mismatch') {
        return failure(422, 'IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used with a different request');
      }
      if (claimed.kind === 'replay') return replay(trx, deps, claimed.status, claimed.body);

      // 2. IP lock, then 3. host lock — the global lock order (design §5.1).
      await sql`SELECT pg_advisory_xact_lock(1, hashtext(${clientIp}))`.execute(trx);
      const { host, eventType } = await lockTarget(trx, target);
      await deps.faults?.afterHostLock?.();
      const T = await lockedNow(trx);

      // 4. Per-IP cap, counted with the locked clock across ALL hosts.
      const { rows: [ip] } = await sql<{ n: number }>`
        SELECT count(*)::int AS n FROM bookings
         WHERE client_ip = ${clientIp}::inet AND status = 'held' AND expires_at > ${T}::timestamptz`.execute(trx);
      if ((ip?.n ?? 0) >= ipCap) throw new HoldLimit();

      await sweepExpiredHolds(trx, host.id, T, 'hold');

      const result = await claim(trx, deps, host, eventType, startAt, T, ttlMin, clientIp);

      // Terminal business outcomes (201 / 409 / 422) are stored for the key — without the secret.
      await storeResponse(trx, SCOPE, key.data, result.status, storable(result));

      await deps.faults?.beforeCommit?.();
      return result;
    });
  } catch (err) {
    if (err instanceof Gone) return failure(404, 'NOT_FOUND', 'Unknown host or event type');
    if (err instanceof HoldLimit) {
      return failure(429, 'HOLD_LIMIT', `At most ${ipCap} slots can be held at once; finish or let one expire first`);
    }
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

/** What goes into idempotency_keys.response_body: the response minus secrets and the clock. */
function storable(result: ServiceResult<HoldCreated>): Json {
  if (result.status !== 201) return result.body as unknown as Json;
  const { hold_secret: _secret, server_now: _now, ...rest } = result.body as HoldCreated;
  return rest;
}

/** Rebuild a stored response: re-derive the hold secret, use the CURRENT server time. */
async function replay(trx: Transaction<DB>, deps: HoldDeps, status: number, body: Json): Promise<ServiceResult<HoldCreated>> {
  if (status !== 201) return { status, body: body as never, replayed: true };
  const stored = body as Omit<HoldCreated, 'hold_secret' | 'server_now'>;
  const now = await lockedNow(trx);
  return {
    status,
    replayed: true,
    body: { ...stored, hold_secret: deriveHoldSecret(deps.appSecret, stored.hold_id), server_now: now.toISOString() },
  };
}
