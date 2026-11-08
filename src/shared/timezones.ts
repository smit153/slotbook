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

/**
 * The rule for host, guest and ?tz= zones (design §6, decided after Phase 5): accepted if BOTH
 * the runtime's Intl and Luxon accept it. The exact string is stored. Pass Luxon's
 * IANAZone.isValidZone in (keeps this module free of a Luxon import for callers that don't need it).
 */
export function isAcceptedTimeZone(tz: unknown, luxonIsValid: (z: string) => boolean): tz is string {
  return typeof tz === 'string' && isKnownTimeZone(tz) && luxonIsValid(tz);
}

/** Zones for pickers: Intl's list plus modern names some ICU builds only know as aliases. */
export function timeZoneChoices(): string[] {
  const extra = ['UTC', 'Asia/Kolkata', 'Europe/Kyiv', 'America/Nuuk', 'Pacific/Kanton'];
  return [...new Set([...Intl.supportedValuesOf('timeZone'), ...extra.filter(isKnownTimeZone)])].sort();
}
