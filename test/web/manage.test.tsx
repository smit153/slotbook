import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DateTime } from 'luxon';
import type { FastifyInstance } from 'fastify';
import { testDb, truncateAll } from '../helpers/db.js';
import { assertSeatInvariant } from '../helpers/invariants.js';
import { book, startedBooking } from '../helpers/flows.js';
import { makeApp } from '../helpers/app.js';
import { scenario } from '../helpers/scenario.js';
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
  shim.restore();
  await app.close();
  await assertSeatInvariant(db);
});
afterAll(() => db.destroy());

const inBerlin = (d: Date) => DateTime.fromJSDate(d, { zone: 'Europe/Berlin' }).setLocale('en-US');

describe('manage page (/manage#token)', () => {
  it('shows the booking in the browser zone and hides itself from search engines', async () => {
    const sc = await scenario(db);
    const b = await book(db, sc);
    renderAt(`/manage#${b.token}`);
    expect(await screen.findByText(inBerlin(sc.slot).toFormat('ccc d LLL yyyy, HH:mm ZZZZ'))).toBeTruthy();
    expect(screen.getByText('confirmed')).toBeTruthy();
    expect(document.head.querySelector('meta[name="robots"]')?.getAttribute('content')).toBe('noindex, nofollow');
    // The token travelled only in the API path (redacted in logs), never as a page path.
    expect(shim.calls[0]!.url).toBe(`/api/bookings/${b.token}`);
  });

  it('reschedule → pick a new time → moved; the server agrees', async () => {
    const sc = await scenario(db);
    const b = await book(db, sc);
    const target = new Date(sc.slot.getTime() + 60 * 60_000);
    const user = userEvent.setup();
    renderAt(`/manage#${b.token}`);
    await user.click(await screen.findByRole('button', { name: 'Reschedule' }));
    await user.click(await screen.findByRole('button', { name: inBerlin(target).toFormat('ccc d LLL yyyy') }));
    await user.click(within(screen.getByRole('list', { name: /^Times on/ })).getByRole('button', { name: new RegExp(`, ${inBerlin(target).toFormat('HH:mm')} `) }));

    expect(await screen.findByText(/^Moved to/)).toBeTruthy();
    const row = await db.selectFrom('bookings').select('start_at').where('id', '=', b.id).executeTakeFirstOrThrow();
    expect(row.start_at).toEqual(target);
  });

  it('reschedule to a time someone just took → message, booking unchanged', async () => {
    const sc = await scenario(db);
    const b = await book(db, sc);
    const target = new Date(sc.slot.getTime() + 60 * 60_000);
    const user = userEvent.setup();
    renderAt(`/manage#${b.token}`);
    await user.click(await screen.findByRole('button', { name: 'Reschedule' }));
    await user.click(await screen.findByRole('button', { name: inBerlin(target).toFormat('ccc d LLL yyyy') }));
    const btn = within(screen.getByRole('list', { name: /^Times on/ })).getByRole('button', { name: new RegExp(`, ${inBerlin(target).toFormat('HH:mm')} `) });
    await book(db, sc, { startAt: target }); // taken while the guest was looking
    await user.click(btn);

    expect(await screen.findByText(/that time was just taken/i)).toBeTruthy();
    expect((await db.selectFrom('bookings').select('start_at').where('id', '=', b.id).executeTakeFirstOrThrow()).start_at).toEqual(sc.slot);
  });

  it('cancel with a reason → cancelled, buttons gone, notification carries the reason', async () => {
    const sc = await scenario(db);
    const b = await book(db, sc);
    const user = userEvent.setup();
    renderAt(`/manage#${b.token}`);
    await user.click(await screen.findByRole('button', { name: 'Cancel booking' }));
    await user.type(screen.getByLabelText('Reason (optional)'), 'Got sick');
    await user.click(screen.getByRole('button', { name: 'Yes, cancel my booking' }));

    expect(await screen.findByText('Your booking is cancelled.')).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Reschedule' })).toBeNull());
    const n = await db.selectFrom('notifications').select('payload').where('type', '=', 'booking.cancelled').executeTakeFirstOrThrow();
    expect(n.payload).toMatchObject({ cancelled_by: 'guest', reason: 'Got sick' });
  });

  it('a booking that already started is read-only', async () => {
    const sc = await scenario(db);
    const b = await startedBooking(db, sc);
    renderAt(`/manage#${b.token}`);
    expect(await screen.findByText(/has started and can no longer be changed/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Reschedule' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cancel booking' })).toBeNull();
  });

  it('an invalid or missing token says so', async () => {
    renderAt(`/manage#${'A'.repeat(43)}`);
    expect((await screen.findByRole('alert')).textContent).toMatch(/not valid/);
  });
});
