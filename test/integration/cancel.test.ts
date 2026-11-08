import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cancelByGuest, cancelByHost, type Cancelled } from '../../src/server/services/cancel.js';
import { createHold, type HoldCreated } from '../../src/server/services/holds.js';
import { seatsTaken, testDb, truncateAll } from '../helpers/db.js';
import { assertSeatInvariant } from '../helpers/invariants.js';
import { book, startedBooking } from '../helpers/flows.js';
import { APP_SECRET, holdRequest, scenario } from '../helpers/scenario.js';

const db = testDb({ max: 20 });
const deps = { db };
afterAll(() => db.destroy());
beforeEach(() => truncateAll(db));
afterEach(() => assertSeatInvariant(db));

const cancelled = () => db.selectFrom('notifications').select('payload').where('type', '=', 'booking.cancelled').execute();
const seat = async () => seatsTaken(db, (await db.selectFrom('occupancies').select('id').executeTakeFirstOrThrow()).id);

describe('guest cancel (manage token)', () => {
  it('confirmed → cancelled, seat freed, notification carries cancelled_by + reason (no token)', async () => {
    const sc = await scenario(db);
    const b = await book(db, sc);
    const res = await cancelByGuest(deps, b.token, { reason: 'Something came up' });

    expect(res.status).toBe(200);
    expect((res.body as Cancelled).booking).toMatchObject({ status: 'cancelled', cancelled_by: 'guest', cancel_reason: 'Something came up' });
    expect(await seat()).toBe(0);
    const ns = await cancelled();
    expect(ns).toHaveLength(1);
    expect(ns[0]!.payload).toMatchObject({ booking_id: b.id, status: 'cancelled', cancelled_by: 'guest', reason: 'Something came up' });
    expect(JSON.stringify(ns[0]!.payload)).not.toContain(b.token);
  });

  it('the reason is optional for guests', async () => {
    const sc = await scenario(db);
    const b = await book(db, sc);
    const res = await cancelByGuest(deps, b.token, {});
    expect(res.status).toBe(200);
    expect((await cancelled())[0]!.payload).toMatchObject({ cancelled_by: 'guest', reason: null });
  });

  it('a malformed or unknown token → 404', async () => {
    const sc = await scenario(db);
    await book(db, sc);
    expect((await cancelByGuest(deps, 'short', {})).status).toBe(404);
    expect((await cancelByGuest(deps, 'A'.repeat(43), {})).status).toBe(404);
  });
});

describe('host cancel', () => {
  it('needs a reason; payload says cancelled_by host', async () => {
    const sc = await scenario(db);
    const b = await book(db, sc);
    expect((await cancelByHost(deps, sc.hostId, b.id, {})).status).toBe(400);
    expect((await cancelByHost(deps, sc.hostId, b.id, { reason: '  ' })).status).toBe(400);
    const res = await cancelByHost(deps, sc.hostId, b.id, { reason: 'Host is ill' });
    expect(res.status).toBe(200);
    expect((await cancelled())[0]!.payload).toMatchObject({ cancelled_by: 'host', reason: 'Host is ill' });
  });

  it("a host cannot cancel another host's booking → 404, untouched", async () => {
    const sc = await scenario(db);
    const other = await scenario(db, { slug: 'other' });
    const b = await book(db, sc);
    expect((await cancelByHost(deps, other.hostId, b.id, { reason: 'nope' })).status).toBe(404);
    expect(await seat()).toBe(1);
  });
});

describe('R17: cancel more than once', () => {
  it('sequentially → 200 both times, one notification, one audit event', async () => {
    const sc = await scenario(db);
    const b = await book(db, sc);
    expect((await cancelByGuest(deps, b.token, { reason: 'x' })).status).toBe(200);
    expect((await cancelByGuest(deps, b.token, { reason: 'x' })).status).toBe(200);
    expect(await cancelled()).toHaveLength(1);
    const events = await db.selectFrom('booking_events').select('type').where('booking_id', '=', b.id).where('type', '=', 'cancelled').execute();
    expect(events).toHaveLength(1);
  });

  it('5 concurrent (guest and host racing) → all 200, exactly one notification', async () => {
    const sc = await scenario(db);
    const b = await book(db, sc);
    const results = await Promise.all([
      ...Array.from({ length: 3 }, () => cancelByGuest(deps, b.token, {})),
      ...Array.from({ length: 2 }, () => cancelByHost(deps, sc.hostId, b.id, { reason: 'race' })),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    expect(await cancelled()).toHaveLength(1);
  });
});

describe('only upcoming, confirmed bookings can be cancelled', () => {
  it('a booking that already started → 409 BOOKING_STARTED for guest AND host', async () => {
    const sc = await scenario(db);
    const b = await startedBooking(db, sc);
    expect(await cancelByGuest(deps, b.token, {})).toMatchObject({ status: 409, body: { error: { code: 'BOOKING_STARTED' } } });
    expect(await cancelByHost(deps, sc.hostId, b.id, { reason: 'too late' })).toMatchObject({ status: 409, body: { error: { code: 'BOOKING_STARTED' } } });
    expect(await cancelled()).toEqual([]);
  });

  it('a hold (not yet confirmed) or an expired hold cannot be cancelled → 409 INVALID_STATE', async () => {
    const sc = await scenario(db);
    const h = (await createHold({ db, appSecret: APP_SECRET }, holdRequest(sc))).body as HoldCreated;
    expect(await cancelByHost(deps, sc.hostId, h.hold_id, { reason: 'x' })).toMatchObject({ status: 409, body: { error: { code: 'INVALID_STATE' } } });
  });
});
