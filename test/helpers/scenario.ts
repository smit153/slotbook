import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { DateTime } from 'luxon';
import type { Database } from '../../src/server/db/kysely.js';
import { createEventType, createHost, type EventTypeRow } from './db.js';

export const APP_SECRET = 'test-app-secret-0123456789abcdef0123';
export const NY = 'America/New_York';

export async function dbNow(db: Database): Promise<Date> {
  const { rows } = await sql<{ now: Date }>`SELECT clock_timestamp() AS now`.execute(db);
  return rows[0]!.now;
}

/** Next week's Monday 09:00 New York: always bookable (future, inside Mon–Fri 09–17). */
export async function nextMonday9(db: Database): Promise<Date> {
  return DateTime.fromJSDate(await dbNow(db), { zone: NY })
    .plus({ weeks: 1 })
    .set({ weekday: 1, hour: 9, minute: 0, second: 0, millisecond: 0 })
    .toJSDate();
}

export interface Scenario {
  hostId: string;
  hostSlug: string;
  ev: EventTypeRow & { slug: string };
  /** Next Monday 09:00 NY. */
  slot: Date;
}

export type EventOpts = Partial<{
  slug: string; capacity: number; duration_min: number; buffer_before_min: number;
  buffer_after_min: number; min_notice_min: number; horizon_days: number;
}>;

/** NY host, Mon–Fri 09:00–17:00, one event type (30 min, cap 1, no notice, 60-day horizon). */
export async function scenario(db: Database, o: EventOpts & { hostSlug?: string } = {}): Promise<Scenario> {
  const hostSlug = o.hostSlug ?? `h-${randomUUID().slice(0, 8)}`;
  const hostId = await createHost(db, { slug: hostSlug, timezone: NY });
  await db.insertInto('availability_rules')
    .values([1, 2, 3, 4, 5].map((weekday) => ({ host_id: hostId, weekday, start_time: '09:00', end_time: '17:00' })))
    .execute();
  const ev = await addEventType(db, hostId, o);
  return { hostId, hostSlug, ev, slot: await nextMonday9(db) };
}

export async function addEventType(db: Database, hostId: string, o: EventOpts = {}): Promise<EventTypeRow & { slug: string }> {
  const slug = o.slug ?? 'ev';
  const ev = await createEventType(db, hostId, {
    slug, capacity: o.capacity ?? 1, duration_min: o.duration_min ?? 30,
    buffer_before_min: o.buffer_before_min ?? 0, buffer_after_min: o.buffer_after_min ?? 0,
    min_notice_min: o.min_notice_min ?? 0, horizon_days: o.horizon_days ?? 60,
  });
  return { ...ev, slug };
}

let ipCounter = 0;
/** A fresh client IP per call, so the per-IP hold cap never interferes unless a test wants it. */
export function freshIp(): string {
  ipCounter += 1;
  return `10.${(ipCounter >> 16) & 255}.${(ipCounter >> 8) & 255}.${ipCounter & 255}`;
}

export function holdRequest(
  sc: { hostSlug: string; ev: { slug: string }; slot: Date },
  o: Partial<{ startAt: Date | string; ip: string; key: string; slug: string }> = {},
) {
  const startAt = o.startAt ?? sc.slot;
  return {
    host: sc.hostSlug,
    slug: o.slug ?? sc.ev.slug,
    start_at: typeof startAt === 'string' ? startAt : startAt.toISOString(),
    clientIp: o.ip ?? freshIp(),
    idempotencyKey: o.key ?? randomUUID(),
  };
}
