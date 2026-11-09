import { expect, test } from '@playwright/test';
import { bookingByToken, bookViaApi, EVENT, firstDaySlots, HOST, uniqueGuest } from './api.js';

/**
 * Waitlist in a real browser (design §13): the only seat is booked, a second guest joins the
 * waitlist from the booking page, the first guest cancels, and the second guest confirms the
 * seat that was held for them. Sets up its own state, so it runs alone.
 */
test('waitlist: join a full time, get the freed seat after a cancel, confirm it', async ({ page, request }) => {
  const [slot] = await firstDaySlots(request, 'Europe/Berlin');
  const first = await bookViaApi(request, slot!, uniqueGuest());
  const second = uniqueGuest();

  await page.goto(`/${HOST}/${EVENT}`);
  const full = page.getByRole('list', { name: /^Times on/ }).getByRole('button', { name: `${slot!.local.label}, full: join the waitlist`, exact: true });
  await expect(full).toBeVisible();
  await full.click();
  await page.getByLabel('Name').fill(second.name);
  await page.getByLabel('Email').fill(second.email);
  await page.getByRole('button', { name: 'Join waitlist' }).click();
  await expect(page.getByRole('heading', { name: "You're on the waitlist" })).toBeVisible();
  const link = page.locator('a.waitlist-link');
  await expect(link).toHaveAttribute('href', /^\/waitlist#[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/);

  await link.click();
  await expect(page.getByText(/You're #1 on the waitlist/)).toBeVisible();

  // The first guest cancels: the seat is handed to the waitlisted guest in that transaction.
  expect((await request.post(`/api/bookings/${first.manage_token}/cancel`, { data: {} })).status()).toBe(200);

  await page.reload();
  await expect(page.getByText('A seat is yours.')).toBeVisible();
  await expect(page.locator('.countdown')).toHaveText(/^Held for (15:00|14:[0-5]\d)$/);
  await page.getByRole('button', { name: 'Confirm booking' }).click();
  await expect(page.getByRole('heading', { name: "You're booked" })).toBeVisible();

  const manage = await page.locator('a.manage-link').getAttribute('href');
  const booking = await bookingByToken(request, manage!.split('#')[1]!);
  expect([booking.status, booking.start_at]).toEqual(['confirmed', slot!.start_at]);
});
