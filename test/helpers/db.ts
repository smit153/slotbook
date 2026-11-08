import { randomBytes, randomUUID } from 'node:crypto';
import { inject } from 'vitest';
import { sql } from 'kysely';
import { createDb, type Database } from '../../src/server/db/kysely.js';
import type { BookingStatus } from '../../src/server/db/types.js';

/** A Kysely instance on the per-run test database. Caller must `destroy()` it. */
export function testDb(opts: { max?: number } = {}): Database {
  return createDb({ connectionString: inject('databaseUrl'), max: opts.max ?? 5 });
}

export function testDatabaseUrl(): string {
  return inject('databaseUrl');
}

/**
 * Wipe all app tables. TRUNCATE is not a row event, so neither the seat trigger nor the
 * no-delete trigger fires — safe because bookings and occupancies are truncated together.
 */
export async function truncateAll(db: Database): Promise<void> {
  await sql`TRUNCATE notifications, idempotency_keys, booking_events, bookings, occupancies,
    date_override_windows, date_overrides, availability_rules, event_types, host_sessions, hosts
    RESTART IDENTITY CASCADE`.execute(db);
}

// ───────────────────────────── factories ─────────────────────────────
// Raw inserts that bypass any service logic (and the host lock) on purpose: these tests
// prove what the database guarantees on its own.

export async function createHost(
  db: Database,
  o: Partial<{ slug: string; email: string; timezone: string; name: string }> = {},
): Promise<string> {
  const tag = randomUUID().slice(0, 8);
  const row = await db
    .insertInto('hosts')
    .values({
      slug: o.slug ?? `host-${tag}`,
      email: o.email ?? `host-${tag}@example.test`,
      name: o.name ?? 'Test Host',
      timezone: o.timezone ?? 'America/New_York',
      password_hash: 'not-a-real-hash',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

export interface EventTypeRow {
  id: string;
  host_id: string;
  duration_min: number;
  capacity: number;
  buffer_before_min: number;
  buffer_after_min: number;
}

export async function createEventType(
  db: Database,
  hostId: string,
  o: Partial<Omit<EventTypeRow, 'id' | 'host_id'> & { slug: string; min_notice_min: number; horizon_days: number }> = {},
): Promise<EventTypeRow> {
  return db
    .insertInto('event_types')
    .values({
      host_id: hostId,
      name: 'Test event',
      slug: o.slug ?? `ev-${randomUUID().slice(0, 8)}`,
      duration_min: o.duration_min ?? 30,
      capacity: o.capacity ?? 1,
      buffer_before_min: o.buffer_before_min ?? 0,
      buffer_after_min: o.buffer_after_min ?? 0,
      min_notice_min: o.min_notice_min ?? 0,
      horizon_days: o.horizon_days ?? 30,
    })
    .returning(['id', 'host_id', 'duration_min', 'capacity', 'buffer_before_min', 'buffer_after_min'])
    .executeTakeFirstOrThrow();
}

/** Insert an occupancy row directly (0 seats). `blocked` defaults to the event's buffers. */
export async function createOccupancy(
  db: Database,
  ev: EventTypeRow,
  startIso: string,
  o: Partial<{ durationMin: number; capacity: number }> = {},
): Promise<{ id: string; start_at: Date; end_at: Date }> {
  const start = new Date(startIso);
  const end = new Date(start.getTime() + (o.durationMin ?? ev.duration_min) * 60_000);
  return db
    .insertInto('occupancies')
    .values({
      host_id: ev.host_id,
      event_type_id: ev.id,
      start_at: start,
      end_at: end,
      blocked: sql<string>`tstzrange(
        ${start}::timestamptz - make_interval(mins => ${ev.buffer_before_min}::int),
        ${end}::timestamptz + make_interval(mins => ${ev.buffer_after_min}::int), '[)')`,
      capacity: o.capacity ?? ev.capacity,
    })
    .returning(['id', 'start_at', 'end_at'])
    .executeTakeFirstOrThrow();
}

/** Insert a booking with the columns its status requires (bookings_*_shape CHECKs). */
export async function createBooking(
  db: Database,
  occ: { id: string; start_at: Date; end_at: Date },
  ev: EventTypeRow,
  status: BookingStatus = 'held',
): Promise<string> {
  const confirmedLike = status === 'confirmed' || status === 'cancelled';
  const row = await db
    .insertInto('bookings')
    .values({
      host_id: ev.host_id,
      event_type_id: ev.id,
      occupancy_id: occ.id,
      status,
      start_at: occ.start_at,
      end_at: occ.end_at,
      expires_at: sql<Date>`now() + interval '5 minutes'`,
      guest_name: confirmedLike ? 'Guest' : null,
      guest_email: confirmedLike ? 'guest@example.test' : null,
      manage_token_hash: confirmedLike ? randomBytes(32) : null,
      confirmed_at: confirmedLike ? sql<Date>`now()` : null,
      cancelled_at: status === 'cancelled' ? sql<Date>`now()` : null,
      cancelled_by: status === 'cancelled' ? 'guest' : null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

export async function seatsTaken(db: Database, occupancyId: string): Promise<number> {
  const row = await db.selectFrom('occupancies').select('seats_taken').where('id', '=', occupancyId).executeTakeFirstOrThrow();
  return row.seats_taken;
}

/** Run `fn` and return the Postgres error it throws (fails the test if it doesn't throw). */
export async function pgError(fn: () => Promise<unknown>): Promise<{ code: string; constraint?: string; message: string }> {
  try {
    await fn();
  } catch (err) {
    const e = err as { code?: string; constraint?: string; message: string };
    if (!e.code) throw err;
    return { code: e.code, constraint: e.constraint, message: e.message };
  }
  throw new Error('expected a Postgres error, but the statement succeeded');
}
