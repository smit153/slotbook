import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Guest bearer secrets are DERIVED, never stored (design §5.0):
 *   hold_secret  = b64url(HMAC-SHA256(APP_SECRET, "hold:v1:"   || booking_id))
 *   manage_token = b64url(HMAC-SHA256(APP_SECRET, "manage:v1:" || booking_id))   (Phase 5)
 * A DB dump alone yields nothing usable; replays re-derive instead of reading plaintext.
 */
function hmac(appSecret: string, message: string): Buffer {
  return createHmac('sha256', appSecret).update(message, 'utf8').digest();
}

export function deriveHoldSecret(appSecret: string, bookingId: string): string {
  return hmac(appSecret, `hold:v1:${bookingId}`).toString('base64url');
}

/** Constant-time check of a guest-supplied hold secret. Never throws. */
export function verifyHoldSecret(appSecret: string, bookingId: string, candidate: unknown): boolean {
  if (typeof candidate !== 'string' || candidate.length === 0 || candidate.length > 128) return false;
  const expected = hmac(appSecret, `hold:v1:${bookingId}`);
  const given = Buffer.from(candidate, 'base64url');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export function sha256(data: string | Buffer): Buffer {
  return createHash('sha256').update(data).digest();
}

/** manage_token = b64url(HMAC-SHA256(APP_SECRET, "manage:v1:" || booking_id)) — never stored. */
export function deriveManageToken(appSecret: string, bookingId: string): string {
  return hmac(appSecret, `manage:v1:${bookingId}`).toString('base64url');
}

/** What the database stores and looks up by: sha256 of the token string (32 bytes). */
export function manageTokenHash(token: string): Buffer {
  return sha256(token);
}

/** A manage token is 32 HMAC bytes in base64url: exactly 43 url-safe characters. */
export function looksLikeManageToken(token: unknown): token is string {
  return typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token);
}
