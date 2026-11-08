import { describe, expect, it } from 'vitest';
import {
  addDays, assertValidZone, hostDaysCovering, isoWeekday, localDateOf, localToInstant, parseTimeOfDay,
} from '../../../src/server/engine/local-time.js';

const NY = 'America/New_York';
const iso = (ms: number) => new Date(ms).toISOString();

describe('parseTimeOfDay', () => {
  it.each([
    ['09:00', 540], ['09:00:00', 540], ['00:00', 0], ['23:59', 1439], ['24:00', 1440], ['24:00:00', 1440],
  ])('%s → %d', (v, m) => expect(parseTimeOfDay(v)).toBe(m));

  it.each(['9:00', '24:01', '25:00', '12:60', '09:00:30', 'noon', ''])('rejects %j', (v) => {
    expect(() => parseTimeOfDay(v)).toThrow(RangeError);
  });
});

describe('calendar helpers (zone-free)', () => {
  it('ISO weekday: 2026-11-02 is Monday (1), 2026-11-01 is Sunday (7)', () => {
    expect(isoWeekday('2026-11-02')).toBe(1);
    expect(isoWeekday('2026-11-01')).toBe(7);
  });

  it('addDays crosses month/year boundaries and DST dates without drifting', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-08', 1)).toBe('2026-03-09');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('rejects impossible dates', () => {
    expect(() => isoWeekday('2026-02-30')).toThrow(RangeError);
  });

  it('localDateOf uses the zone: 2026-10-27T03:00Z is still Oct 26 in New York', () => {
    expect(localDateOf(Date.parse('2026-10-27T03:00:00Z'), NY)).toBe('2026-10-26');
    expect(localDateOf(Date.parse('2026-10-27T03:00:00Z'), 'Europe/Berlin')).toBe('2026-10-27');
  });

  it('hostDaysCovering pads one host day on each side', () => {
    // Berlin Tue Oct 27 = [Oct 26 23:00Z, Oct 27 23:00Z) = NY Oct 26 19:00 → Oct 27 19:00.
    expect(hostDaysCovering(Date.parse('2026-10-26T23:00:00Z'), Date.parse('2026-10-27T23:00:00Z'), NY))
      .toEqual(['2026-10-25', '2026-10-26', '2026-10-27', '2026-10-28']);
  });
});

describe('localToInstant', () => {
  it('normal times follow the current offset (EDT before Nov 1, EST after)', () => {
    expect(iso(localToInstant('2026-10-30', 9 * 60, NY, 'earlier'))).toBe('2026-10-30T13:00:00.000Z');
    expect(iso(localToInstant('2026-11-02', 9 * 60, NY, 'earlier'))).toBe('2026-11-02T14:00:00.000Z');
  });

  it('fall-back overlap: 01:30 on 2026-11-01 resolves by preference (Luxon default would be EST)', () => {
    expect(iso(localToInstant('2026-11-01', 90, NY, 'earlier'))).toBe('2026-11-01T05:30:00.000Z'); // 01:30 EDT
    expect(iso(localToInstant('2026-11-01', 90, NY, 'later'))).toBe('2026-11-01T06:30:00.000Z'); // 01:30 EST
  });

  it('spring-forward gap: 02:30 on 2026-03-08 does not exist → shifted to 03:30 EDT', () => {
    expect(iso(localToInstant('2026-03-08', 150, NY, 'earlier'))).toBe('2026-03-08T07:30:00.000Z');
    expect(iso(localToInstant('2026-03-08', 150, NY, 'later'))).toBe('2026-03-08T07:30:00.000Z');
  });

  it("24:00 is the next day's midnight", () => {
    expect(iso(localToInstant('2026-11-02', 1440, NY, 'later'))).toBe('2026-11-03T05:00:00.000Z');
  });

  it('invalid zones fail loudly', () => {
    expect(() => assertValidZone('Mars/Olympus')).toThrow(RangeError);
    expect(() => localToInstant('2026-11-02', 540, 'Mars/Olympus', 'earlier')).toThrow(RangeError);
    expect(() => assertValidZone('Europe/Berlin')).not.toThrow();
  });
});
