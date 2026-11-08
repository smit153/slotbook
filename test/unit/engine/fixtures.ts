import { DateTime } from 'luxon';
import type { EventTypeSpec, LiveOccupancy, Slot, SlotQuery, WeeklyRule } from '../../../src/server/engine/slots.js';

export const NY = 'America/New_York';
export const BERLIN = 'Europe/Berlin';

export const MON_FRI_9_17: WeeklyRule[] = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start: '09:00', end: '17:00' }));

export function eventType(o: Partial<EventTypeSpec> = {}): EventTypeSpec {
  return {
    id: 'ev-main',
    durationMin: 30,
    capacity: 1,
    bufferBeforeMin: 0,
    bufferAfterMin: 0,
    minNoticeMin: 0,
    horizonDays: 365,
    ...o,
  };
}

/** A whole local day [00:00, next 00:00) in `zone`, as UTC instants. */
export function dayIn(date: string, zone: string): { from: Date; to: Date } {
  const start = DateTime.fromISO(date, { zone }).startOf('day');
  return { from: start.toJSDate(), to: start.plus({ days: 1 }).toJSDate() };
}

export function query(o: Partial<SlotQuery> & { from: Date; to: Date }): SlotQuery {
  return {
    hostTz: NY,
    weeklyRules: MON_FRI_9_17,
    overrides: new Map(),
    eventType: eventType(),
    occupancies: [],
    now: new Date('2026-01-01T00:00:00Z'),
    ...o,
  };
}

export function occupancy(
  o: Partial<Omit<LiveOccupancy, 'startAt' | 'endAt' | 'blockedFrom' | 'blockedTo'>> & {
    startAt: string; endAt: string; blockedFrom?: string; blockedTo?: string;
  },
): LiveOccupancy {
  const startAt = new Date(o.startAt);
  const endAt = new Date(o.endAt);
  return {
    eventTypeId: o.eventTypeId ?? 'ev-other',
    liveSeats: o.liveSeats ?? 1,
    capacity: o.capacity ?? 1,
    startAt,
    endAt,
    blockedFrom: o.blockedFrom ? new Date(o.blockedFrom) : startAt,
    blockedTo: o.blockedTo ? new Date(o.blockedTo) : endAt,
  };
}

/** 'HH:mm' (or 'HH:mm ZZZZ' with abbreviations) of each slot start in `zone`. */
export function local(slots: Slot[], zone: string, withZone = false): string[] {
  return slots.map((s) => DateTime.fromJSDate(s.startAt, { zone }).toFormat(withZone ? 'HH:mm ZZZZ' : 'HH:mm'));
}

export const utc = (slots: Slot[]) => slots.map((s) => s.startAt.toISOString());
