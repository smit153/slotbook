import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { createHold, type HoldCreated } from '../../src/server/services/holds.js';
import { confirmHold, type Confirmed } from '../../src/server/services/confirm.js';
import { releaseHold } from '../../src/server/services/release.js';
import { manageTokenHash } from '../../src/server/auth/secrets.js';
import { seatsTaken, testDb, truncateAll } from '../helpers/db.js';
import { assertSeatInvariant } from '../helpers/invariants.js';
import { APP_SECRET, dbNow, holdRequest, scenario } from '../helpers/scenario.js';

const db = testDb({ max: 20 });
const deps = { db, appSecret: APP_SECRET };
afterAll(() => db.destroy());
beforeEach(() => truncateAll(db));
afterEach(() => assertSeatInvariant(db));

const guest = { name: 'Ada Lovelace', email: 'ada@example.test', tz: 'Europe/Berlin' };
const hold = async (sc: Awaited<ReturnType<typeof scenario>>) => (await createHold(deps, holdRequest(sc))).body as HoldCreated;
const confirmBody = (h: HoldCreated, o: Partial<typeof guest> = {}) => ({ hold_secret: h.hold_secret, ...guest, ...o });
const notifications = () => db.selectFrom('notifications').select(['type', 'payload']).orderBy('id').execute();
const statusOf = async (id: string) => (await db.selectFrom('bookings').select('status').where('id', '=', id).executeTakeFirstOrThrow()).status;
const expireNow = (id: string) => sql`UPDATE bookings SET expires_at = clock_timestamp() - interval '1 second' WHERE id = ${id}`.execute(db);

describe('confirm: happy path', () => {
  it('held → confirmed; manage token returned once, only its sha256 stored; one outbox row', async () => {
    const sc = await scenario(db);
    const h = await hold(sc);
    const res = await confirmHold(deps, h.hold_id, confirmBody(h, { email: '  Ada@Example.TEST ' }));

    expect(res.status).toBe(200);
    const { booking, manage_token } = res.body as Confirmed;
    expect(booking).toMatchObject({ id: h.hold_id, status: 'confirmed', guest_name: 'Ada Lovelace', guest_email: 'ada@example.test', guest_tz: 'Europe/Berlin' });
    expect(manage_token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const row = await db.selectFrom('bookings').select(['manage_token_hash', 'confirmed_at']).where('id', '=', h.hold_id).executeTakeFirstOrThrow();
    expect(row.manage_token_hash!.equals(manageTokenHash(manage_token))).toBe(true);

    const ns = await notifications();
    expect(ns).toHaveLength(1);
    expect(ns[0]!.type).toBe('booking.confirmed');
    expect(ns[0]!.payload).toMatchObject({ booking_id: h.hold_id, status: 'confirmed', guest_email: 'ada@example.test' });
    expect(JSON.stringify(ns[0]!.payload)).not.toContain(manage_token);

    const occ = await db.selectFrom('occupancies').select('id').executeTakeFirstOrThrow();
    expect(await seatsTaken(db, occ.id)).toBe(1);
  });

  it('accepts a browser alias time zone (Asia/Calcutta) and rejects nonsense', async () => {
    const sc = await scenario(db);
    const h = await hold(sc);
    expect((await confirmHold(deps, h.hold_id, confirmBody(h, { tz: 'Mars/Olympus' }))).status).toBe(400);
    expect((await confirmHold(deps, h.hold_id, confirmBody(h, { tz: 'Asia/Calcutta' }))).status).toBe(200);
  });

  it('validates guest details → 400', async () => {
    const sc = await scenario(db);
    const h = await hold(sc);
    for (const bad of [{ name: '   ' }, { email: 'not-an-email' }, { tz: '' }]) {
      expect((await confirmHold(deps, h.hold_id, confirmBody(h, bad))).status).toBe(400);
    }
    expect(await statusOf(h.hold_id)).toBe('held');
  });
});

describe('R9: the hold secret is required', () => {
  it('missing, wrong, or another hold’s secret, or an unknown id → 404; hold stays held', async () => {
    const sc = await scenario(db);
    const h = await hold(sc);
    const other = (await createHold(deps, holdRequest(sc, { startAt: new Date(sc.slot.getTime() + 30 * 60_000) }))).body as HoldCreated;

    expect((await confirmHold(deps, h.hold_id, { ...guest, hold_secret: other.hold_secret })).status).toBe(404);
    expect((await confirmHold(deps, h.hold_id, { ...guest, hold_secret: 'A'.repeat(43) })).status).toBe(404);
    expect((await confirmHold(deps, h.hold_id, { ...guest })).status).toBe(400);
    expect((await confirmHold(deps, '00000000-0000-4000-8000-000000000000', confirmBody(h))).status).toBe(404);
    expect(await statusOf(h.hold_id)).toBe('held');
  });
});

describe('R6: expiry is enforced at confirm time', () => {
  it('a hold that expired before confirm → 410; seat reusable at once (no sweeper)', async () => {
    const sc = await scenario(db);
    const h = await hold(sc);
    await expireNow(h.hold_id);

    expect(await confirmHold(deps, h.hold_id, confirmBody(h))).toMatchObject({ status: 410, body: { error: { code: 'HOLD_EXPIRED' } } });
    expect(await statusOf(h.hold_id)).toBe('expired');
    expect(await notifications()).toEqual([]);
    expect((await createHold(deps, holdRequest(sc))).status).toBe(201);
  });

  it('a hold that expires WHILE confirm waits for the host lock → 410, not confirmed', async () => {
    const sc = await scenario(db);
    const h = await hold(sc);
    await sql`UPDATE bookings SET expires_at = clock_timestamp() + interval '600 milliseconds' WHERE id = ${h.hold_id}`.execute(db);
    const { expires_at } = await db.selectFrom('bookings').select('expires_at').where('id', '=', h.hold_id).executeTakeFirstOrThrow();

    let release!: () => void;
    const released = new Promise<void>((r) => { release = r; });
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => { locked = r; });
    const blocker = db.transaction().execute(async (trx) => {
      await sql`SELECT id FROM hosts WHERE id = ${sc.hostId} FOR UPDATE`.execute(trx);
      locked();
      await released;
    });
    await isLocked;

    const pending = confirmHold(deps, h.hold_id, confirmBody(h)); // starts while the hold is valid
    await new Promise((r) => setTimeout(r, 100));
    expect((await dbNow(db)).getTime()).toBeLessThan(expires_at!.getTime());
    while ((await dbNow(db)).getTime() <= expires_at!.getTime() + 50) await new Promise((r) => setTimeout(r, 50));
    release();
    await blocker;

    expect((await pending).status).toBe(410);
    expect(await statusOf(h.hold_id)).toBe('expired');
  });

  it('a released hold cannot be confirmed → 410', async () => {
    const sc = await scenario(db);
    const h = await hold(sc);
    await releaseHold(deps, h.hold_id, { hold_secret: h.hold_secret });
    expect((await confirmHold(deps, h.hold_id, confirmBody(h))).status).toBe(410);
  });
});

describe('R15: confirm sent more than once', () => {
  it('sequential retry → same booking and token, replayed, still ONE notification', async () => {
    const sc = await scenario(db);
    const h = await hold(sc);
    const a = await confirmHold(deps, h.hold_id, confirmBody(h));
    const b = await confirmHold(deps, h.hold_id, confirmBody(h, { name: '  Ada Lovelace  ', email: 'ADA@example.test' }));
    expect(b).toMatchObject({ status: 200, replayed: true });
    expect((b.body as Confirmed).manage_token).toBe((a.body as Confirmed).manage_token);
    expect(await notifications()).toHaveLength(1);
  });

  it('5 concurrent confirms → all 200 with one token, exactly one real confirm, one notification', async () => {
    const sc = await scenario(db);
    const h = await hold(sc);
    const results = await Promise.all(Array.from({ length: 5 }, () => confirmHold(deps, h.hold_id, confirmBody(h))));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(new Set(results.map((r) => (r.body as Confirmed).manage_token)).size).toBe(1);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(await notifications()).toHaveLength(1);
  });

  it('different details → 409 ALREADY_CONFIRMED (no token)', async () => {
    const sc = await scenario(db);
    const h = await hold(sc);
    await confirmHold(deps, h.hold_id, confirmBody(h));
    const r = await confirmHold(deps, h.hold_id, confirmBody(h, { name: 'Someone Else' }));
    expect(r).toMatchObject({ status: 409, body: { error: { code: 'ALREADY_CONFIRMED' } } });
  });

  it('after the 15-minute replay window → 409', async () => {
    const sc = await scenario(db);
    const h = await hold(sc);
    await confirmHold(deps, h.hold_id, confirmBody(h));
    await sql`UPDATE bookings SET confirmed_at = confirmed_at - interval '16 minutes' WHERE id = ${h.hold_id}`.execute(db);
    expect((await confirmHold(deps, h.hold_id, confirmBody(h))).status).toBe(409);
  });

  it('a cancelled booking cannot be re-confirmed → 409', async () => {
    const sc = await scenario(db);
    const h = await hold(sc);
    await confirmHold(deps, h.hold_id, confirmBody(h));
    await sql`UPDATE bookings SET status = 'cancelled', cancelled_at = clock_timestamp(), cancelled_by = 'guest' WHERE id = ${h.hold_id}`.execute(db);
    expect(await confirmHold(deps, h.hold_id, confirmBody(h))).toMatchObject({ status: 409, body: { error: { code: 'INVALID_STATE' } } });
  });
});
