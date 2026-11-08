import { afterEach, describe, expect, it, vi } from 'vitest';
import { findOfferedSlot, generateSlots } from '../../../src/server/engine/slots.js';
import { NY, eventType, query } from './fixtures.js';

/**
 * R14 groundwork: the engine never reads a clock. `now` is an input (from Postgres), so
 * skewing the process clock — which also skews Luxon's DateTime.now() — changes nothing.
 */
describe('engine ignores the process clock (R14 groundwork)', () => {
  afterEach(() => vi.useRealTimers());

  const q = query({
    from: new Date('2026-10-20T00:00:00Z'),
    to: new Date('2026-11-10T00:00:00Z'),
    now: new Date('2026-10-21T12:00:00Z'),
    eventType: eventType({ minNoticeMin: 240, horizonDays: 14 }),
    hostTz: NY,
  });

  it.each([
    ['one year ahead', '2027-10-21T12:00:00Z'],
    ['one year behind', '2025-10-21T12:00:00Z'],
    ['on the DST switch', '2026-11-01T06:30:00Z'],
  ])('same slots with the JS clock skewed %s', (_label, fake) => {
    const reference = generateSlots(q);
    expect(reference.length).toBeGreaterThan(0);

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(fake));
    expect(generateSlots(q)).toEqual(reference);
    expect(findOfferedSlot(q, reference[0]!.startAt)).toEqual(reference[0]);
  });

  it('moving `now` (the DB clock) is what changes the result', () => {
    const later = generateSlots({ ...q, now: new Date('2026-10-28T12:00:00Z') });
    expect(later[0]!.startAt.getTime()).toBeGreaterThan(generateSlots(q)[0]!.startAt.getTime());
  });
});
