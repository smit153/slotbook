/**
 * Time-zone validation, shared by API and UI.
 *  - isKnownTimeZone: anything the runtime's Intl accepts, INCLUDING legacy aliases that
 *    browsers report (e.g. Chrome's "Asia/Calcutta"). Used for guest time zones.
 *  - isCanonicalTimeZone: in Intl.supportedValuesOf('timeZone') (canonical names only, plus
 *    UTC). Used for the host's home zone (Phase 6), so stored host zones are canonical.
 */
export function isKnownTimeZone(tz: string): boolean {
  if (!tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

let canonical: Set<string> | undefined;
export function isCanonicalTimeZone(tz: string): boolean {
  canonical ??= new Set([...Intl.supportedValuesOf('timeZone'), 'UTC']);
  return canonical.has(tz);
}
