import { sql } from 'kysely';
import type { Database } from '../db/kysely.js';
import type { RateLimitCounter } from '../http/rate-limits.js';

/**
 * GET /metrics (Phase 12): Prometheus text exposition format 0.0.4, written by hand (no extra
 * dependency). Booking numbers are computed from the DATABASE at scrape time, so they are the
 * same whichever instance is scraped and survive restarts. Only the rate-limit counter is
 * per-process (the limiter itself is per-process).
 *
 * Notification lag: nothing delivers notifications yet (no dispatcher; see README Known gaps),
 * so "lag" = the age of the oldest undelivered notification, plus the pending count. That is
 * the number a dispatcher would bring down.
 */
const STATUSES = ['held', 'confirmed', 'cancelled', 'expired'] as const;
const EXPIRY_VIA = ['sweeper', 'hold', 'confirm', 'reschedule'] as const;

export interface MetricsSnapshot {
  bookings: Record<string, number>;
  holdsActive: number;
  expiries: Record<string, number>;
  released: number;
  notificationsPending: number;
  notificationLagSeconds: number;
}

export async function collectMetrics(db: Database): Promise<MetricsSnapshot> {
  // One read-only transaction = one snapshot and one clock for every number.
  return db.transaction().execute(async (trx) => {
    const byStatus = (await sql<{ status: string; n: number }>`
      SELECT status::text AS status, count(*)::int AS n FROM bookings GROUP BY status`.execute(trx)).rows;
    const active = (await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM bookings WHERE status = 'held' AND expires_at > clock_timestamp()`.execute(trx)).rows[0]!.n;
    const events = (await sql<{ type: string; via: string | null; n: number }>`
      SELECT type, payload->>'via' AS via, count(*)::int AS n FROM booking_events
       WHERE type IN ('expired', 'released') GROUP BY type, payload->>'via'`.execute(trx)).rows;
    // Both instants come from the database; the subtraction is done here (no SQL date maths,
    // per test/unit/no-sql-tz.test.ts).
    const notif = (await sql<{ pending: number; oldest: Date | null; now: Date }>`
      SELECT count(*)::int AS pending, min(created_at) AS oldest, clock_timestamp() AS now
        FROM notifications WHERE delivered_at IS NULL`.execute(trx)).rows[0]!;
    const lagSeconds = notif.oldest ? (notif.now.getTime() - notif.oldest.getTime()) / 1000 : 0;

    const bookings = Object.fromEntries(STATUSES.map((s) => [s, byStatus.find((r) => r.status === s)?.n ?? 0]));
    const expiries: Record<string, number> = Object.fromEntries(EXPIRY_VIA.map((v) => [v, 0]));
    let released = 0;
    for (const e of events) {
      if (e.type === 'released') released += e.n;
      else expiries[e.via ?? 'unknown'] = (expiries[e.via ?? 'unknown'] ?? 0) + e.n;
    }
    return { bookings, holdsActive: active, expiries, released, notificationsPending: notif.pending, notificationLagSeconds: Math.max(0, lagSeconds) };
  });
}

const label = (v: string) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');

export function renderMetrics(m: MetricsSnapshot, rateLimited: RateLimitCounter): string {
  const out: string[] = [];
  const metric = (name: string, type: 'gauge' | 'counter', help: string, samples: Array<[Record<string, string>, number]>) => {
    out.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
    for (const [labels, value] of samples) {
      const l = Object.entries(labels).map(([k, v]) => `${k}="${label(v)}"`).join(',');
      out.push(`${name}${l ? `{${l}}` : ''} ${Number.isInteger(value) ? value : value.toFixed(3)}`);
    }
  };
  metric('slotbook_bookings', 'gauge', 'Bookings by status (all time; bookings are append-only).',
    Object.entries(m.bookings).map(([status, n]) => [{ status }, n]));
  metric('slotbook_holds_active', 'gauge', 'Holds that have not expired yet (database clock).', [[{}, m.holdsActive]]);
  metric('slotbook_hold_expiries_total', 'counter', 'Holds that expired, by what expired them (from the audit table).',
    Object.entries(m.expiries).map(([via, n]) => [{ via }, n]));
  metric('slotbook_holds_released_total', 'counter', 'Holds given back early by the guest (release).', [[{}, m.released]]);
  metric('slotbook_notifications_pending', 'gauge', 'Notifications written but not delivered.', [[{}, m.notificationsPending]]);
  metric('slotbook_notification_lag_seconds', 'gauge', 'Age of the oldest undelivered notification (0 if none).', [[{}, m.notificationLagSeconds]]);
  metric('slotbook_rate_limited_total', 'counter', 'Requests refused by a per-IP rate limit since this process started.',
    rateLimited.snapshot().map(([route, n]) => [{ route }, n]));
  return `${out.join('\n')}\n`;
}
