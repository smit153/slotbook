import { Writable } from 'node:stream';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import type { FastifyInstance } from 'fastify';
import { testDb, truncateAll } from '../../helpers/db.js';
import { assertSeatInvariant } from '../../helpers/invariants.js';
import { book } from '../../helpers/flows.js';
import { makeApp } from '../../helpers/app.js';
import { scenario, type Scenario } from '../../helpers/scenario.js';
import { cancelByGuest } from '../../../src/server/services/cancel.js';

/** Waitlist over HTTP (design §13.5): slots with include_full, join, status, claim; no token in logs. */
const db = testDb({ max: 10 });
afterAll(() => db.destroy());
beforeEach(() => truncateAll(db));
afterEach(() => assertSeatInvariant(db));

const slotsUrl = (sc: Scenario, extra = '') =>
  `/api/hosts/${sc.hostSlug}/events/${sc.ev.slug}/slots?from=${new Date(sc.slot.getTime() - 3_600_000).toISOString()}&to=${new Date(sc.slot.getTime() + 3_600_000).toISOString()}&tz=UTC${extra}`;
const slotAt = (body: { slots: Array<{ start_at: string }> }, sc: Scenario) => body.slots.find((s) => s.start_at === sc.slot.toISOString());

async function joinHttp(app: FastifyInstance, sc: Scenario, email: string) {
  return app.inject({
    method: 'POST', url: '/api/waitlist', headers: { 'idempotency-key': `wl-http-${email}` }, remoteAddress: '198.51.100.70',
    payload: { host: sc.hostSlug, slug: sc.ev.slug, start_at: sc.slot.toISOString(), name: 'Wait Er', email, tz: 'Europe/Berlin' },
  });
}

describe('waitlist over HTTP', () => {
  it('full slot → shown only with include_full; join → status → offer after a cancel → claim; the token never reaches the logs', async () => {
    const sc = await scenario(db, { capacity: 1 });
    const b = await book(db, sc);
    const lines: string[] = [];
    const app = await makeApp(db, { log: { level: 'debug', stream: new Writable({ write(c, _e, cb) { lines.push(String(c)); cb(); } }) } });

    expect(slotAt((await app.inject({ method: 'GET', url: slotsUrl(sc) })).json(), sc)).toBeUndefined();
    const full = slotAt((await app.inject({ method: 'GET', url: slotsUrl(sc, '&include_full=1') })).json(), sc);
    expect(full).toMatchObject({ seats_left: 0, waitlist: { open: true, waiting: 0 } });

    const joined = await joinHttp(app, sc, 'wait@example.test');
    expect(joined.statusCode).toBe(201);
    expect(joined.headers['cache-control']).toBe('no-store');
    const { entry_id, waitlist_token, waitlist_url } = joined.json();
    expect(waitlist_url).toBe(`/waitlist#${entry_id}.${waitlist_token}`);

    const status = (t?: string) => app.inject({ method: 'GET', url: `/api/waitlist/${entry_id}`, headers: t ? { 'waitlist-token': t } : {} });
    expect((await status()).statusCode).toBe(404);
    expect((await status(waitlist_token)).json()).toMatchObject({ status: 'waiting', position: 1, offer: null });
    expect(slotAt((await app.inject({ method: 'GET', url: slotsUrl(sc, '&include_full=1') })).json(), sc)).toMatchObject({ waitlist: { waiting: 1 } });

    await cancelByGuest({ db }, b.token, {});
    const offered = (await status(waitlist_token)).json();
    expect(offered.status).toBe('offered');
    expect(Date.parse(offered.offer.expires_at)).toBeGreaterThan(Date.parse(offered.offer.server_now));
    // The seat is the waitlisted guest's: still not offered to the public.
    expect(slotAt((await app.inject({ method: 'GET', url: slotsUrl(sc) })).json(), sc)).toBeUndefined();

    const claim = await app.inject({ method: 'POST', url: `/api/waitlist/${entry_id}/claim`, headers: { 'waitlist-token': waitlist_token } });
    expect(claim.statusCode).toBe(200);
    expect(claim.json().manage_url).toMatch(/^\/manage#[A-Za-z0-9_-]{43}$/);
    expect((await status(waitlist_token)).json().status).toBe('booked');

    await app.close();
    const logs = lines.join('');
    expect(logs).not.toContain(waitlist_token);
    expect(logs.split('\n').filter(Boolean).length).toBeGreaterThan(5);
  });

  it('a lapsed-but-unswept offer with someone else waiting still reads as full to the public', async () => {
    const sc = await scenario(db, { capacity: 1 });
    const b = await book(db, sc);
    const app = await makeApp(db);
    const w1 = (await joinHttp(app, sc, 'one@example.test')).json();
    await joinHttp(app, sc, 'two@example.test');
    await cancelByGuest({ db }, b.token, {});
    await sql`UPDATE bookings SET expires_at = clock_timestamp() - interval '1 second' WHERE waitlist_entry_id = ${w1.entry_id}`.execute(db);

    // Live, the seat is free (the offer expired), but #2 owns it: not public, listed as full.
    expect(slotAt((await app.inject({ method: 'GET', url: slotsUrl(sc) })).json(), sc)).toBeUndefined();
    expect(slotAt((await app.inject({ method: 'GET', url: slotsUrl(sc, '&include_full=1') })).json(), sc)).toMatchObject({ seats_left: 0, waitlist: { waiting: 1 } });
    await app.close();
  });

  it('join without an Idempotency-Key → 400; a free slot → 409 SLOT_AVAILABLE', async () => {
    const sc = await scenario(db, { capacity: 1 });
    const app = await makeApp(db);
    const noKey = await app.inject({ method: 'POST', url: '/api/waitlist', payload: {} });
    expect([noKey.statusCode, noKey.json().error.code]).toEqual([400, 'IDEMPOTENCY_KEY_REQUIRED']);
    const free = await joinHttp(app, sc, 'early@example.test');
    expect([free.statusCode, free.json().error.code]).toEqual([409, 'SLOT_AVAILABLE']);
    await app.close();
  });
});
