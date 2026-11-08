import { sql } from 'kysely';
import type { Database } from '../db/kysely.js';
import { upsertOccupancy } from '../db/occupancies.js';
import { loadSlotContext } from '../db/slot-inputs.js';
import { findOfferedSlot } from '../engine/slots.js';
import { deriveHoldSecret } from '../auth/secrets.js';
import { holdRequestSchema } from '../../shared/schemas.js';
import { failure, type ServiceResult } from './errors.js';

export interface HoldDeps {
  db: Database;
  appSecret: string;
}

export interface HoldRequest {
  host: string;
  slug: string;
  start_at: string;
  clientIp: string;
  idempotencyKey: string;
}

export interface HoldCreated {
  hold_id: string;
  hold_secret: string;
  expires_at: string;
  start_at: string;
  end_at: string;
}

/**
 * NAIVE first version (Phase 4, red commit): check availability, then insert.
 * No host lock and no mapping of constraint violations — kept only to show the
 * concurrency test failing before the real implementation replaces it.
 */
export async function createHold(deps: HoldDeps, req: HoldRequest): Promise<ServiceResult<HoldCreated>> {
  const parsed = holdRequestSchema.safeParse(req);
  if (!parsed.success) return failure(400, 'VALIDATION', parsed.error.message);
  const startAt = new Date(parsed.data.start_at);

  const ctx = await loadSlotContext(deps.db, req.host, req.slug, { from: startAt, to: new Date(startAt.getTime() + 1) });
  if (!ctx) return failure(404, 'NOT_FOUND', 'Unknown host or event type');
  const slot = findOfferedSlot(ctx.input, startAt);
  if (!slot) return failure(422, 'SLOT_NOT_OFFERED', 'That time is not offered');

  return deps.db.transaction().execute(async (trx) => {
    const occ = await upsertOccupancy(trx, {
      hostId: ctx.host.id, eventTypeId: ctx.eventType.id, startAt, endAt: slot.endAt,
      bufferBeforeMin: ctx.eventType.bufferBeforeMin, bufferAfterMin: ctx.eventType.bufferAfterMin,
      capacity: ctx.eventType.capacity,
    });
    const b = await trx.insertInto('bookings').values({
      host_id: ctx.host.id, event_type_id: ctx.eventType.id, occupancy_id: occ.id, status: 'held',
      start_at: occ.startAt, end_at: occ.endAt, expires_at: sql<Date>`now() + interval '5 minutes'`,
      client_ip: req.clientIp,
    }).returning(['id', 'expires_at']).executeTakeFirstOrThrow();
    return {
      status: 201,
      body: {
        hold_id: b.id, hold_secret: deriveHoldSecret(deps.appSecret, b.id), expires_at: b.expires_at!.toISOString(),
        start_at: occ.startAt.toISOString(), end_at: occ.endAt.toISOString(),
      },
    };
  });
}
