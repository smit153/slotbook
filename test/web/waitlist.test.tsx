import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DateTime } from 'luxon';
import type { FastifyInstance } from 'fastify';
import { testDb, truncateAll } from '../helpers/db.js';
import { assertSeatInvariant } from '../helpers/invariants.js';
import { book } from '../helpers/flows.js';
import { makeApp } from '../helpers/app.js';
import { scenario } from '../helpers/scenario.js';
import { cancelByGuest } from '../../src/server/services/cancel.js';
import { installFetchShim } from './fetch-shim.js';
import { renderAt } from './render.js';

/** The waitlist UI (design §13) against the real API and Postgres. */
const db = testDb({ max: 10 });
let app: FastifyInstance;
let shim: ReturnType<typeof installFetchShim>;
beforeEach(async () => {
  await truncateAll(db);
  app = await makeApp(db);
  shim = installFetchShim(app);
});
afterEach(async () => {
  shim.restore();
  await app.close();
  await assertSeatInvariant(db);
});
afterAll(() => db.destroy());

describe('waitlist UI', () => {
  it('a full time → join → private link; after a cancel the waitlist page offers the seat → confirm → booked', async () => {
    const sc = await scenario(db, { capacity: 1 });
    const b = await book(db, sc);
    const user = userEvent.setup();
    renderAt(`/${sc.hostSlug}/${sc.ev.slug}`);
    const day = DateTime.fromJSDate(sc.slot, { zone: 'Europe/Berlin' }).setLocale('en-US');
    await user.click(await screen.findByRole('button', { name: day.toFormat('ccc d LLL yyyy') }));
    const times = screen.getByRole('list', { name: /^Times on/ });
    await user.click(within(times).getByRole('button', { name: new RegExp(`, ${day.toFormat('HH:mm')} .*full: join the waitlist$`) }));

    await user.type(screen.getByLabelText('Name'), 'Wendy Wait');
    await user.type(screen.getByLabelText('Email'), 'wendy@example.test');
    await user.click(screen.getByRole('button', { name: 'Join waitlist' }));
    expect(await screen.findByRole('heading', { name: "You're on the waitlist" })).toBeTruthy();
    const href = screen.getByRole('link', { name: /\/waitlist#/ }).getAttribute('href')!;
    expect(href).toMatch(/^\/waitlist#[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/);

    cleanup();
    renderAt(href);
    expect(await screen.findByText(/on the waitlist/)).toBeTruthy();
    expect(screen.getByText('#1')).toBeTruthy();

    await cancelByGuest({ db }, b.token, {}); // the seat is handed to Wendy in this transaction
    cleanup();
    renderAt(href);
    expect(await screen.findByText('A seat is yours.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Confirm booking' }));
    expect(await screen.findByRole('heading', { name: "You're booked" })).toBeTruthy();

    const row = await db.selectFrom('bookings').select(['status', 'guest_email']).where('waitlist_entry_id', 'is not', null).executeTakeFirstOrThrow();
    expect(row).toEqual({ status: 'confirmed', guest_email: 'wendy@example.test' });
    // The token only ever travelled in a header, never in a URL.
    expect(shim.calls.every((c) => !c.url.includes(href.split('.')[1]!))).toBe(true);
  });
});
