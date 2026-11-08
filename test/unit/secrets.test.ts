import { describe, expect, it } from 'vitest';
import {
  deriveHoldSecret, deriveManageToken, looksLikeManageToken, manageTokenHash, sha256, verifyHoldSecret,
} from '../../src/server/auth/secrets.js';

const SECRET = 'test-app-secret-0123456789abcdef0123';
const ID = '8a7f3a52-1d1c-4c3e-9a51-6b2f6f0f2a10';

describe('hold secrets (HMAC-derived, design §5.0)', () => {
  it('are deterministic per booking id and url-safe', () => {
    const s = deriveHoldSecret(SECRET, ID);
    expect(deriveHoldSecret(SECRET, ID)).toBe(s);
    expect(s).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 bytes, base64url, no padding
  });

  it('differ per booking and per APP_SECRET', () => {
    expect(deriveHoldSecret(SECRET, ID)).not.toBe(deriveHoldSecret(SECRET, ID.replace('a10', 'a11')));
    expect(deriveHoldSecret(SECRET, ID)).not.toBe(deriveHoldSecret(`${SECRET}x`, ID));
  });

  it('verify accepts the right secret and rejects everything else without throwing', () => {
    const s = deriveHoldSecret(SECRET, ID);
    expect(verifyHoldSecret(SECRET, ID, s)).toBe(true);
    expect(verifyHoldSecret(SECRET, ID.replace('a10', 'a11'), s)).toBe(false);
    // Tamper with a middle character (the last base64url char only carries 4 data bits, so
    // changing it can decode to the same bytes — harmless, but not a meaningful test).
    const flipped = s.slice(0, 10) + (s[10] === 'A' ? 'B' : 'A') + s.slice(11);
    expect(verifyHoldSecret(SECRET, ID, flipped)).toBe(false);
    for (const bad of ['', 'short', 'x'.repeat(500), null, undefined, 42, { s }]) {
      expect(verifyHoldSecret(SECRET, ID, bad)).toBe(false);
    }
  });

  it('sha256 gives 32 bytes (the size the bookings token-hash CHECK expects)', () => {
    expect(sha256('x')).toHaveLength(32);
  });
});

describe('manage tokens (HMAC-derived, only sha256 stored)', () => {
  it('are deterministic, 43 url-safe chars, and distinct from the hold secret', () => {
    const t = deriveManageToken(SECRET, ID);
    expect(deriveManageToken(SECRET, ID)).toBe(t);
    expect(looksLikeManageToken(t)).toBe(true);
    expect(t).not.toBe(deriveHoldSecret(SECRET, ID));
  });

  it('the stored hash is 32 bytes and is not the token', () => {
    const t = deriveManageToken(SECRET, ID);
    expect(manageTokenHash(t)).toHaveLength(32);
    expect(manageTokenHash(t).toString('base64url')).not.toBe(t);
  });

  it('looksLikeManageToken rejects anything that is not exactly 43 base64url chars', () => {
    for (const bad of ['', 'x'.repeat(42), 'x'.repeat(44), `${'x'.repeat(42)}=`, `${'x'.repeat(42)}/`, null, 7]) {
      expect(looksLikeManageToken(bad)).toBe(false);
    }
  });
});
