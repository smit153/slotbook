import { describe, expect, it } from 'vitest';
import { generateSlots } from '../../../src/server/engine/slots.js';
import { BERLIN, NY, dayIn, local, query, utc } from './fixtures.js';

/**
 * R12 — design §6.1. Europe ends DST on Sun Oct 25 2026, the US on Sun Nov 1 2026.
 * For that one week New York is 5 h behind Berlin instead of 6 h.
 */
describe('R12: NY host (Mon–Fri 09:00–17:00), Berlin guest, Oct 23 – Nov 2 2026', () => {
  const firstSlot = (berlinDate: string) => generateSlots(query(dayIn(berlinDate, BERLIN)))[0]!;

  it.each([
    // Berlin date  Berlin shows     UTC                         gap
    ['2026-10-23', '15:00 GMT+2', '2026-10-23T13:00:00.000Z'], // Fri: EDT vs CEST → 6 h
    ['2026-10-26', '14:00 GMT+1', '2026-10-26T13:00:00.000Z'], // Mon: EDT vs CET  → 5 h
    ['2026-10-30', '14:00 GMT+1', '2026-10-30T13:00:00.000Z'], // Fri: still 5 h
    ['2026-11-02', '15:00 GMT+1', '2026-11-02T14:00:00.000Z'], // Mon: EST vs CET  → 6 h
  ])('NY 09:00 on %s is %s in Berlin (%s)', (date, berlin, iso) => {
    const s = firstSlot(date);
    expect(s.startAt.toISOString()).toBe(iso);
    expect(local([s], BERLIN, true)[0]).toBe(berlin);
    expect(local([s], NY)[0]).toBe('09:00'); // the host's grid never moves
  });

  it('every weekday in the week has 16 slots and the host grid stays 09:00–16:30 NY', () => {
    for (const d of ['2026-10-23', '2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-11-02']) {
      const slots = generateSlots(query(dayIn(d, NY)));
      expect(slots, d).toHaveLength(16);
      expect(local(slots, NY)[0], d).toBe('09:00');
      expect(local(slots, NY).at(-1), d).toBe('16:30');
    }
  });
});

describe("R12: cross-day — a Berlin guest's Tuesday includes the NY host's Monday evening", () => {
  // Host adds Monday-evening hours 18:00–21:00 NY on Oct 26 (EDT, UTC−4).
  const overrides = new Map([
    ['2026-10-26', { kind: 'custom' as const, windows: [{ start: '18:00', end: '21:00' }] }],
  ]);

  it('Berlin Tue Oct 27 starts with 00:00, 00:30, 01:00, 01:30 — all from the host’s Monday', () => {
    const slots = generateSlots(query({ ...dayIn('2026-10-27', BERLIN), overrides }));
    // Berlin Tuesday = [Oct 26 23:00Z, Oct 27 23:00Z) = NY Mon 19:00 → Tue 19:00.
    expect(local(slots.slice(0, 4), BERLIN)).toEqual(['00:00', '00:30', '01:00', '01:30']);
    expect(local(slots.slice(0, 4), NY)).toEqual(['19:00', '19:30', '20:00', '20:30']);
    expect(utc(slots.slice(0, 4))[0]).toBe('2026-10-26T23:00:00.000Z');
    // …followed by the host's Tuesday 09:00–17:00 NY = 14:00–22:00 Berlin.
    expect(local(slots.slice(4), BERLIN)[0]).toBe('14:00');
    expect(slots).toHaveLength(4 + 16);
  });

  it('the earlier Monday-evening slots (18:00, 18:30 NY) land on Berlin Monday, not Tuesday', () => {
    const monday = generateSlots(query({ ...dayIn('2026-10-26', BERLIN), overrides }));
    expect(local(monday, BERLIN).slice(-2)).toEqual(['23:00', '23:30']);
    expect(local(monday, NY).slice(-2)).toEqual(['18:00', '18:30']);
  });

  it('a slot is never duplicated or lost across consecutive guest days', () => {
    const monday = generateSlots(query({ ...dayIn('2026-10-26', BERLIN), overrides }));
    const tuesday = generateSlots(query({ ...dayIn('2026-10-27', BERLIN), overrides }));
    const both = generateSlots(query({ from: dayIn('2026-10-26', BERLIN).from, to: dayIn('2026-10-27', BERLIN).to, overrides }));
    expect(utc([...monday, ...tuesday])).toEqual(utc(both));
  });
});

describe('R12: fall-back night (NY, Sun Nov 1 2026: 02:00 EDT → 01:00 EST)', () => {
  const sunday = (start: string, end: string) =>
    generateSlots(query({ ...dayIn('2026-11-01', NY), weeklyRules: [{ weekday: 7, start, end }] }));

  it('00:00–03:00 is 4 real hours → 8 slots, including BOTH 01:00 EDT and 01:00 EST', () => {
    const slots = sunday('00:00', '03:00');
    expect(local(slots, NY, true)).toEqual([
      '00:00 EDT', '00:30 EDT', '01:00 EDT', '01:30 EDT', '01:00 EST', '01:30 EST', '02:00 EST', '02:30 EST',
    ]);
    expect(utc(slots)).toEqual([
      '2026-11-01T04:00:00.000Z', '2026-11-01T04:30:00.000Z', '2026-11-01T05:00:00.000Z', '2026-11-01T05:30:00.000Z',
      '2026-11-01T06:00:00.000Z', '2026-11-01T06:30:00.000Z', '2026-11-01T07:00:00.000Z', '2026-11-01T07:30:00.000Z',
    ]);
    expect(new Set(utc(slots)).size).toBe(8);
  });

  it('a window STARTING at the ambiguous 01:00 begins at 01:00 EDT (earlier offset), not EST', () => {
    // Luxon's default would pick 01:00 EST and silently drop the first hour.
    expect(local(sunday('01:00', '02:00'), NY, true)).toEqual(['01:00 EDT', '01:30 EDT', '01:00 EST', '01:30 EST']);
  });

  it('a window ENDING at the ambiguous 01:30 runs to 01:30 EST (later offset)', () => {
    expect(local(sunday('00:00', '01:30'), NY, true)).toEqual(['00:00 EDT', '00:30 EDT', '01:00 EDT', '01:30 EDT', '01:00 EST']);
  });

  it('a 60-min meeting may straddle the switch; its end is start + 60 real minutes', () => {
    const slots = generateSlots(query({
      ...dayIn('2026-11-01', NY), weeklyRules: [{ weekday: 7, start: '01:00', end: '02:00' }],
      eventType: { id: 'ev-main', durationMin: 60, capacity: 1, bufferBeforeMin: 0, bufferAfterMin: 0, minNoticeMin: 0, horizonDays: 365 },
    }));
    expect(local(slots, NY, true)).toEqual(['01:00 EDT', '01:00 EST']);
    for (const s of slots) expect(s.endAt.getTime() - s.startAt.getTime()).toBe(3_600_000);
  });
});

describe('R12: spring-forward night (NY, Sun Mar 8 2026: 02:00 EST → 03:00 EDT)', () => {
  const sunday = (start: string, end: string) =>
    generateSlots(query({ ...dayIn('2026-03-08', NY), weeklyRules: [{ weekday: 7, start, end }] }));

  it('01:00–04:00 is 2 real hours → no phantom 02:xx slots', () => {
    const slots = sunday('01:00', '04:00');
    expect(local(slots, NY, true)).toEqual(['01:00 EST', '01:30 EST', '03:00 EDT', '03:30 EDT']);
    expect(utc(slots)[0]).toBe('2026-03-08T06:00:00.000Z');
  });

  it('a window starting inside the gap (02:30) begins at 03:30 EDT', () => {
    expect(local(sunday('02:30', '05:00'), NY, true)).toEqual(['03:30 EDT', '04:00 EDT', '04:30 EDT']);
  });
});

describe('R12: Berlin host on its own fall-back night (Sun Oct 25 2026: 03:00 CEST → 02:00 CET)', () => {
  it('02:00–03:00 is 2 real hours → 4 slots, both 02:00s present', () => {
    const slots = generateSlots(query({
      ...dayIn('2026-10-25', BERLIN), hostTz: BERLIN, weeklyRules: [{ weekday: 7, start: '02:00', end: '03:00' }],
    }));
    expect(local(slots, BERLIN, true)).toEqual(['02:00 GMT+2', '02:30 GMT+2', '02:00 GMT+1', '02:30 GMT+1']);
  });
});
