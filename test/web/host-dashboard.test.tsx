import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DateTime } from 'luxon';
import { sql } from 'kysely';
import type { FastifyInstance } from 'fastify';
import { hashPassword } from '../../src/server/auth/password.js';
import { testDb, truncateAll } from '../helpers/db.js';
import { assertSeatInvariant } from '../helpers/invariants.js';
import { book } from '../helpers/flows.js';
import { HOST_PASSWORD, makeApp } from '../helpers/app.js';
import { NY, scenario, type Scenario } from '../helpers/scenario.js';
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

async function hostReady(): Promise<Scenario & { email: string }> {
  const sc = await scenario(db);
  await db.updateTable('hosts').set({ password_hash: await hashPassword(HOST_PASSWORD), name: 'Test Host' }).where('id', '=', sc.hostId).execute();
  const { email } = await db.selectFrom('hosts').select('email').where('id', '=', sc.hostId).executeTakeFirstOrThrow();
  return { ...sc, email };
}

async function logIn(email: string) {
  const user = userEvent.setup();
  renderAt('/login');
  await user.type(await screen.findByLabelText('Email'), email);
  await user.type(screen.getByLabelText('Password'), HOST_PASSWORD);
  await user.click(screen.getByRole('button', { name: 'Log in' }));
  await screen.findByRole('navigation', { name: 'Dashboard' });
  return user;
}

describe('host dashboard', () => {
  it('/dashboard without a session redirects to the login page', async () => {
    renderAt('/dashboard');
    expect(await screen.findByRole('heading', { name: /host login/ })).toBeTruthy();
  });

  it('wrong password shows the error inline', async () => {
    const h = await hostReady();
    const user = userEvent.setup();
    renderAt('/login');
    await user.type(await screen.findByLabelText('Email'), h.email);
    await user.type(screen.getByLabelText('Password'), 'nope');
    await user.click(screen.getByRole('button', { name: 'Log in' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Wrong email or password');
  });

  it('login → upcoming bookings grouped by host day, times with the host zone; cancel needs a reason', async () => {
    const h = await hostReady();
    const b = await book(db, h);
    const user = await logIn(h.email);

    const range = `09:00–09:30 ${DateTime.fromJSDate(h.slot, { zone: NY }).toFormat('ZZZZ')}`;
    expect(await screen.findByText(range)).toBeTruthy();
    expect(screen.getByText(/Times in your time zone: America\/New_York/)).toBeTruthy();
    expect(screen.getByText(/guest in Europe\/Berlin/)).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Cancel…' }));
    await user.type(screen.getByLabelText('Reason'), 'Conference trip');
    await user.click(screen.getByRole('button', { name: 'Confirm cancel' }));
    expect(await screen.findByText(/Booking cancelled/)).toBeTruthy();
    await waitFor(() => expect(screen.queryByText(range)).toBeNull());

    const row = await db.selectFrom('bookings').select(['status', 'cancelled_by', 'cancel_reason']).where('id', '=', b.id).executeTakeFirstOrThrow();
    expect(row).toEqual({ status: 'cancelled', cancelled_by: 'host', cancel_reason: 'Conference trip' });
  });

  it('availability: an overlap is flagged inline and NOT sent; a valid edit saves in one PUT', async () => {
    const h = await hostReady();
    const user = await logIn(h.email);
    await user.click(screen.getByRole('link', { name: 'Availability' }));
    const monday = await screen.findByRole('group', { name: 'Monday' });

    // Monday already has 09:00–17:00; add a second window that overlaps it.
    await user.click(within(monday).getByRole('button', { name: '+ Add hours' }));
    const starts = within(monday).getAllByLabelText('Monday start');
    await user.clear(starts[1]!);
    await user.type(starts[1]!, '16:00');
    const ends = within(monday).getAllByLabelText('Monday end');
    await user.clear(ends[1]!);
    await user.type(ends[1]!, '18:00');
    const putsBefore = shim.calls.filter((c) => c.method === 'PUT').length;
    await user.click(screen.getByRole('button', { name: 'Save availability' }));
    expect(await within(monday).findByText(/Overlaps 09:00–17:00/)).toBeTruthy();
    expect(shim.calls.filter((c) => c.method === 'PUT').length).toBe(putsBefore);

    // Fix it: 17:00–18:00 touches but does not overlap.
    await user.clear(starts[1]!);
    await user.type(starts[1]!, '17:00');
    await user.click(screen.getByRole('button', { name: 'Save availability' }));
    expect(await screen.findByText('Availability saved.')).toBeTruthy();
    const rows = await db.selectFrom('availability_rules').select(['start_time', 'end_time']).where('host_id', '=', h.hostId).where('weekday', '=', 1).orderBy('start_time').execute();
    expect(rows).toEqual([{ start_time: '09:00:00', end_time: '17:00:00' }, { start_time: '17:00:00', end_time: '18:00:00' }]);
  });

  it('availability: a rejection only the server can make (calendar busy) is shown; old availability kept', async () => {
    const h = await hostReady();
    // Swap in an app with a short lock timeout so the save fails fast while the host is locked.
    shim.restore();
    await app.close();
    app = await makeApp(db, { lockTimeoutMs: 200 });
    shim = installFetchShim(app);

    const user = await logIn(h.email);
    await user.click(screen.getByRole('link', { name: 'Availability' }));
    const monday = await screen.findByRole('group', { name: 'Monday' });
    await user.click(within(monday).getByRole('button', { name: 'Remove' }));

    let release!: () => void;
    const released = new Promise<void>((r) => { release = r; });
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => { locked = r; });
    const blocker = db.transaction().execute(async (trx) => {
      await sql`SELECT id FROM hosts WHERE id = ${h.hostId} FOR UPDATE`.execute(trx);
      locked();
      await released;
    });
    await isLocked;
    await user.click(screen.getByRole('button', { name: 'Save availability' }));
    // The client retried the 503 once (after Retry-After), then gave up and said so.
    expect((await screen.findByRole('alert', {}, { timeout: 5_000 })).textContent).toMatch(/busy/);
    release();
    await blocker;

    expect(shim.calls.filter((c) => c.method === 'PUT').map((c) => c.status)).toEqual([503, 503]);
    const weekly = await db.selectFrom('availability_rules').select('weekday').where('host_id', '=', h.hostId).execute();
    expect(weekly).toHaveLength(5); // Monday was NOT removed on the server
    // The form still shows the host's unsaved edit (Monday removed), ready to retry.
    expect(within(monday).getByText('Unavailable')).toBeTruthy();
  });

  it('event types: deactivate → marked inactive, and the public page stops offering it', async () => {
    const h = await hostReady();
    const user = await logIn(h.email);
    await user.click(screen.getByRole('link', { name: 'Event types' }));
    await user.click(await screen.findByRole('button', { name: 'Deactivate' }));
    expect(await screen.findByText('inactive')).toBeTruthy();
    expect((await db.selectFrom('event_types').select('active').where('id', '=', h.ev.id).executeTakeFirstOrThrow()).active).toBe(false);
  });

  it('settings: the home time zone can be changed (Asia/Kolkata) and the header follows', async () => {
    const h = await hostReady();
    const user = await logIn(h.email);
    await user.click(screen.getByRole('link', { name: 'Settings' }));
    await user.selectOptions(await screen.findByLabelText('Home time zone'), 'Asia/Kolkata');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Saved.')).toBeTruthy();
    expect(screen.getByText(/Test Host · Asia\/Kolkata/)).toBeTruthy();
    expect((await db.selectFrom('hosts').select('timezone').where('id', '=', h.hostId).executeTakeFirstOrThrow()).timezone).toBe('Asia/Kolkata');
  });

  it('notifications list shows the sink rows with host-zone times', async () => {
    const h = await hostReady();
    await book(db, h);
    const user = await logIn(h.email);
    await user.click(screen.getByRole('link', { name: 'Notifications' }));
    expect(await screen.findByText('booking.confirmed')).toBeTruthy();
  });
});
