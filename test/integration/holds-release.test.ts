import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { createHold, type HoldCreated } from '../../src/server/services/holds.js';
import { releaseHold } from '../../src/server/services/release.js';
import { seatsTaken, testDb, truncateAll } from '../helpers/db.js';
import { assertSeatInvariant } from '../helpers/invariants.js';
import { APP_SECRET, holdRequest, scenario, type Scenario } from '../helpers/scenario.js';

const db = testDb();
const deps = { db, appSecret: APP_SECRET };
afterAll(() => db.destroy());
beforeEach(() => truncateAll(db));
afterEach(() => assertSeatInvariant(db));

const IP = '203.0.113.50';
const nth = (sc: Scenario, i: number) => new Date(sc.slot.getTime() + i * 30 * 60_000);
const hold = async (sc: Scenario, o: Parameters<typeof holdRequest>[1] = {}) => (await createHold(deps, holdRequest(sc, o))).body as HoldCreated;
const status = async (id: string) => (await db.selectFrom('bookings').select('status').where('id', '=', id).executeTakeFirstOrThrow()).status;

describe('hold release', () => {
  it('hold 3, release 1, a 4th hold from the same IP succeeds (the cap counts live holds only)', async () => {
    const sc = await scenario(db);
    const holds = [];
    for (let i = 0; i < 3; i++) holds.push(await hold(sc, { ip: IP, startAt: nth(sc, i) }));
    expect((await createHold(deps, holdRequest(sc, { ip: IP, startAt: nth(sc, 3) }))).status).toBe(429);

    const r = await releaseHold(deps, holds[0]!.hold_id, { hold_secret: holds[0]!.hold_secret });
    expect(r).toMatchObject({ status: 200, body: { status: 'expired' } });
    expect((await createHold(deps, holdRequest(sc, { ip: IP, startAt: nth(sc, 3) }))).status).toBe(201);
  });

  it('frees the seat immediately: the same slot can be held again right away', async () => {
    const sc = await scenario(db, { capacity: 1 });
    const h = await hold(sc);
    expect((await createHold(deps, holdRequest(sc))).status).toBe(409);
    await releaseHold(deps, h.hold_id, { hold_secret: h.hold_secret });
    const occ = await db.selectFrom('occupancies').select('id').executeTakeFirstOrThrow();
    expect(await seatsTaken(db, occ.id)).toBe(0);
    expect((await createHold(deps, holdRequest(sc))).status).toBe(201);
  });

  it('needs the hold secret: wrong/missing secret or unknown id → 404, hold untouched', async () => {
    const sc = await scenario(db);
    const h = await hold(sc);
    const other = await hold(sc, { startAt: nth(sc, 1) });
    expect((await releaseHold(deps, h.hold_id, { hold_secret: other.hold_secret })).status).toBe(404);
    expect((await releaseHold(deps, h.hold_id, { hold_secret: 'nope' })).status).toBe(404);
    expect((await releaseHold(deps, 'not-a-uuid', { hold_secret: h.hold_secret })).status).toBe(404);
    expect((await releaseHold(deps, h.hold_id, {})).status).toBe(400);
    expect(await status(h.hold_id)).toBe('held');
  });

  it('is idempotent: releasing twice is 200 both times, with one audit event', async () => {
    const sc = await scenario(db);
    const h = await hold(sc);
    expect((await releaseHold(deps, h.hold_id, { hold_secret: h.hold_secret })).status).toBe(200);
    expect((await releaseHold(deps, h.hold_id, { hold_secret: h.hold_secret })).status).toBe(200);
    const events = await db.selectFrom('booking_events').select('type').where('booking_id', '=', h.hold_id).execute();
    expect(events).toEqual([{ type: 'released' }]);
  });

  it('a hold that already timed out (unswept) can be released → expired', async () => {
    const sc = await scenario(db);
    const h = await hold(sc);
    await sql`UPDATE bookings SET expires_at = clock_timestamp() - interval '1 second' WHERE id = ${h.hold_id}`.execute(db);
    expect((await releaseHold(deps, h.hold_id, { hold_secret: h.hold_secret })).status).toBe(200);
    expect(await status(h.hold_id)).toBe('expired');
  });

  it('a confirmed booking cannot be released (cancel instead) → 409', async () => {
    const sc = await scenario(db);
    const h = await hold(sc);
    await sql`UPDATE bookings SET status = 'confirmed', guest_name = 'G', guest_email = 'g@x.test',
                manage_token_hash = sha256(id::text::bytea), confirmed_at = clock_timestamp() WHERE id = ${h.hold_id}`.execute(db);
    expect(await releaseHold(deps, h.hold_id, { hold_secret: h.hold_secret })).toMatchObject({ status: 409, body: { error: { code: 'INVALID_STATE' } } });
    expect(await status(h.hold_id)).toBe('confirmed');
  });
});
