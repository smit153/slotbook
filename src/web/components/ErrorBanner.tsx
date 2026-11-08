import { ApiError } from '../lib/api.js';

/** Friendly text for the API's error codes (design §7); falls back to the server message. */
const MESSAGES: Record<string, string> = {
  SLOT_UNAVAILABLE: 'Sorry — that time was just taken. Please pick another.',
  HOLD_EXPIRED: 'Your hold expired. Please pick a time again.',
  HOLD_LIMIT: 'You are holding too many times at once. Finish or wait a few minutes.',
  HOST_BUSY: 'This calendar is busy right now. Please try again in a moment.',
  TRY_AGAIN: 'That collided with another request. Please try again.',
  BOOKING_STARTED: 'This booking has already started, so it can no longer be changed.',
  ORIGIN_NOT_ALLOWED: 'This request came from an unexpected page. Reload and try again.',
  RATE_LIMITED: 'Too many attempts. Please wait a minute.',
};

export function errorText(err: unknown): string {
  if (err instanceof ApiError) return MESSAGES[err.code] ?? err.message;
  return err instanceof Error ? err.message : 'Something went wrong.';
}

export function ErrorBanner({ error }: { error: unknown }) {
  if (!error) return null;
  return <p className="banner error" role="alert">{errorText(error)}</p>;
}

export function Notice({ children }: { children: React.ReactNode }) {
  return <p className="banner notice" role="status">{children}</p>;
}
