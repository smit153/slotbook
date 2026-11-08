import type { BookingStatus } from '../db/types.js';

/**
 * The ONE status guard (design §4.1, §5.6). The database only checks data shape per status;
 * which moves are legal is decided here, and every write path asks this table first.
 *
 *   held ──confirm──► confirmed ──cancel──► cancelled
 *     └──timeout / release──► expired      (reschedule: confirmed → confirmed, new time)
 */
const ALLOWED: Record<BookingStatus, readonly BookingStatus[]> = {
  held: ['confirmed', 'expired'],
  confirmed: ['confirmed', 'cancelled'],
  cancelled: [],
  expired: [],
};

export class InvalidTransition extends Error {
  constructor(readonly from: BookingStatus, readonly to: BookingStatus) {
    super(`illegal booking transition ${from} → ${to}`);
  }
}

export function canTransition(from: BookingStatus, to: BookingStatus): boolean {
  return ALLOWED[from].includes(to);
}

export function assertTransition(from: BookingStatus, to: BookingStatus): void {
  if (!canTransition(from, to)) throw new InvalidTransition(from, to);
}
