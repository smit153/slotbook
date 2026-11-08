import { sql } from 'kysely';
import type { Database } from '../../src/server/db/kysely.js';
import { createHold, type HoldCreated } from '../../src/server/services/holds.js';
import { confirmHold, type Confirmed } from '../../src/server/services/confirm.js';
import { deriveManageToken, manageTokenHash } from '../../src/server/auth/secrets.js';
import { createBooking, createOccupancy } from './db.js';
import { APP_SECRET, holdRequest, type Scenario } from './scenario.js';

export const GUEST = { name: 'Ada Lovelace', email: 'ada@example.test', tz: 'Europe/Berlin' };

/** hold → confirm through the services; returns the booking id and its manage token. */
export async function book(db: Database, sc: Scenario, o: { startAt?: Date } = {}): Promise<{ id: string; token: string; hold: HoldCreated }> {
  const deps = { db, appSecret: APP_SECRET };
  const h = await createHold(deps, holdRequest(sc, o.startAt ? { startAt: o.startAt } : {}));
  if (h.status !== 201) throw new Error(`hold failed: ${h.status} ${JSON.stringify(h.body)}`);
  const hold = h.body as HoldCreated;
  const c = await confirmHold(deps, hold.hold_id, { hold_secret: hold.hold_secret, ...GUEST });
  if (c.status !== 200) throw new Error(`confirm failed: ${c.status} ${JSON.stringify(c.body)}`);
  return { id: hold.hold_id, token: (c.body as Confirmed).manage_token, hold };
}

/**
 * A confirmed booking whose start is already in the past (created directly: the services
 * would never offer a past slot). Returns its id and a working manage token.
 */
export async function startedBooking(db: Database, sc: Scenario): Promise<{ id: string; token: string }> {
  const { rows } = await sql<{ t: Date }>`SELECT date_bin('30 minutes', clock_timestamp() - interval '2 hours', TIMESTAMPTZ '2000-01-01') AS t`.execute(db);
  const occ = await createOccupancy(db, sc.ev, rows[0]!.t.toISOString());
  const id = await createBooking(db, occ, sc.ev, 'confirmed');
  const token = deriveManageToken(APP_SECRET, id);
  await db.updateTable('bookings').set({ manage_token_hash: manageTokenHash(token) }).where('id', '=', id).execute();
  return { id, token };
}
