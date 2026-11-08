import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from './types.js';
import { hostDaysCovering } from '../engine/local-time.js';
import type { AvailabilityInput, DateOverride, EventTypeSpec, LiveOccupancy, TimeWindow } from '../engine/slots.js';

export interface HostRef {
  id: string;
  slug: string;
  name: string;
  timezone: string;
}

export interface EventTypeRef extends EventTypeSpec {
  slug: string;
  name: string;
}

/**
 * Candidates near the range edges reach outside it by up to buffer_before (30 min) and
 * duration + buffer_after (150 min). One day of padding covers that with room to spare.
 * Computed in TS on UTC instants — SQL never does calendar/zone arithmetic (design §5.5).
 */
const OCCUPANCY_PAD_MS = 24 * 60 * 60 * 1000;

/**
 * Everything the slot engine needs for one host + event type over [from, to), including
 * `now` from Postgres. Live seats are counted from bookings (confirmed, or held and not yet
 * expired), so an expired-but-unswept hold never blocks a slot and the sweeper is not needed
 * for correctness (design §3, §6). `seats_taken` is used only as an index-friendly prefilter
 * (live ≤ stored always holds).
 *
 * Takes a Transaction (not a pool) on purpose: every query, including `now()`, must see the
 * same snapshot. The booking path calls it after taking the host lock, so `now` and the
 * occupancies are those of the locked transaction.
 */
export interface LoadOptions {
  /**
   * The clock to use. Write paths pass T = clock_timestamp() read AFTER taking their locks
   * (design §5.5); the lock-free read path omits it and gets now() of its snapshot.
   */
  now?: Date;
  /** false → skip the occupancy query (hold re-validation checks the RULES only). */
  withOccupancies?: boolean;
}

export async function loadAvailabilityInput(
  db: Transaction<DB>,
  host: HostRef,
  eventType: EventTypeSpec,
  range: { from: Date; to: Date },
  opts: LoadOptions = {},
): Promise<AvailabilityInput> {
  let now = opts.now;
  if (!now) {
    const { rows: [clock] } = await sql<{ now: Date }>`SELECT now() AS now`.execute(db);
    if (!clock) throw new Error('SELECT now() returned no row');
    now = clock.now;
  }

  const days = hostDaysCovering(range.from.getTime(), range.to.getTime(), host.timezone);
  const firstDay = days[0]!;
  const lastDay = days[days.length - 1]!;

  const [rules, overrideRows, windowRows, occRows] = await Promise.all([
    db.selectFrom('availability_rules')
      .select(['weekday', 'start_time', 'end_time'])
      .where('host_id', '=', host.id)
      .execute(),
    db.selectFrom('date_overrides')
      .select(['date', 'kind'])
      .where('host_id', '=', host.id)
      .where('date', '>=', firstDay)
      .where('date', '<=', lastDay)
      .execute(),
    db.selectFrom('date_override_windows')
      .select(['date', 'start_time', 'end_time'])
      .where('host_id', '=', host.id)
      .where('date', '>=', firstDay)
      .where('date', '<=', lastDay)
      .orderBy('start_time')
      .execute(),
    opts.withOccupancies === false ? Promise.resolve({ rows: [] }) : sql<{
      event_type_id: string; start_at: Date; end_at: Date;
      blocked_from: Date; blocked_to: Date; capacity: number; live_seats: number;
    }>`
      SELECT o.event_type_id, o.start_at, o.end_at,
             lower(o.blocked) AS blocked_from, upper(o.blocked) AS blocked_to, o.capacity,
             count(b.id) FILTER (
               WHERE b.status = 'confirmed' OR (b.status = 'held' AND b.expires_at > ${now}::timestamptz))::int AS live_seats
        FROM occupancies o
        LEFT JOIN bookings b ON b.occupancy_id = o.id
       WHERE o.host_id = ${host.id}
         AND o.seats_taken > 0
         AND o.blocked && tstzrange(${new Date(range.from.getTime() - OCCUPANCY_PAD_MS)}::timestamptz,
                                    ${new Date(range.to.getTime() + OCCUPANCY_PAD_MS)}::timestamptz, '[)')
       GROUP BY o.id
      HAVING count(b.id) FILTER (
               WHERE b.status = 'confirmed' OR (b.status = 'held' AND b.expires_at > ${now}::timestamptz)) > 0`.execute(db),
  ]);

  const windowsByDate = new Map<string, TimeWindow[]>();
  for (const w of windowRows) {
    const list = windowsByDate.get(w.date) ?? [];
    list.push({ start: w.start_time, end: w.end_time });
    windowsByDate.set(w.date, list);
  }
  const overrides = new Map<string, DateOverride>();
  for (const o of overrideRows) {
    overrides.set(o.date, o.kind === 'off' ? { kind: 'off' } : { kind: 'custom', windows: windowsByDate.get(o.date) ?? [] });
  }

  const occupancies: LiveOccupancy[] = occRows.rows.map((r) => ({
    eventTypeId: r.event_type_id,
    startAt: r.start_at,
    endAt: r.end_at,
    blockedFrom: r.blocked_from,
    blockedTo: r.blocked_to,
    liveSeats: r.live_seats,
    capacity: r.capacity,
  }));

  return {
    hostTz: host.timezone,
    weeklyRules: rules.map((r) => ({ weekday: r.weekday, start: r.start_time, end: r.end_time })),
    overrides,
    eventType,
    occupancies,
    now,
  };
}

export interface SlotContext {
  host: HostRef;
  eventType: EventTypeRef;
  input: AvailabilityInput;
}

/**
 * Public read path for GET …/slots: resolves an ACTIVE host + ACTIVE event type by slug
 * (deactivated ones → null → 404) and loads the engine input in one consistent snapshot.
 */
export async function loadSlotContext(
  db: Kysely<DB>,
  hostSlug: string,
  eventSlug: string,
  range: { from: Date; to: Date },
): Promise<SlotContext | null> {
  return db.transaction().setIsolationLevel('repeatable read').setAccessMode('read only').execute(async (trx) => {
    const row = await trx
      .selectFrom('event_types as e')
      .innerJoin('hosts as h', 'h.id', 'e.host_id')
      .select([
        'h.id as host_id', 'h.slug as host_slug', 'h.name as host_name', 'h.timezone',
        'e.id', 'e.slug', 'e.name', 'e.duration_min', 'e.capacity', 'e.buffer_before_min',
        'e.buffer_after_min', 'e.min_notice_min', 'e.horizon_days',
      ])
      .where('h.slug', '=', hostSlug)
      .where('h.active', '=', true)
      .where('e.slug', '=', eventSlug)
      .where('e.active', '=', true)
      .executeTakeFirst();
    if (!row) return null;

    const host: HostRef = { id: row.host_id, slug: row.host_slug, name: row.host_name, timezone: row.timezone };
    const eventType: EventTypeRef = {
      id: row.id,
      slug: row.slug,
      name: row.name,
      durationMin: row.duration_min,
      capacity: row.capacity,
      bufferBeforeMin: row.buffer_before_min,
      bufferAfterMin: row.buffer_after_min,
      minNoticeMin: row.min_notice_min,
      horizonDays: row.horizon_days,
    };
    return { host, eventType, input: await loadAvailabilityInput(trx, host, eventType, range) };
  });
}
