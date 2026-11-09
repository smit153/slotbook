import { DateTime } from 'luxon';
import { z } from 'zod';
import type { Database } from '../db/kysely.js';
import { loadSlotContext } from '../db/slot-inputs.js';
import { generateSlots } from '../engine/slots.js';
import { instantSchema } from '../../shared/schemas.js';
import { failure, type ServiceResult } from './errors.js';
import { acceptZone } from './zones.js';
import { WAITLIST_CAP } from './waitlist.js';

const MAX_RANGE_DAYS = 31;

export interface EventInfo {
  host: { slug: string; name: string; timezone: string };
  event_type: { slug: string; name: string; duration_min: number; capacity: number; min_notice_min: number; horizon_days: number };
}

/** GET /api/hosts/:host/events/:slug — ACTIVE host + event type only (else 404). */
export async function eventInfo(db: Database, hostSlug: string, eventSlug: string): Promise<ServiceResult<EventInfo>> {
  const r = await db.selectFrom('event_types as e').innerJoin('hosts as h', 'h.id', 'e.host_id')
    .select(['h.slug as host_slug', 'h.name as host_name', 'h.timezone', 'e.slug', 'e.name', 'e.duration_min',
      'e.capacity', 'e.min_notice_min', 'e.horizon_days'])
    .where('h.slug', '=', hostSlug).where('h.active', '=', true)
    .where('e.slug', '=', eventSlug).where('e.active', '=', true)
    .executeTakeFirst();
  if (!r) return failure(404, 'NOT_FOUND', 'Unknown host or event type');
  return {
    status: 200,
    body: {
      host: { slug: r.host_slug, name: r.host_name, timezone: r.timezone },
      event_type: { slug: r.slug, name: r.name, duration_min: r.duration_min, capacity: r.capacity, min_notice_min: r.min_notice_min, horizon_days: r.horizon_days },
    },
  };
}

export interface SlotOut {
  start_at: string;
  end_at: string;
  seats_left: number;
  /** Only with ?include_full=1, on full slots: the waitlist (design §13.5). `open` = below its cap. */
  waitlist?: { open: boolean; waiting: number };
  /** In the requested time zone. `ambiguous` = this wall-clock time occurs twice (fall-back night). */
  local: { date: string; time: string; label: string; ambiguous: boolean };
}

/**
 * Wall-clock view of an instant in `tz`. `ambiguous` marks a local time that happens twice
 * (fall-back night); the label always carries the zone abbreviation/offset so the two
 * occurrences read differently (EDT vs EST; GMT+2 vs GMT+1 where ICU has no letters).
 */
export function localLabel(instant: Date, tz: string): SlotOut['local'] {
  const dt = DateTime.fromJSDate(instant, { zone: tz }).setLocale('en-US');
  return {
    date: dt.toISODate()!,
    time: dt.toFormat('HH:mm'),
    label: dt.toFormat('ccc d LLL, HH:mm ZZZZ'),
    ambiguous: dt.getPossibleOffsets().length > 1,
  };
}

const slotsQuerySchema = z.object({
  from: instantSchema, to: instantSchema, tz: z.string().optional(),
  include_full: z.enum(['0', '1', 'true', 'false']).optional(),
});

/** GET /api/hosts/:host/events/:slug/slots?from&to&tz — labels are computed here (agreed). */
export async function guestSlots(db: Database, hostSlug: string, eventSlug: string, query: unknown):
  Promise<ServiceResult<EventInfo & { tz: string; from: string; to: string; slots: SlotOut[] }>> {
  const q = slotsQuerySchema.safeParse(query);
  if (!q.success) return failure(400, 'VALIDATION', 'from and to (RFC 3339 instants) are required');
  const from = new Date(q.data.from);
  const to = new Date(q.data.to);
  if (to <= from) return failure(400, 'VALIDATION', '`to` must be after `from`');
  if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * 86_400_000) return failure(400, 'VALIDATION', `range is limited to ${MAX_RANGE_DAYS} days`);
  if (q.data.tz !== undefined && !acceptZone(q.data.tz)) return failure(400, 'VALIDATION', 'tz must be an IANA time zone');

  const ctx = await loadSlotContext(db, hostSlug, eventSlug, { from, to });
  if (!ctx) return failure(404, 'NOT_FOUND', 'Unknown host or event type');
  const tz = q.data.tz ?? ctx.host.timezone;

  const includeFull = q.data.include_full === '1' || q.data.include_full === 'true';
  const slots = generateSlots({ ...ctx.input, from, to, includeFull }).map((s): SlotOut => ({
    start_at: s.startAt.toISOString(),
    end_at: s.endAt.toISOString(),
    seats_left: s.seatsLeft,
    ...(s.full ? { waitlist: { open: s.full.waiting < WAITLIST_CAP, waiting: s.full.waiting } } : {}),
    local: localLabel(s.startAt, tz),
  }));

  return {
    status: 200,
    body: {
      host: { slug: ctx.host.slug, name: ctx.host.name, timezone: ctx.host.timezone },
      event_type: {
        slug: ctx.eventType.slug, name: ctx.eventType.name, duration_min: ctx.eventType.durationMin,
        capacity: ctx.eventType.capacity, min_notice_min: ctx.eventType.minNoticeMin, horizon_days: ctx.eventType.horizonDays,
      },
      tz, from: from.toISOString(), to: to.toISOString(), slots,
    },
  };
}
