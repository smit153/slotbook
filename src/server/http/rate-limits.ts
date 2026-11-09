import type { RateLimitOptions } from '@fastify/rate-limit';

/**
 * Per-IP limits for every public endpoint (abuse protection, Phase 12), requests per minute.
 * The key is request.ip, so the same TRUST_PROXY hop rule as the per-IP hold cap applies and
 * X-Forwarded-For cannot be spoofed. Over the limit: 429 RATE_LIMITED + Retry-After (the error
 * handler shapes the body). RATE_LIMIT_MULTIPLIER scales every limit (the k6 setup uses 1000).
 * The counts live in this process's memory: with several instances each keeps its own.
 */
export const RATE_LIMITS = {
  eventInfo: 60,
  slots: 60,
  slotStream: 30, // opening the live-updates stream (Phase 14); concurrent streams are capped separately
  hold: 20,
  release: 30,
  confirm: 20,
  bookingView: 30,
  reschedule: 20,
  cancel: 20,
  waitlistJoin: 10,
  waitlistView: 60, // the waitlist page polls; Phase 14 pushes changes instead
  waitlistClaim: 20,
  waitlistLeave: 20,
  login: 10,
} as const;
export type LimitName = keyof typeof RATE_LIMITS;

/** How many requests each limit refused, since this process started (for /metrics). */
export class RateLimitCounter {
  private readonly counts = new Map<LimitName, number>();
  inc(name: LimitName): void { this.counts.set(name, (this.counts.get(name) ?? 0) + 1); }
  snapshot(): Array<[LimitName, number]> { return [...this.counts.entries()].sort(([a], [b]) => a.localeCompare(b)); }
}

export function limitFor(name: LimitName, multiplier: number, counter: RateLimitCounter): RateLimitOptions {
  return {
    max: RATE_LIMITS[name] * multiplier,
    timeWindow: '1 minute',
    onExceeded: () => counter.inc(name),
  };
}
