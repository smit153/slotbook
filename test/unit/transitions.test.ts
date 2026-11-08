import { describe, expect, it } from 'vitest';
import { assertTransition, canTransition, InvalidTransition } from '../../src/server/services/transitions.js';

const ALL = ['held', 'confirmed', 'cancelled', 'expired'] as const;

describe('booking transitions (the single status guard)', () => {
  it.each([
    ['held', 'confirmed'], ['held', 'expired'], ['confirmed', 'cancelled'], ['confirmed', 'confirmed'],
  ] as const)('%s → %s is allowed', (from, to) => {
    expect(canTransition(from, to)).toBe(true);
  });

  it('nothing else is allowed (terminal states stay terminal)', () => {
    const allowed = new Set(['held>confirmed', 'held>expired', 'confirmed>cancelled', 'confirmed>confirmed']);
    for (const from of ALL) for (const to of ALL) {
      expect(canTransition(from, to), `${from} → ${to}`).toBe(allowed.has(`${from}>${to}`));
    }
  });

  it('assertTransition throws a typed error', () => {
    expect(() => assertTransition('cancelled', 'held')).toThrow(InvalidTransition);
    expect(() => assertTransition('expired', 'confirmed')).toThrow(/expired → confirmed/);
  });
});
