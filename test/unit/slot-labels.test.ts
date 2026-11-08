import { describe, expect, it } from 'vitest';
import { localLabel } from '../../src/server/services/slots-view.js';

describe('slot labels (server-computed, design §6)', () => {
  it('fall-back night NY 2026-11-01: both 01:00s are ambiguous and read EDT / EST', () => {
    expect(localLabel(new Date('2026-11-01T05:00:00Z'), 'America/New_York')).toEqual({
      date: '2026-11-01', time: '01:00', label: 'Sun 1 Nov, 01:00 EDT', ambiguous: true,
    });
    expect(localLabel(new Date('2026-11-01T06:00:00Z'), 'America/New_York')).toEqual({
      date: '2026-11-01', time: '01:00', label: 'Sun 1 Nov, 01:00 EST', ambiguous: true,
    });
    expect(localLabel(new Date('2026-11-01T04:30:00Z'), 'America/New_York').ambiguous).toBe(false); // 00:30 EDT
  });

  it('Berlin has no ICU letter abbreviation in en-US: GMT+2 / GMT+1', () => {
    expect(localLabel(new Date('2026-10-23T13:00:00Z'), 'Europe/Berlin').label).toBe('Fri 23 Oct, 15:00 GMT+2');
    expect(localLabel(new Date('2026-10-26T13:00:00Z'), 'Europe/Berlin').label).toBe('Mon 26 Oct, 14:00 GMT+1');
  });

  it('the local date follows the viewer zone (cross-day)', () => {
    expect(localLabel(new Date('2026-10-26T23:00:00Z'), 'Europe/Berlin').date).toBe('2026-10-27');
    expect(localLabel(new Date('2026-10-26T23:00:00Z'), 'America/New_York').date).toBe('2026-10-26');
  });
});
