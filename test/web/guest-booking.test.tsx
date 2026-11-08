import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { sql } from 'kysely';
import { DateTime } from 'luxon';
import type { FastifyInstance } from 'fastify';
import { testDb, truncateAll } from '../helpers/db.js';
import { assertSeatInvariant } from '../helpers/invariants.js';
import { makeApp } from '../helpers/app.js';
import { APP_SECRET, dbNow, NY, scenario, type Scenario } from '../helpers/scenario.js';
import { createHold } from '../../src/server/services/holds.js';
import { installFetchShim } from './fetch-shim.js';
import { renderAt } from './render.js';

const db = testDb({ max: 10 });
let app: FastifyInstance;
let shim: ReturnType<typeof installFetchShim>;

beforeEach(async () => {
  await truncateAll(db);
  app = await makeApp(db);
  shim = installFetchShim(app);
});
afterEach(async () => {
  vi.useRealTimers();
  shim.restore();
  await app.close();
  await assertSeatInvariant(db);
});
afterAll(() => db.destroy());

const statusOf = async (id: string) => (await db.selectFrom('bookings').select('status').where('id', '=', id).executeTakeFirstOrThrow()).status;
const holds = () => db.selectFrom('bookings').select(['id', 'status', 'start_at']).orderBy('created_at').execute();
const berlin = (d: Date) => DateTime.fromJSDate(d, { zone: 'Europe/Berlin' }).toFormat('HH:mm');

/** Open the booking page and the day of `slot` (days are listed in the guest's zone). */
async function openDay(sc: Scenario, slot: Date) {
  const user = userEvent.setup();
  renderAt(`/${sc.hostSlug}/${sc.ev.slug}`);
  const dayLabel = DateTime.fromJSDate(slot, { zone: 'Europe/Berlin' }).setLocale('en-US').toFormat('ccc d LLL yyyy');
  await user.click(await screen.findByRole('button', { name: dayLabel }));
  return user;
}
const timeButton = (label: string) => within(screen.getByRole('list', { name: /^Times on/ })).getByRole('button', { name: new RegExp(`, ${label} `) });

describe('guest booking page', () => {
  it('pick a time → held with a countdown → confirm → manage link; booking stored with the guest zone', async () => {
    const sc = await scenario(db);
    const user = await openDay(sc, sc.slot);
    expect(screen.getByText(/Times are shown in Europe\/Berlin/)).toBeTruthy();

    await user.click(timeButton(berlin(sc.slot)));
    expect(await screen.findByText(/Held for [45]:\d\d/)).toBeTruthy();

    await user.type(screen.getByLabelText('Name'), 'Ada Lovelace');
    await user.type(screen.getByLabelText('Email'), 'ada@example.test');
    await user.click(screen.getByRole('button', { name: 'Confirm booking' }));

    expect(await screen.findByRole('heading', { name: "You're booked" })).toBeTruthy();
    const link = screen.getByRole('link', { name: /\/manage#/ });
    expect(link.getAttribute('href')).toMatch(/^\/manage#[A-Za-z0-9_-]{43}$/);

    const [b] = await db.selectFrom('bookings').select(['status', 'guest_tz', 'guest_email']).execute();
    expect(b).toEqual({ status: 'confirmed', guest_tz: 'Europe/Berlin', guest_email: 'ada@example.test' });
  });

  it('picking another time holds the NEW slot first, then releases the old one', async () => {
    const sc = await scenario(db);
    const second = new Date(sc.slot.getTime() + 30 * 60_000);
    const user = await openDay(sc, sc.slot);
    await user.click(timeButton(berlin(sc.slot)));
    await screen.findByText(/Held for/);
    await user.click(timeButton(berlin(second)));

    await waitFor(async () => expect((await holds()).map((h) => h.status)).toEqual(['expired', 'held']));
    const posts = shim.calls.filter((c) => c.method === 'POST').map((c) => c.url.replace(/[0-9a-f-]{36}/, ':id'));
    expect(posts).toEqual(['/api/holds', '/api/holds', '/api/holds/:id/release']);
    const events = await db.selectFrom('booking_events').select('type').execute();
    expect(events).toEqual([{ type: 'released' }]);
  });

  it('if the NEW hold gets 409, the guest keeps the old hold (nothing is released)', async () => {
    const sc = await scenario(db);
    const second = new Date(sc.slot.getTime() + 30 * 60_000);
    const user = await openDay(sc, sc.slot);
    await user.click(timeButton(berlin(sc.slot)));
    await screen.findByText(/Held for/);

    // Someone else grabs the second slot while it is still on our screen.
    expect((await createHold({ db, appSecret: APP_SECRET }, {
      host: sc.hostSlug, slug: sc.ev.slug, start_at: second.toISOString(), clientIp: '198.51.100.77', idempotencyKey: 'other-guest-key-1',
    })).status).toBe(201);

    await user.click(timeButton(berlin(second)));
    expect(await screen.findByText(/that time was just taken/i)).toBeTruthy();
    expect(screen.getByText(/You still have .* held/)).toBeTruthy();

    const mine = (await holds())[0]!;
    expect(mine.start_at).toEqual(sc.slot);
    expect(await statusOf(mine.id)).toBe('held');
    expect(shim.calls.some((c) => c.url.endsWith('/release'))).toBe(false);
    // …and the form for the slot we still hold is still there.
    expect(screen.getByRole('button', { name: 'Confirm booking' })).toBeTruthy();
  });

  it('a hold that expired on the server → confirm shows the expiry message and the form goes away', async () => {
    const sc = await scenario(db);
    const user = await openDay(sc, sc.slot);
    await user.click(timeButton(berlin(sc.slot)));
    await screen.findByText(/Held for/);
    await sql`UPDATE bookings SET expires_at = clock_timestamp() - interval '1 second'`.execute(db);

    await user.type(screen.getByLabelText('Name'), 'Ada');
    await user.type(screen.getByLabelText('Email'), 'ada@example.test');
    await user.click(screen.getByRole('button', { name: 'Confirm booking' }));
    expect(await screen.findByText(/Your hold expired/)).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Confirm booking' })).toBeNull());
  });

  it('leaving the page (pagehide) releases the hold with keepalive', async () => {
    const sc = await scenario(db);
    const user = await openDay(sc, sc.slot);
    await user.click(timeButton(berlin(sc.slot)));
    await screen.findByText(/Held for/);
    window.dispatchEvent(new Event('pagehide'));
    await waitFor(async () => expect((await holds()).map((h) => h.status)).toEqual(['expired']));
  });

  it('group events show seats left on each time', async () => {
    const sc = await scenario(db, { capacity: 5, duration_min: 60 });
    await openDay(sc, sc.slot);
    expect(timeButton(berlin(sc.slot)).textContent).toMatch(/5 left/);
  });
});

describe('fall-back night labels in the picker', () => {
  it('the repeated hour is shown as "01:00 EDT" and "01:00 EST"', async () => {
    const sc = await scenario(db, { horizon_days: 365 });
    // Next US fall-back night from the DB clock (Nov 1 2026 is already past).
    const now = DateTime.fromJSDate(await dbNow(db), { zone: NY });
    let night = '';
    for (let y = now.year; !night; y++) {
      const nov1 = DateTime.fromObject({ year: y, month: 11, day: 1 }, { zone: NY });
      const sunday = nov1.plus({ days: (7 - nov1.weekday) % 7 });
      if (sunday > now.plus({ days: 2 })) night = sunday.toISODate()!;
    }
    await db.insertInto('date_overrides').values({ host_id: sc.hostId, date: night, kind: 'custom' }).execute();
    await db.insertInto('date_override_windows').values({ host_id: sc.hostId, date: night, start_time: '00:00', end_time: '03:00' }).execute();

    // The picker shows "the next 30 days" from the BROWSER's today; move only the browser's Date
    // so that window contains the night (the server keeps the real DB clock).
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(DateTime.fromISO(night, { zone: NY }).minus({ days: 3 }).toJSDate());

    const user = userEvent.setup();
    renderAt(`/${sc.hostSlug}/${sc.ev.slug}`);
    await user.selectOptions(await screen.findByLabelText('Your time zone'), NY);
    const dayLabel = DateTime.fromISO(night).setLocale('en-US').toFormat('ccc d LLL yyyy');
    await user.click(await screen.findByRole('button', { name: dayLabel }));

    const labels = within(screen.getByRole('list', { name: /^Times on/ })).getAllByRole('button').map((b) => b.textContent);
    expect(labels).toEqual(['00:00', '00:30', '01:00 EDT', '01:30 EDT', '01:00 EST', '01:30 EST', '02:00', '02:30']);
  });
});
