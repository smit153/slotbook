import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from './types.js';

export interface SessionSpec {
  hostId: string;
  eventTypeId: string;
  startAt: Date;
  endAt: Date;
  bufferBeforeMin: number;
  bufferAfterMin: number;
  capacity: number;
}

export interface OccupancyRef {
  id: string;
  /** The session's (possibly snapshotted) times — bookings must copy these. */
  startAt: Date;
  endAt: Date;
  capacity: number;
}

/**
 * Find-or-create the occupancy for (event type, start) with the refresh-on-zero rule
 * (design §5.1): a session that currently has 0 seats is overwritten with the event
 * type's current end, buffers and capacity; a live session (≥1 seat) keeps its snapshot.
 *
 * This only prepares the row. Claiming a seat is the bookings INSERT/UPDATE, whose trigger
 * bumps seats_taken and so fires the overlap/capacity constraints. Callers hold the host
 * lock (design §5.1) — this function takes none itself.
 */
export async function upsertOccupancy(db: Kysely<DB> | Transaction<DB>, s: SessionSpec): Promise<OccupancyRef> {
  const blocked = sql`tstzrange(
      ${s.startAt}::timestamptz - make_interval(mins => ${s.bufferBeforeMin}::int),
      ${s.endAt}::timestamptz + make_interval(mins => ${s.bufferAfterMin}::int),
      '[)')`;

  const upserted = await sql<{ id: string; start_at: Date; end_at: Date; capacity: number }>`
    INSERT INTO occupancies (host_id, event_type_id, start_at, end_at, blocked, capacity)
    VALUES (${s.hostId}, ${s.eventTypeId}, ${s.startAt}, ${s.endAt}, ${blocked}, ${s.capacity})
    ON CONFLICT ON CONSTRAINT occupancies_event_slot_unique DO UPDATE
       SET end_at = EXCLUDED.end_at,
           blocked = EXCLUDED.blocked,
           capacity = EXCLUDED.capacity,
           updated_at = now()
     WHERE occupancies.seats_taken = 0
    RETURNING id, start_at, end_at, capacity
  `.execute(db);

  let row = upserted.rows[0];
  if (!row) {
    // Conflict with a live session: keep its snapshot.
    row = await db
      .selectFrom('occupancies')
      .select(['id', 'start_at', 'end_at', 'capacity'])
      .where('event_type_id', '=', s.eventTypeId)
      .where('start_at', '=', s.startAt)
      .executeTakeFirstOrThrow();
  }
  return { id: row.id, startAt: row.start_at, endAt: row.end_at, capacity: row.capacity };
}
