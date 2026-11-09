import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { testDb, truncateAll } from '../helpers/db.js';
import { assertSeatInvariant } from '../helpers/invariants.js';
import { book } from '../helpers/flows.js';
import { APP_SECRET, freshIp, holdRequest, scenario, type Scenario } from '../helpers/scenario.js';
import { createHold, type HoldCreated } from '../../src/server/services/holds.js';
import { cancelByGuest } from '../../src/server/services/cancel.js';
import { runSweepOnce } from '../../src/server/workers/sweeper.js';
import { rescheduleBooking } from '../../src/server/services/reschedule.js';
import {
  claimOffer, joinWaitlist, leaveWaitlist, waitlistStatus, OFFER_TTL_MIN, WAITLIST_CAP, WAITLIST_IP_CAP, type Joined,
} from '../../src/server/services/waitlist.js';

/**
 * Waitlist (design §13), written before the implementation. W1–W4 are the race tests from the
 * design; the rest pin the rules. The seat invariant, extended to offers (§13.8), runs after each.
 */
const db = testDb({ max: 30 });
const deps = { db, appSecret: APP_SECRET, lockTimeoutMs: 30_000 };
afterAll(() => db.destroy());
beforeEach(() => truncateAll(db));
afterEach(() => assertSeatInvariant(db));

let n = 0;
async function join(sc: Scenario, o: Partial<{ email: string; ip: string; startAt: Date; key: string; name: string }> = {}) {
  n += 1;
  return joinWaitlist(deps, {
    host: sc.hostSlug, slug: sc.ev.slug, start_at: (o.startAt ?? sc.slot).toISOString(),
    name: o.name ?? `Waiter ${n}`, email: o.email ?? `waiter${n}@example.test`, tz: 'Europe/Berlin',
    clientIp: o.ip ?? freshIp(), idempotencyKey: o.key ?? `wl-key-${n}-${Date.now()}`,
  });
}
const joined = async (sc: Scenario, o?: Parameters<typeof join>[1]) => {
  const r = await join(sc, o);
  expect(r.status).toBe(201);
  return r.body as Joined;
};
const entry = (id: string) => db.selectFrom('waitlist_entries').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
const offerOf = (id: string) => db.selectFrom('bookings').selectAll().where('waitlist_entry_id', '=', id).executeTakeFirst();
const expireOffer = (entryId: string) =>
  sql`UPDATE bookings SET expires_at = clock_timestamp() - interval '1 second' WHERE waitlist_entry_id = ${entryId}`.execute(db);
const publicHold = (sc: Scenario, startAt = sc.slot) => createHold(deps, holdRequest(sc, { startAt }));

describe('race tests (design §13.9)', () => {
  it('W1: a cancel racing 20 public holds for the freed seat: the waitlisted guest always wins', async () => {
    const sc = await scenario(db, { capacity: 1 });
    const b = await book(db, sc);
    const w = await joined(sc);
    const results = await Promise.all([
      cancelByGuest(deps, b.token, {}),
      ...Array.from({ length: 20 }, () => publicHold(sc)),
    ]);
    expect(results[0]!.status).toBe(200);
    expect(results.slice(1).filter((r) => r.status === 201)).toHaveLength(0);
    expect((await entry(w.entry_id)).status).toBe('offered');
    const offer = await offerOf(w.entry_id);
    expect([offer?.status, offer?.client_ip]).toEqual(['held', null]);
  });

  it('W2: an offer that expires passes to the next guest in the SAME transaction (here: a public hold attempt)', async () => {
    const sc = await scenario(db, { capacity: 1 });
    const b = await book(db, sc);
    const w1 = await joined(sc);
    const w2 = await joined(sc);
    await cancelByGuest(deps, b.token, {});
    expect((await entry(w1.entry_id)).status).toBe('offered');
    await expireOffer(w1.entry_id);

    expect((await publicHold(sc)).status).toBe(409); // the seat goes to W2, not the public
    const [e1, e2] = [await entry(w1.entry_id), await entry(w2.entry_id)];
    expect([e1.status, e2.status]).toEqual(['lapsed', 'offered']);
    // Same transaction ⇔ same post-lock clock T for the lapse and the new offer.
    expect(e1.resolved_at).toEqual(e2.offered_at);
  });

  it('W3: claiming after the offer expired → 410 OFFER_EXPIRED; the next guest is offered in that transaction', async () => {
    const sc = await scenario(db, { capacity: 1 });
    const b = await book(db, sc);
    const w1 = await joined(sc);
    const w2 = await joined(sc);
    await cancelByGuest(deps, b.token, {});
    await expireOffer(w1.entry_id);

    const r = await claimOffer(deps, w1.entry_id, w1.waitlist_token);
    expect([r.status, (r.body as { error: { code: string } }).error.code]).toEqual([410, 'OFFER_EXPIRED']);
    const [e1, e2] = [await entry(w1.entry_id), await entry(w2.entry_id)];
    expect([e1.status, e2.status]).toEqual(['lapsed', 'offered']);
    expect(e1.resolved_at).toEqual(e2.offered_at);
  });

  it('W4a: two holds expiring in one sweep free two seats of a group session → two offers, FIFO', async () => {
    const sc = await scenario(db, { capacity: 2 });
    const h1 = (await publicHold(sc)).body as HoldCreated;
    const h2 = (await publicHold(sc)).body as HoldCreated;
    const [w1, w2, w3] = [await joined(sc), await joined(sc), await joined(sc)];
    await sql`UPDATE bookings SET expires_at = clock_timestamp() - interval '1 second' WHERE id IN (${h1.hold_id}, ${h2.hold_id})`.execute(db);
    await runSweepOnce(db);
    expect([(await entry(w1.entry_id)).status, (await entry(w2.entry_id)).status, (await entry(w3.entry_id)).status])
      .toEqual(['offered', 'offered', 'waiting']);
  });

  it('W4b: two concurrent cancels on a full group session → two offers, FIFO', async () => {
    const sc = await scenario(db, { capacity: 2 });
    const b1 = await book(db, sc);
    const b2 = await book(db, sc);
    const [w1, w2, w3] = [await joined(sc), await joined(sc), await joined(sc)];
    const r = await Promise.all([cancelByGuest(deps, b1.token, {}), cancelByGuest(deps, b2.token, {})]);
    expect(r.map((x) => x.status)).toEqual([200, 200]);
    expect([(await entry(w1.entry_id)).status, (await entry(w2.entry_id)).status, (await entry(w3.entry_id)).status])
      .toEqual(['offered', 'offered', 'waiting']);
  });
});

describe('waitlist rules', () => {
  it('claim: the offer becomes a confirmed booking with the details given at join; a retried claim returns the same token', async () => {
    const sc = await scenario(db, { capacity: 1 });
    const b = await book(db, sc);
    const w = await joined(sc, { email: 'Grace@Example.TEST' });
    await cancelByGuest(deps, b.token, {});
    const first = await claimOffer(deps, w.entry_id, w.waitlist_token);
    expect(first.status).toBe(200);
    const again = await claimOffer(deps, w.entry_id, w.waitlist_token);
    expect(again.status).toBe(200);
    const [a, c] = [first.body as { manage_token: string; booking: { status: string; guest_email: string } }, again.body as { manage_token: string }];
    expect(c.manage_token).toBe(a.manage_token);
    expect([a.booking.status, a.booking.guest_email]).toEqual(['confirmed', 'grace@example.test']);
    expect((await entry(w.entry_id)).status).toBe('booked');
  });

  it('the offer expires after OFFER_TTL_MIN minutes, capped at the slot start; it notifies through the outbox', async () => {
    const sc = await scenario(db, { capacity: 1 });
    const b = await book(db, sc);
    const w = await joined(sc);
    await cancelByGuest(deps, b.token, {});
    const e = await entry(w.entry_id);
    const offer = (await offerOf(w.entry_id))!;
    expect(offer.expires_at!.getTime() - e.offered_at!.getTime()).toBe(OFFER_TTL_MIN * 60_000);
    const n = await db.selectFrom('notifications').select(['type', 'payload']).where('type', '=', 'waitlist.offered').execute();
    expect(n).toHaveLength(1);
    expect(JSON.stringify(n[0]!.payload)).not.toContain(w.waitlist_token);
  });

  it('one active entry per email per slot (case-insensitive) → 409 ALREADY_WAITLISTED', async () => {
    const sc = await scenario(db, { capacity: 1 });
    await book(db, sc);
    await joined(sc, { email: 'same@example.test' });
    const dup = await join(sc, { email: 'SAME@example.test' });
    expect([dup.status, (dup.body as { error: { code: string } }).error.code]).toEqual([409, 'ALREADY_WAITLISTED']);
  });

  it(`the list is capped at ${WAITLIST_CAP} waiting per slot → 409 WAITLIST_FULL`, async () => {
    const sc = await scenario(db, { capacity: 1 });
    await book(db, sc);
    for (let i = 0; i < WAITLIST_CAP; i++) await joined(sc);
    const over = await join(sc);
    expect([over.status, (over.body as { error: { code: string } }).error.code]).toEqual([409, 'WAITLIST_FULL']);
  });

  it('a slot the public can still book cannot be waitlisted → 409 SLOT_AVAILABLE', async () => {
    const sc = await scenario(db, { capacity: 1 });
    const r = await join(sc);
    expect([r.status, (r.body as { error: { code: string } }).error.code]).toEqual([409, 'SLOT_AVAILABLE']);
  });

  it(`at most ${WAITLIST_IP_CAP} active entries per IP → 429 WAITLIST_LIMIT`, async () => {
    const sc = await scenario(db, { capacity: 1, duration_min: 30 });
    const starts = Array.from({ length: WAITLIST_IP_CAP + 1 }, (_, i) => new Date(sc.slot.getTime() + i * 30 * 60_000));
    for (const s of starts) await book(db, sc, { startAt: s });
    for (const s of starts.slice(0, WAITLIST_IP_CAP)) await joined(sc, { ip: '198.51.100.50', startAt: s });
    const over = await join(sc, { ip: '198.51.100.50', startAt: starts[WAITLIST_IP_CAP]! });
    expect([over.status, (over.body as { error: { code: string } }).error.code]).toEqual([429, 'WAITLIST_LIMIT']);
  });

  it('offers do not count toward the per-IP hold cap', async () => {
    const sc = await scenario(db, { capacity: 1, duration_min: 30 });
    const b = await book(db, sc);
    const ip = '198.51.100.60';
    await joined(sc, { ip });
    await cancelByGuest(deps, b.token, {}); // the entry from `ip` is now offered
    for (let i = 1; i <= 3; i++) {
      expect((await createHold(deps, holdRequest(sc, { ip, startAt: new Date(sc.slot.getTime() + i * 30 * 60_000) }))).status).toBe(201);
    }
  });

  it('no offers within min notice: the waiting entries are closed and the seat stays free', async () => {
    const sc = await scenario(db, { capacity: 1 });
    const b = await book(db, sc);
    const w = await joined(sc);
    await db.updateTable('event_types').set({ min_notice_min: 60 * 24 * 365 }).where('id', '=', sc.ev.id).execute();
    await cancelByGuest(deps, b.token, {});
    expect((await entry(w.entry_id)).status).toBe('closed');
    expect(await offerOf(w.entry_id)).toBeUndefined();
  });

  it('reschedule away frees the old seat for the waitlist; rescheduling INTO a waitlisted slot is refused', async () => {
    const sc = await scenario(db, { capacity: 1, duration_min: 30 });
    const other = new Date(sc.slot.getTime() + 60 * 60_000);
    const b = await book(db, sc);
    const w = await joined(sc);
    expect((await rescheduleBooking(deps, b.token, { start_at: other.toISOString() })).status).toBe(200);
    expect((await entry(w.entry_id)).status).toBe('offered');
    // The old slot is now the waitlisted guest's offer; moving back into it is refused.
    expect((await rescheduleBooking(deps, b.token, { start_at: sc.slot.toISOString() })).status).toBe(409);
  });

  it('leave: waiting → left; offered → left and the seat goes to the next guest; repeating is a no-op', async () => {
    const sc = await scenario(db, { capacity: 1 });
    const b = await book(db, sc);
    const w1 = await joined(sc);
    const w2 = await joined(sc);
    const w3 = await joined(sc);
    expect((await leaveWaitlist(deps, w3.entry_id, w3.waitlist_token)).status).toBe(200);
    expect((await entry(w3.entry_id)).status).toBe('left');
    await cancelByGuest(deps, b.token, {});
    expect((await leaveWaitlist(deps, w1.entry_id, w1.waitlist_token)).status).toBe(200);
    expect((await leaveWaitlist(deps, w1.entry_id, w1.waitlist_token)).status).toBe(200);
    expect([(await entry(w1.entry_id)).status, (await entry(w2.entry_id)).status]).toEqual(['left', 'offered']);
  });

  it('status: position while waiting; read-repair hands a lapsed offer on without any other write', async () => {
    const sc = await scenario(db, { capacity: 1 });
    const b = await book(db, sc);
    const w1 = await joined(sc);
    const w2 = await joined(sc);
    let s = await waitlistStatus(deps, w2.entry_id, w2.waitlist_token);
    expect(s.body).toMatchObject({ status: 'waiting', position: 2 });
    await cancelByGuest(deps, b.token, {});
    await expireOffer(w1.entry_id); // W1 lets it lapse; nobody else writes for this host
    s = await waitlistStatus(deps, w2.entry_id, w2.waitlist_token);
    expect(s.body).toMatchObject({ status: 'offered', position: null });
    expect((s.body as { offer: { expires_at: string } }).offer.expires_at).toBeTruthy();
  });

  it('a wrong token is 404 everywhere; an entry id that does not exist is 404', async () => {
    const sc = await scenario(db, { capacity: 1 });
    await book(db, sc);
    const w = await joined(sc);
    const bad = 'B'.repeat(43);
    for (const r of [await waitlistStatus(deps, w.entry_id, bad), await claimOffer(deps, w.entry_id, bad), await leaveWaitlist(deps, w.entry_id, bad),
      await waitlistStatus(deps, '00000000-0000-4000-8000-000000000000', w.waitlist_token)]) {
      expect(r.status).toBe(404);
    }
  });

  it('joining is idempotent per key: a replay returns the same entry and token; a different body → 422', async () => {
    const sc = await scenario(db, { capacity: 1 });
    await book(db, sc);
    const first = await joined(sc, { key: 'wl-same-key-1', email: 'k@example.test', name: 'Kay' });
    const again = await joined(sc, { key: 'wl-same-key-1', email: 'k@example.test', name: 'Kay' });
    expect([again.entry_id, again.waitlist_token]).toEqual([first.entry_id, first.waitlist_token]);
    const other = await join(sc, { key: 'wl-same-key-1', email: 'other@example.test', name: 'Kay' });
    expect(other.status).toBe(422);
  });
});

describe('the waitlist invariants are not vacuous (design §13.8)', () => {
  it('detects a free seat left while someone waits (a freeing path that forgot the handoff)', async () => {
    const sc = await scenario(db, { capacity: 1 });
    const b = await book(db, sc);
    const w = await joined(sc);
    // Free the seat behind the service's back (no handoff): cancel the booking with raw SQL.
    await sql`UPDATE bookings SET status = 'cancelled', cancelled_at = now(), cancelled_by = 'guest' WHERE id = ${b.id}`.execute(db);
    await expect(assertSeatInvariant(db)).rejects.toThrow(/not handed to the waitlist/);
    await sql`UPDATE waitlist_entries SET status = 'left', resolved_at = now() WHERE id = ${w.entry_id}`.execute(db); // restore for afterEach
  });

  it('detects an offered entry whose offer is not a live hold', async () => {
    const sc = await scenario(db, { capacity: 1 });
    const b = await book(db, sc);
    const w = await joined(sc);
    await cancelByGuest(deps, b.token, {});
    await sql`UPDATE bookings SET status = 'expired' WHERE waitlist_entry_id = ${w.entry_id}`.execute(db); // no lapse recorded
    await expect(assertSeatInvariant(db)).rejects.toThrow(/disagree/);
    await sql`UPDATE waitlist_entries SET status = 'lapsed', resolved_at = now() WHERE id = ${w.entry_id}`.execute(db);
  });
});
