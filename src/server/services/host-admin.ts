import { sql, type Transaction } from 'kysely';
import { z } from 'zod';
import type { Database } from '../db/kysely.js';
import type { DB } from '../db/types.js';
import { failure, type ServiceResult } from './errors.js';
import { AbortTx, writeTx, type Faults } from './tx.js';
import { acceptZone } from './zones.js';

/**
 * Host-side edits (design §5.1 lock table): every write takes the HOST LOCK first, the same
 * lock holds and reschedules take, so a claim never sees a half-applied edit.
 * Nothing here deletes an event type or a host (deactivate instead, design §4.2).
 */
export interface AdminDeps {
  db: Database;
  lockTimeoutMs?: number;
  faults?: Faults;
}

async function lockHost(trx: Transaction<DB>, hostId: string, faults?: Faults): Promise<void> {
  await sql`SELECT id FROM hosts WHERE id = ${hostId} FOR UPDATE`.execute(trx);
  await faults?.afterHostLock?.();
}

type PgError = { code?: string; constraint?: string };
const pg = (e: unknown) => (e ?? {}) as PgError;

// ─────────────────────────────── settings ───────────────────────────────

const settingsSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  timezone: z.string().optional(),
}).strict();

export async function getSettings(db: Database, hostId: string) {
  return db.selectFrom('hosts').select(['slug', 'name', 'email', 'timezone']).where('id', '=', hostId).executeTakeFirstOrThrow();
}

export async function updateSettings(deps: AdminDeps, hostId: string, body: unknown): Promise<ServiceResult<Awaited<ReturnType<typeof getSettings>>>> {
  const p = settingsSchema.safeParse(body);
  if (!p.success) return failure(400, 'VALIDATION', 'Only name and timezone can be changed');
  if (p.data.timezone !== undefined && !acceptZone(p.data.timezone)) return failure(422, 'INVALID_TIMEZONE', 'timezone must be an IANA time zone');
  return writeTx(deps, async (trx) => {
    await lockHost(trx, hostId, deps.faults);
    if (p.data.name !== undefined || p.data.timezone !== undefined) {
      await trx.updateTable('hosts').set({ ...p.data }).where('id', '=', hostId).execute();
    }
    return { status: 200, body: await trx.selectFrom('hosts').select(['slug', 'name', 'email', 'timezone']).where('id', '=', hostId).executeTakeFirstOrThrow() };
  });
}

// ─────────────────────────────── event types ────────────────────────────

const slug = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'lower-case letters, digits and dashes').max(64);
const eventTypeFields = {
  name: z.string().trim().min(1).max(200),
  slug,
  duration_min: z.number().int().min(15).max(120),
  capacity: z.number().int().min(1).max(1000),
  buffer_before_min: z.number().int().min(0).max(30),
  buffer_after_min: z.number().int().min(0).max(30),
  min_notice_min: z.number().int().min(0).max(60 * 24 * 365),
  horizon_days: z.number().int().min(1).max(365),
  active: z.boolean(),
};
const createSchema = z.object({
  ...eventTypeFields,
  capacity: eventTypeFields.capacity.default(1),
  buffer_before_min: eventTypeFields.buffer_before_min.default(0),
  buffer_after_min: eventTypeFields.buffer_after_min.default(0),
  min_notice_min: eventTypeFields.min_notice_min.default(0),
  horizon_days: eventTypeFields.horizon_days.default(30),
  active: eventTypeFields.active.default(true),
}).strict();
const patchSchema = z.object(eventTypeFields).partial().strict();

const EVENT_TYPE_COLUMNS = ['id', 'name', 'slug', 'duration_min', 'capacity', 'buffer_before_min', 'buffer_after_min',
  'min_notice_min', 'horizon_days', 'active'] as const;

export async function listEventTypes(db: Database, hostId: string) {
  return db.selectFrom('event_types').select([...EVENT_TYPE_COLUMNS]).where('host_id', '=', hostId).orderBy('created_at').execute();
}

function eventTypeDbError(err: unknown): ServiceResult<never> | null {
  const e = pg(err);
  if (e.code === '23505' && e.constraint === 'event_types_host_slug_unique') return failure(409, 'SLUG_TAKEN', 'You already have an event type with that slug');
  if (e.code === '23514') return failure(422, 'INVALID_FIELD', `Rejected by the database: ${e.constraint}`);
  return null;
}

export async function createEventType(deps: AdminDeps, hostId: string, body: unknown) {
  const p = createSchema.safeParse(body);
  if (!p.success) return failure(400, 'VALIDATION', p.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  return writeTx(deps, async (trx) => {
    await lockHost(trx, hostId, deps.faults);
    try {
      const row = await trx.insertInto('event_types').values({ ...p.data, host_id: hostId }).returning([...EVENT_TYPE_COLUMNS]).executeTakeFirstOrThrow();
      return { status: 201, body: row };
    } catch (err) {
      const mapped = eventTypeDbError(err);
      if (mapped) throw new AbortTx(mapped);
      throw err;
    }
  });
}

/**
 * PATCH an event type, including `active: false` (deactivation). Live sessions keep their
 * snapshot; a session at 0 seats picks up the new values on its next claim (refresh-on-zero).
 */
export async function updateEventType(deps: AdminDeps, hostId: string, eventTypeId: string, body: unknown) {
  const p = patchSchema.safeParse(body);
  if (!p.success) return failure(400, 'VALIDATION', p.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  if (!z.uuid().safeParse(eventTypeId).success) return failure(404, 'NOT_FOUND', 'Unknown event type');
  return writeTx(deps, async (trx) => {
    await lockHost(trx, hostId, deps.faults);
    const owned = await trx.selectFrom('event_types').select('id').where('id', '=', eventTypeId).where('host_id', '=', hostId).executeTakeFirst();
    if (!owned) return failure(404, 'NOT_FOUND', 'Unknown event type');
    try {
      if (Object.keys(p.data).length > 0) await trx.updateTable('event_types').set(p.data).where('id', '=', eventTypeId).execute();
    } catch (err) {
      const mapped = eventTypeDbError(err);
      if (mapped) throw new AbortTx(mapped);
      throw err;
    }
    return { status: 200, body: await trx.selectFrom('event_types').select([...EVENT_TYPE_COLUMNS]).where('id', '=', eventTypeId).executeTakeFirstOrThrow() };
  });
}

// ─────────────────────────────── availability ───────────────────────────

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM');
const hhmmEnd = z.string().regex(/^(([01]\d|2[0-3]):[0-5]\d|24:00)$/, 'HH:MM (24:00 allowed)');
const windowSchema = z.object({ start: hhmm, end: hhmmEnd }).strict();
const availabilitySchema = z.object({
  weekly: z.array(windowSchema.extend({ weekday: z.number().int().min(1).max(7) })).max(70),
  overrides: z.array(z.object({
    date: z.iso.date(),
    kind: z.enum(['off', 'custom']),
    windows: z.array(windowSchema).max(10).default([]),
  }).strict()).max(400),
}).strict();

export interface Availability {
  weekly: Array<{ weekday: number; start: string; end: string }>;
  overrides: Array<{ date: string; kind: 'off' | 'custom'; windows: Array<{ start: string; end: string }> }>;
}

const hm = (t: string) => t.slice(0, 5);

export async function getAvailability(db: Database | Transaction<DB>, hostId: string): Promise<Availability> {
  const weekly = await db.selectFrom('availability_rules').select(['weekday', 'start_time', 'end_time'])
    .where('host_id', '=', hostId).orderBy('weekday').orderBy('start_time').execute();
  const overrides = await db.selectFrom('date_overrides').select(['date', 'kind']).where('host_id', '=', hostId).orderBy('date').execute();
  const windows = await db.selectFrom('date_override_windows').select(['date', 'start_time', 'end_time'])
    .where('host_id', '=', hostId).orderBy('start_time').execute();
  return {
    weekly: weekly.map((r) => ({ weekday: r.weekday, start: hm(r.start_time), end: hm(r.end_time) })),
    overrides: overrides.map((o) => ({
      date: o.date,
      kind: o.kind as 'off' | 'custom',
      windows: windows.filter((w) => w.date === o.date).map((w) => ({ start: hm(w.start_time), end: hm(w.end_time) })),
    })),
  };
}

/**
 * PUT /api/host/availability — replace weekly rules and date overrides in ONE transaction under
 * the host lock. Any rejected row (overlap, end ≤ start, day off with hours, duplicate date)
 * rolls the whole replacement back: the previous availability stays exactly as it was.
 * Existing bookings are never touched (assumption 8).
 */
export async function replaceAvailability(deps: AdminDeps, hostId: string, body: unknown): Promise<ServiceResult<Availability>> {
  const p = availabilitySchema.safeParse(body);
  if (!p.success) return failure(400, 'VALIDATION', p.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  for (const o of p.data.overrides) {
    if (o.kind === 'off' && o.windows.length > 0) return failure(422, 'INVALID_OVERRIDE', `${o.date}: a day off cannot also have hours`);
    if (o.kind === 'custom' && o.windows.length === 0) return failure(422, 'INVALID_OVERRIDE', `${o.date}: custom hours need at least one window (use kind "off" for a day off)`);
  }

  return writeTx(deps, async (trx) => {
    await lockHost(trx, hostId, deps.faults);
    try {
      await trx.deleteFrom('availability_rules').where('host_id', '=', hostId).execute();
      await trx.deleteFrom('date_overrides').where('host_id', '=', hostId).execute(); // windows cascade
      if (p.data.weekly.length > 0) {
        await trx.insertInto('availability_rules')
          .values(p.data.weekly.map((w) => ({ host_id: hostId, weekday: w.weekday, start_time: w.start, end_time: w.end })))
          .execute();
      }
      if (p.data.overrides.length > 0) {
        await trx.insertInto('date_overrides').values(p.data.overrides.map((o) => ({ host_id: hostId, date: o.date, kind: o.kind }))).execute();
        const windows = p.data.overrides.flatMap((o) => o.windows.map((w) => ({ host_id: hostId, date: o.date, start_time: w.start, end_time: w.end })));
        if (windows.length > 0) await trx.insertInto('date_override_windows').values(windows).execute();
      }
    } catch (err) {
      const e = pg(err);
      if (e.code === '23P01') throw new AbortTx(failure(422, 'OVERLAPPING_WINDOWS', 'Two windows on the same day overlap'));
      if (e.code === '23514') throw new AbortTx(failure(422, 'INVALID_WINDOW', `A window was rejected (${e.constraint}): end must be after start`));
      if (e.code === '23505') throw new AbortTx(failure(422, 'DUPLICATE_DATE', 'A date appears twice in overrides'));
      throw err;
    }
    return { status: 200, body: await getAvailability(trx, hostId) };
  });
}
