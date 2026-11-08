/**
 * Hold countdown that does not trust the browser's wall clock (design §5.5): the server
 * says how long is left (expires_at − server_now); we count that down on the monotonic
 * performance clock. A skewed Date.now() therefore cannot shorten or extend the hold on screen.
 */
export function deadlineFrom(expiresAtIso: string, serverNowIso: string, perfNow: number): number {
  return perfNow + Math.max(0, Date.parse(expiresAtIso) - Date.parse(serverNowIso));
}

export function remainingMs(deadline: number, perfNow: number): number {
  return Math.max(0, deadline - perfNow);
}

export function formatMmSs(ms: number): string {
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
