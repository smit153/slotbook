import { DateTime, IANAZone } from 'luxon';

/**
 * Wall-clock ↔ instant helpers for the slot engine. All zone math in Slotbook goes through
 * here (design §5.5: none in SQL). Pure: nothing reads the clock.
 */

export const MINUTES_PER_DAY = 1440;

/** Throws for anything that is not a valid IANA zone. (Luxon would silently return invalid dates.) */
export function assertValidZone(zone: string): void {
  if (!IANAZone.isValidZone(zone)) throw new RangeError(`Invalid IANA time zone: ${zone}`);
}

/**
 * 'HH:MM' or 'HH:MM:SS' (Postgres `time` output) → minutes since local midnight.
 * '24:00' → 1440, i.e. the end of the day ("until midnight").
 */
export function parseTimeOfDay(value: string): number {
  const m = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!m) throw new RangeError(`Invalid time of day: ${value}`);
  const [h, min, s] = [Number(m[1]), Number(m[2]), Number(m[3] ?? '0')];
  if (s !== 0) throw new RangeError(`Seconds are not supported in availability times: ${value}`);
  const total = h * 60 + min;
  if (min > 59 || total > MINUTES_PER_DAY) throw new RangeError(`Invalid time of day: ${value}`);
  return total;
}

function parseIsoDate(date: string): DateTime {
  const d = DateTime.fromISO(date, { zone: 'utc' });
  if (!d.isValid || d.toISODate() !== date) throw new RangeError(`Invalid calendar date: ${date}`);
  return d;
}

/** Calendar arithmetic on 'YYYY-MM-DD' strings (zone-free, so DST can't shift it). */
export function addDays(date: string, days: number): string {
  return parseIsoDate(date).plus({ days }).toISODate()!;
}

/** ISO weekday of a calendar date: 1 = Monday … 7 = Sunday. */
export function isoWeekday(date: string): number {
  return parseIsoDate(date).weekday;
}

/** The calendar date an instant falls on in `zone`. */
export function localDateOf(instantMs: number, zone: string): string {
  return DateTime.fromMillis(instantMs, { zone }).toISODate()!;
}

/**
 * Host-local calendar days covering [fromMs, toMs), padded by one day on each side
 * (design §6). A guest's day can start or end on a different host day, and a window can
 * end at 24:00; the padding plus instant filtering makes coverage independent of offsets.
 */
export function hostDaysCovering(fromMs: number, toMs: number, zone: string): string[] {
  const first = addDays(localDateOf(fromMs, zone), -1);
  const last = addDays(localDateOf(toMs, zone), 1);
  const days: string[] = [];
  for (let d = first; d <= last; d = addDays(d, 1)) days.push(d);
  return days;
}

export type OffsetPreference = 'earlier' | 'later';

/**
 * The instant (epoch ms) of local `date` + `minutes` in `zone`.
 *  - Non-existent local time (spring-forward gap): shifted forward, e.g. 02:30 → 03:30.
 *  - Ambiguous local time (fall-back overlap): `prefer` picks the earlier or later instant.
 *    Luxon's own default is the LATER one (verified, Luxon 3.7), so we never rely on it.
 */
export function localToInstant(date: string, minutes: number, zone: string, prefer: OffsetPreference): number {
  const day = minutes === MINUTES_PER_DAY ? addDays(date, 1) : date;
  const mins = minutes === MINUTES_PER_DAY ? 0 : minutes;
  const { year, month, day: dom } = parseIsoDate(day);
  const dt = DateTime.fromObject({ year, month, day: dom, hour: Math.floor(mins / 60), minute: mins % 60 }, { zone });
  if (!dt.isValid) throw new RangeError(`Cannot resolve ${day} ${mins} min in ${zone}: ${dt.invalidExplanation}`);

  const candidates = dt.getPossibleOffsets().map((c) => c.toMillis());
  if (candidates.length === 0) return dt.toMillis();
  return prefer === 'earlier' ? Math.min(...candidates) : Math.max(...candidates);
}
