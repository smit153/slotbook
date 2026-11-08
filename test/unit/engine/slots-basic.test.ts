import { describe, expect, it } from 'vitest';
import { findOfferedSlot, generateSlots } from '../../../src/server/engine/slots.js';
import { NY, dayIn, eventType, local, occupancy, query, utc } from './fixtures.js';

const MON = '2026-11-02'; // Monday, after US DST ended (EST, UTC−5)

describe('generateSlots: weekly rules and overrides', () => {
  it('Mon 09:00–17:00, 30 min → 16 slots, :00/:30 grid, ends = start + 30 min', () => {
    const slots = generateSlots(query(dayIn(MON, NY)));
    expect(slots).toHaveLength(16);
    expect(local(slots, NY).slice(0, 3)).toEqual(['09:00', '09:30', '10:00']);
    expect(local(slots, NY).at(-1)).toBe('16:30');
    for (const s of slots) expect(s.endAt.getTime() - s.startAt.getTime()).toBe(30 * 60_000);
    expect(slots.every((s) => s.seatsLeft === 1)).toBe(true);
  });

  it('weekend days without rules have no slots', () => {
    expect(generateSlots(query(dayIn('2026-11-07', NY)))).toEqual([]);
    expect(generateSlots(query(dayIn('2026-11-08', NY)))).toEqual([]);
  });

  it('ISO weekday 7 is Sunday', () => {
    const slots = generateSlots(query({ ...dayIn('2026-11-08', NY), weeklyRules: [{ weekday: 7, start: '10:00', end: '11:00' }] }));
    expect(local(slots, NY)).toEqual(['10:00', '10:30']);
  });

  it('a 45-min event in a 09:00–10:00 window fits once (the meeting must fit inside the window)', () => {
    const slots = generateSlots(query({
      ...dayIn(MON, NY), eventType: eventType({ durationMin: 45 }),
      weeklyRules: [{ weekday: 1, start: '09:00', end: '10:00' }],
    }));
    expect(local(slots, NY)).toEqual(['09:00']);
  });

  it('several windows on one day (Wednesday lunch break)', () => {
    const slots = generateSlots(query({
      ...dayIn('2026-11-04', NY),
      weeklyRules: [{ weekday: 3, start: '09:00', end: '12:00' }, { weekday: 3, start: '13:00', end: '17:00' }],
    }));
    expect(slots).toHaveLength(14);
    expect(local(slots, NY)).not.toContain('12:00');
    expect(local(slots, NY)).toContain('13:00');
  });

  it('buffers may fall outside the window: a 15-min buffer does not shrink 09:00–17:00', () => {
    const slots = generateSlots(query({ ...dayIn(MON, NY), eventType: eventType({ bufferBeforeMin: 15, bufferAfterMin: 15 }) }));
    expect(local(slots, NY)[0]).toBe('09:00');
    expect(local(slots, NY).at(-1)).toBe('16:30');
  });

  it("a day-off override removes the day's weekly hours", () => {
    const slots = generateSlots(query({ ...dayIn(MON, NY), overrides: new Map([[MON, { kind: 'off' as const }]]) }));
    expect(slots).toEqual([]);
  });

  it('a custom override replaces (not adds to) the weekly hours', () => {
    const slots = generateSlots(query({
      ...dayIn(MON, NY),
      overrides: new Map([[MON, { kind: 'custom' as const, windows: [{ start: '18:00', end: '19:00' }] }]]),
    }));
    expect(local(slots, NY)).toEqual(['18:00', '18:30']);
  });

  it('a window ending at 24:00 runs until midnight', () => {
    const slots = generateSlots(query({ ...dayIn('2026-11-06', NY), weeklyRules: [{ weekday: 5, start: '22:00', end: '24:00' }] }));
    expect(local(slots, NY)).toEqual(['22:00', '22:30', '23:00', '23:30']);
  });

  it("accepts Postgres' HH:MM:SS time format", () => {
    const slots = generateSlots(query({ ...dayIn(MON, NY), weeklyRules: [{ weekday: 1, start: '09:00:00', end: '10:00:00' }] }));
    expect(local(slots, NY)).toEqual(['09:00', '09:30']);
  });
});

describe('generateSlots: now, min notice, horizon, range', () => {
  const now = new Date('2026-11-02T15:05:00Z'); // Mon 10:05 EST

  it('nothing in the past; with no notice the next grid slot is the first', () => {
    const slots = generateSlots(query({ ...dayIn(MON, NY), now }));
    expect(local(slots, NY)[0]).toBe('10:30');
  });

  it('a slot starting exactly at now + notice is allowed (inclusive)', () => {
    const slots = generateSlots(query({ ...dayIn(MON, NY), now: new Date('2026-11-02T15:00:00Z'), eventType: eventType({ minNoticeMin: 60 }) }));
    expect(local(slots, NY)[0]).toBe('11:00');
  });

  it('min notice of 4 h from 10:05 → first slot 14:30', () => {
    const slots = generateSlots(query({ ...dayIn(MON, NY), now, eventType: eventType({ minNoticeMin: 240 }) }));
    expect(local(slots, NY)[0]).toBe('14:30');
  });

  it('horizon = now + N × 24 h (inclusive)', () => {
    const slots = generateSlots(query({
      from: new Date('2026-11-02T00:00:00Z'), to: new Date('2026-11-10T00:00:00Z'),
      now: new Date('2026-11-02T14:00:00Z'), eventType: eventType({ horizonDays: 1 }),
    }));
    expect(utc(slots).at(-1)).toBe('2026-11-03T14:00:00.000Z'); // exactly now + 24 h
  });

  it('range is half-open [from, to) by start instant', () => {
    const slots = generateSlots(query({ from: new Date('2026-11-02T14:30:00Z'), to: new Date('2026-11-02T15:30:00Z') }));
    expect(utc(slots)).toEqual(['2026-11-02T14:30:00.000Z', '2026-11-02T15:00:00.000Z']);
  });

  it('output is sorted and has no duplicate starts over a month', () => {
    const slots = generateSlots(query({ from: new Date('2026-10-01T00:00:00Z'), to: new Date('2026-11-01T00:00:00Z') }));
    const starts = slots.map((s) => s.startAt.getTime());
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
    expect(new Set(starts).size).toBe(starts.length);
  });

  it('rejects bad input loudly', () => {
    const r = dayIn(MON, NY);
    expect(() => generateSlots(query({ ...r, hostTz: 'Not/AZone' }))).toThrow(RangeError);
    expect(() => generateSlots(query({ from: r.to, to: r.from }))).toThrow(RangeError);
    expect(() => generateSlots(query({ from: r.from, to: new Date(r.from.getTime() + 63 * 86_400_000) }))).toThrow(RangeError);
  });
});

describe('findOfferedSlot (R8 groundwork: server-side re-validation of a requested start)', () => {
  const base = query({ ...dayIn(MON, NY), now: new Date('2026-11-01T12:00:00Z'), eventType: eventType({ minNoticeMin: 240, horizonDays: 30 }) });
  const at = (iso: string) => findOfferedSlot(base, new Date(iso));

  it('accepts a real slot and returns it', () => {
    expect(at('2026-11-02T14:00:00Z')).toMatchObject({ seatsLeft: 1 }); // Mon 09:00 EST
  });

  it.each([
    ['off-grid (09:10)', '2026-11-02T14:10:00Z'],
    ['outside the window (08:30)', '2026-11-02T13:30:00Z'],
    ['meeting would end after the window (16:45)', '2026-11-02T21:45:00Z'],
    ['in the past', '2026-10-30T14:00:00Z'],
    ['inside min notice', '2026-11-01T14:00:00Z'],
    ['beyond the horizon', '2026-12-07T14:00:00Z'],
    ['on a weekend', '2026-11-07T14:00:00Z'],
  ])('rejects %s', (_label, iso) => {
    expect(at(iso)).toBeNull();
  });

  it('rejects a slot taken by another session, and an invalid date', () => {
    const taken = { ...base, occupancies: [occupancy({ startAt: '2026-11-02T14:00:00Z', endAt: '2026-11-02T14:30:00Z' })] };
    expect(findOfferedSlot(taken, new Date('2026-11-02T14:00:00Z'))).toBeNull();
    expect(findOfferedSlot(base, new Date('nonsense'))).toBeNull();
  });

  it('rejects a day-off date even though the weekly rule would allow it', () => {
    const off = { ...base, overrides: new Map([[MON, { kind: 'off' as const }]]) };
    expect(findOfferedSlot(off, new Date('2026-11-02T14:00:00Z'))).toBeNull();
  });
});
