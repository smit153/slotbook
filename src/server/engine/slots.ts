import {
  assertValidZone, hostDaysCovering, isoWeekday, localToInstant, parseTimeOfDay,
} from './local-time.js';

/**
 * Slot engine (design §6). Pure: same input → same output; nothing here reads a clock.
 * `now` is an input and always comes from Postgres now() (design §5.5).
 */

export interface TimeWindow {
  /** 'HH:MM' or 'HH:MM:SS' in the host's zone; end may be '24:00'. */
  start: string;
  end: string;
}

export interface WeeklyRule extends TimeWindow {
  /** ISO weekday: 1 = Monday … 7 = Sunday. */
  weekday: number;
}

export type DateOverride = { kind: 'off' } | { kind: 'custom'; windows: TimeWindow[] };

export interface EventTypeSpec {
  id: string;
  durationMin: number;
  capacity: number;
  bufferBeforeMin: number;
  bufferAfterMin: number;
  minNoticeMin: number;
  horizonDays: number;
}

/** An occupancy with its LIVE seat count (confirmed + unexpired holds), never seats_taken. */
export interface LiveOccupancy {
  eventTypeId: string;
  startAt: Date;
  endAt: Date;
  blockedFrom: Date;
  blockedTo: Date;
  liveSeats: number;
  /** Waitlisted guests (design §13): they own the next free seats, so they count as taken. */
  waiting?: number;
  capacity: number;
}

export interface AvailabilityInput {
  hostTz: string;
  weeklyRules: WeeklyRule[];
  /** Keyed by host-local calendar date 'YYYY-MM-DD'. */
  overrides: Map<string, DateOverride>;
  eventType: EventTypeSpec;
  occupancies: LiveOccupancy[];
  /** From the database. Never Date.now(). */
  now: Date;
}

export interface SlotQuery extends AvailabilityInput {
  /** Half-open UTC range [from, to): a slot is returned iff from <= start < to. */
  from: Date;
  to: Date;
  /** Also return full sessions (seatsLeft 0, `full` set), for the waitlist. Default false. */
  includeFull?: boolean;
}

export interface Slot {
  startAt: Date;
  endAt: Date;
  seatsLeft: number;
  /** Only with includeFull: the session is full (seatsLeft 0) and has this many waiting. */
  full?: { waiting: number };
}

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
/** Engine guard; the API caps requests at 31 days. */
export const MAX_RANGE_DAYS = 62;

function windowsFor(date: string, input: AvailabilityInput): TimeWindow[] {
  const override = input.overrides.get(date);
  if (override) return override.kind === 'off' ? [] : override.windows;
  const weekday = isoWeekday(date);
  return input.weeklyRules.filter((r) => r.weekday === weekday);
}

export function generateSlots(q: SlotQuery): Slot[] {
  assertValidZone(q.hostTz);
  const ev = q.eventType;
  if (!(ev.durationMin > 0)) throw new RangeError('durationMin must be positive');
  const fromMs = q.from.getTime();
  const toMs = q.to.getTime();
  if (!(toMs > fromMs)) throw new RangeError('`to` must be after `from`');
  if (toMs - fromMs > MAX_RANGE_DAYS * DAY) throw new RangeError(`range longer than ${MAX_RANGE_DAYS} days`);

  const nowMs = q.now.getTime();
  const earliest = nowMs + ev.minNoticeMin * MINUTE;
  const latest = nowMs + ev.horizonDays * DAY;
  const durMs = ev.durationMin * MINUTE;

  const live = q.occupancies.filter((o) => o.liveSeats + (o.waiting ?? 0) > 0);
  const slots: Slot[] = [];

  for (const date of hostDaysCovering(fromMs, toMs, q.hostTz)) {
    for (const w of windowsFor(date, q)) {
      // Ambiguous boundaries (fall-back night) resolve to their FIRST occurrence, start and
      // end alike: the shorter reading, which never offers time the host didn't mean.
      // A window spanning the whole repeated hour (e.g. 00:00–03:00) still contains both
      // 01:00s, because the grid steps in real minutes.
      const ws = localToInstant(date, parseTimeOfDay(w.start), q.hostTz, 'earlier');
      const we = localToInstant(date, parseTimeOfDay(w.end), q.hostTz, 'earlier');

      // Step in REAL minutes from the window start; end = start instant + duration.
      for (let s = ws; s + durMs <= we; s += durMs) {
        if (s < fromMs || s >= toMs) continue;
        if (s < earliest || s > latest) continue;

        const slot = placeSlot(s, s + durMs, ev, live, q.includeFull === true);
        if (slot) slots.push(slot);
      }
    }
  }

  return slots.sort((a, b) => a.startAt.getTime() - b.startAt.getTime());
}

/**
 * Decide whether a candidate [s, e) is bookable given the host's live occupancies.
 *  - Same event type + same start = the existing group session: join it if seats are left
 *    (its snapshot times win over the current event-type duration).
 *  - Anything else whose blocked range overlaps ours ([s - before, e + after)) blocks it.
 */
function placeSlot(s: number, e: number, ev: EventTypeSpec, live: LiveOccupancy[], includeFull: boolean): Slot | null {
  const blockedFrom = s - ev.bufferBeforeMin * MINUTE;
  const blockedTo = e + ev.bufferAfterMin * MINUTE;
  let slot: Slot = { startAt: new Date(s), endAt: new Date(e), seatsLeft: ev.capacity };

  for (const o of live) {
    if (o.eventTypeId === ev.id && o.startAt.getTime() === s) {
      const left = o.capacity - o.liveSeats - (o.waiting ?? 0);
      if (left <= 0) {
        if (!includeFull) return null;
        // A full session can be waitlisted, unless something else also blocks it (checked below).
        slot = { startAt: new Date(s), endAt: new Date(o.endAt.getTime()), seatsLeft: 0, full: { waiting: o.waiting ?? 0 } };
        continue;
      }
      slot = { startAt: new Date(s), endAt: new Date(o.endAt.getTime()), seatsLeft: left };
      continue;
    }
    // Half-open ranges overlap iff each starts before the other ends.
    if (blockedFrom < o.blockedTo.getTime() && o.blockedFrom.getTime() < blockedTo) return null;
  }
  return slot;
}

/**
 * Server-side re-validation for holds and reschedules (design §5.1 step 5): is `startAt`
 * exactly a slot the engine would offer right now? Same code path as the listing.
 */
export function findOfferedSlot(input: AvailabilityInput, startAt: Date): Slot | null {
  const t = startAt.getTime();
  if (!Number.isFinite(t)) return null;
  const [slot] = generateSlots({ ...input, from: new Date(t), to: new Date(t + 1) });
  return slot && slot.startAt.getTime() === t ? slot : null;
}
