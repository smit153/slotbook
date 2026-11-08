import { describe, expect, it } from 'vitest';
import { deriveHoldSecret, sha256, verifyHoldSecret } from '../../src/server/auth/secrets.js';

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
    expect(verifyHoldSecret(SECRET, ID, `${s.slice(0, -1)}A`)).toBe(s.endsWith('A'));
    for (const bad of ['', 'short', 'x'.repeat(500), null, undefined, 42, { s }]) {
      expect(verifyHoldSecret(SECRET, ID, bad)).toBe(false);
    }
  });

  it('sha256 gives 32 bytes (the size the bookings token-hash CHECK expects)', () => {
    expect(sha256('x')).toHaveLength(32);
  });
});
