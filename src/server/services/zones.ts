import { IANAZone } from 'luxon';
import { isAcceptedTimeZone } from '../../shared/timezones.js';

/** Intl ∧ Luxon (design §6). */
export function acceptZone(tz: unknown): tz is string {
  return isAcceptedTimeZone(tz, (z) => IANAZone.isValidZone(z));
}
