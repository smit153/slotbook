import { describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import { NY, firstMondayNineAtLeastAWeekAhead } from '../helpers/scenario.js';

// The original helper used set({ weekday: 1 }), which moves within the ISO week, so on a
// Sunday it returned TOMORROW. Checked here for every weekday, late in the NY evening.
describe('test helper: first Monday 09:00 NY at least a week ahead', () => {
  it.each([1, 2, 3, 4, 5, 6, 7])('from ISO weekday %d it is a Monday 7–13 days out', (wd) => {
    const now = DateTime.fromISO('2026-11-02T22:30:00', { zone: NY }).plus({ days: wd - 1 });
    const m = firstMondayNineAtLeastAWeekAhead(now);
    expect(m.weekday).toBe(1);
    expect(m.toFormat('HH:mm')).toBe('09:00');
    const days = m.startOf('day').diff(now.startOf('day'), 'days').days;
    expect(days).toBeGreaterThanOrEqual(7);
    expect(days).toBeLessThanOrEqual(13);
  });
});
