import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import { createHold, type HoldCreated } from '../../src/server/services/holds.js';
import { confirmHold, type Confirmed } from '../../src/server/services/confirm.js';
import { rescheduleBooking } from '../../src/server/services/reschedule.js';
import { cancelByGuest, cancelByHost } from '../../src/server/services/cancel.js';
import { releaseHold } from '../../src/server/services/release.js';
import { testDb, truncateAll } from '../helpers/db.js';
import { assertSeatInvariant } from '../helpers/invariants.js';
import { book, GUEST } from '../helpers/flows.js';
import { APP_SECRET, holdRequest, scenario, type Scenario } from '../helpers/scenario.js';

const db = testDb({ max: 10 });
const deps = { db, appSecret: APP_SECRET };
afterAll(() => db.destroy());
beforeEach(() => truncateAll(db));
afterEach(async () => {
  vi.useRealTimers();
  await assertSeatInvariant(db);
});

const MIN = 60_000;
const at = (sc: Scenario, minutes: number) => new Date(sc.slot.getTime() + minutes * MIN);

/** A full guest journey; returns only clock-independent facts. */
async function journey(slug: string) {
  const sc = await scenario(db, { slug });
  const h = await createHold(deps, holdRequest(sc));
  const hb = h.body as HoldCreated;
  const ttl = new Date(hb.expires_at).getTime() - new Date(hb.server_now).getTime();
  const c = await confirmHold(deps, hb.hold_id, { hold_secret: hb.hold_secret, ...GUEST });
  const token = (c.body as Confirmed).manage_token;
  const r = await rescheduleBooking(deps, token, { start_at: at(sc, 60).toISOString() });
  const x = await cancelByGuest(deps, token, { reason: 'skew test' });

  const h2 = (await createHold(deps, holdRequest(sc, { startAt: at(sc, 120) }))).body as HoldCreated;
  await sql`UPDATE bookings SET expires_at = clock_timestamp() - interval '1 second' WHERE id = ${h2.hold_id}`.execute(db);
  const late = await confirmHold(deps, h2.hold_id, { hold_secret: h2.hold_secret, ...GUEST });

  return { statuses: [h.status, c.status, r.status, x.status, late.status], ttl };
}

describe('R14: the app server clock is not trusted', () => {
  it.each([
    ['one year ahead', 365],
    ['one year behind', -365],
  ])('a whole journey behaves identically with the process clock skewed %s', async (_label, days) => {
    const reference = await journey('ref');
    expect(reference).toEqual({ statuses: [201, 200, 200, 200, 410], ttl: 5 * MIN });

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(Date.now() + days * 24 * 60 * MIN));
    expect(await journey('skewed')).toEqual(reference);
  });
});

describe('R20: no guest secret is ever stored', () => {
  it('neither the hold secret nor the manage token appears in any table after a full lifecycle', async () => {
    const sc = await scenario(db);
    const h = (await createHold(deps, holdRequest(sc))).body as HoldCreated;
    const c = (await confirmHold(deps, h.hold_id, { hold_secret: h.hold_secret, ...GUEST })).body as Confirmed;
    await rescheduleBooking(deps, c.manage_token, { start_at: at(sc, 60).toISOString() });
    await cancelByGuest(deps, c.manage_token, { reason: 'r20' });

    for (const secret of [h.hold_secret, c.manage_token]) {
      const { rows } = await sql<{ t: string }>`
        SELECT 'bookings' AS t FROM bookings x WHERE x::text LIKE ${'%' + secret + '%'}
        UNION ALL SELECT 'idempotency_keys' FROM idempotency_keys x WHERE x::text LIKE ${'%' + secret + '%'}
        UNION ALL SELECT 'notifications' FROM notifications x WHERE x::text LIKE ${'%' + secret + '%'}
        UNION ALL SELECT 'booking_events' FROM booking_events x WHERE x::text LIKE ${'%' + secret + '%'}
        UNION ALL SELECT 'occupancies' FROM occupancies x WHERE x::text LIKE ${'%' + secret + '%'}`.execute(db);
      expect(rows).toEqual([]);
    }
    expect(await db.selectFrom('notifications').select('type').orderBy('id').execute())
      .toEqual([{ type: 'booking.confirmed' }, { type: 'booking.rescheduled' }, { type: 'booking.cancelled' }]);
  });
});

describe('R27: host edits after a booking exists', () => {
  it('removing all availability and changing the host time zone leave the booking (UTC) intact and cancellable', async () => {
    const sc = await scenario(db);
    const b = await book(db, sc);
    await db.deleteFrom('availability_rules').where('host_id', '=', sc.hostId).execute();
    await db.updateTable('hosts').set({ timezone: 'Europe/Berlin' }).where('id', '=', sc.hostId).execute();

    const row = await db.selectFrom('bookings').select(['status', 'start_at']).where('id', '=', b.id).executeTakeFirstOrThrow();
    expect(row).toEqual({ status: 'confirmed', start_at: sc.slot });
    expect((await cancelByGuest({ db }, b.token, {})).status).toBe(200);
  });
});

describe('every write path: lock_timeout → 503, deadlock → one retry', () => {
  async function withHostLocked<T>(hostId: string, fn: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const released = new Promise<void>((r) => { release = r; });
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => { locked = r; });
    const blocker = db.transaction().execute(async (trx) => {
      await sql`SELECT id FROM hosts WHERE id = ${hostId} FOR UPDATE`.execute(trx);
      locked();
      await released;
    });
    await isLocked;
    try {
      return await fn();
    } finally {
      release();
      await blocker;
    }
  }

  it('confirm, release, reschedule and both cancels give 503 HOST_BUSY and change nothing', async () => {
    const sc = await scenario(db);
    const b = await book(db, sc, { startAt: at(sc, 60) });
    const h = (await createHold(deps, holdRequest(sc))).body as HoldCreated;
    const fast = { db, appSecret: APP_SECRET, lockTimeoutMs: 200 };

    const results = await withHostLocked(sc.hostId, async () => [
      await confirmHold(fast, h.hold_id, { hold_secret: h.hold_secret, ...GUEST }),
      await releaseHold(fast, h.hold_id, { hold_secret: h.hold_secret }),
      await rescheduleBooking(fast, b.token, { start_at: at(sc, 120).toISOString() }),
      await cancelByGuest(fast, b.token, {}),
      await cancelByHost(fast, sc.hostId, b.id, { reason: 'x' }),
    ]);
    for (const r of results) expect(r).toMatchObject({ status: 503, body: { error: { code: 'HOST_BUSY' } } });

    const rows = Object.fromEntries((await db.selectFrom('bookings').select(['id', 'status']).execute()).map((r) => [r.id, r.status]));
    expect(rows).toEqual({ [b.id]: 'confirmed', [h.hold_id]: 'held' });
  });

  it('a deadlock during confirm is retried once and confirms exactly once', async () => {
    const sc = await scenario(db);
    const h = (await createHold(deps, holdRequest(sc))).body as HoldCreated;
    const attempts: number[] = [];
    const res = await confirmHold({
      ...deps,
      faults: { onAttempt: (n) => { attempts.push(n); if (n === 1) throw Object.assign(new Error('deadlock'), { code: '40P01' }); } },
    }, h.hold_id, { hold_secret: h.hold_secret, ...GUEST });
    expect(res.status).toBe(200);
    expect(attempts).toEqual([1, 2]);
    expect(await db.selectFrom('notifications').selectAll().execute()).toHaveLength(1);
  });
});
