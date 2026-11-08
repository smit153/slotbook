import { DateTime } from 'luxon';

/** The browser's zone (aliases like Asia/Calcutta are fine; the server accepts them). */
export function browserZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

const dt = (iso: string, tz: string) => DateTime.fromISO(iso, { zone: tz }).setLocale('en-US');

/** "EST", "EDT", "GMT+1" … (ICU has letter abbreviations only for some zones). */
export function zoneAbbr(iso: string, tz: string): string {
  return dt(iso, tz).toFormat('ZZZZ');
}

/** "09:00–09:30 EST": every time on the dashboard carries its zone. */
export function formatRange(startIso: string, endIso: string, tz: string): string {
  return `${dt(startIso, tz).toFormat('HH:mm')}–${dt(endIso, tz).toFormat('HH:mm')} ${zoneAbbr(startIso, tz)}`;
}

/** "Mon 16 Nov 2026" for a YYYY-MM-DD calendar date. */
export function formatDate(isoDate: string): string {
  return DateTime.fromISO(isoDate, { zone: 'utc' }).setLocale('en-US').toFormat('ccc d LLL yyyy');
}

/** "Mon 16 Nov 2026, 09:00 EST" */
export function formatDateTime(iso: string, tz: string): string {
  return dt(iso, tz).toFormat('ccc d LLL yyyy, HH:mm ZZZZ');
}

export function localDate(iso: string, tz: string): string {
  return dt(iso, tz).toISODate()!;
}

/**
 * The label on a time button. Plain "09:00" normally; on a fall-back night the repeated hour is
 * spelled out with its zone ("01:00 EDT" / "01:00 EST") so the two buttons can't be confused.
 */
export function slotButtonLabel(slot: { start_at: string; local: { time: string; ambiguous: boolean } }, tz: string): string {
  return slot.local.ambiguous ? `${slot.local.time} ${zoneAbbr(slot.start_at, tz)}` : slot.local.time;
}

/** Group items by their local calendar date in `tz`, keeping order. */
export function groupByDay<T>(items: T[], dateOf: (item: T) => string): Array<{ date: string; items: T[] }> {
  const out: Array<{ date: string; items: T[] }> = [];
  for (const item of items) {
    const date = dateOf(item);
    const last = out[out.length - 1];
    if (last && last.date === date) last.items.push(item);
    else out.push({ date, items: [item] });
  }
  return out;
}

/** [start of today, +days) in `tz`, as UTC ISO instants — the guest page's query range. */
export function nextDaysRange(tz: string, days: number, now: DateTime = DateTime.now()): { from: string; to: string } {
  const start = now.setZone(tz).startOf('day');
  return { from: start.toUTC().toISO()!, to: start.plus({ days }).toUTC().toISO()! };
}
