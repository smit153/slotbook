import { expect, test } from '@playwright/test';
import { DateTime } from 'luxon';
import { bookViaApi, DEMO_LOGIN, firstDaySlots, uniqueGuest } from './api.js';

test('host: the seeded login works and an upcoming booking shows in the host’s zone with the zone printed', async ({ page, request }) => {
  // Its own booking (made via the API, as a guest would), so this test runs alone.
  const [slot] = await firstDaySlots(request, 'Europe/Berlin');
  const guest = uniqueGuest('Europe/Berlin');
  const { booking } = await bookViaApi(request, slot!, guest);

  await page.goto('/login');
  await page.getByLabel('Email').fill(DEMO_LOGIN.email);
  await page.getByLabel('Password').fill(DEMO_LOGIN.password);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByRole('heading', { name: 'Upcoming bookings' })).toBeVisible();
  await expect(page.getByText('Times in your time zone: America/New_York')).toBeVisible();

  // Expected text computed independently of the app's own formatting code.
  const ny = (iso: string) => DateTime.fromISO(iso, { zone: 'America/New_York' }).setLocale('en-US');
  const range = `${ny(booking.start_at).toFormat('HH:mm')}–${ny(booking.end_at).toFormat('HH:mm')} ${ny(booking.start_at).toFormat('ZZZZ')}`;
  expect(range).toMatch(/ E[SD]T$/);
  const row = page.getByRole('listitem').filter({ hasText: guest.email });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText(range);
  await expect(row).toContainText('guest in Europe/Berlin');
});
