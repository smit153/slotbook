import { expect, test } from '@playwright/test';
import { bookingByToken, EVENT, firstDaySlots, freeSlots, HOST, timeButton, uniqueGuest } from './api.js';

const PAGE = `/${HOST}/${EVENT}`;

test('full guest flow in a Berlin browser: pick → held with countdown → confirm → manage → reschedule → cancel', async ({ page, request }) => {
  const [slot] = await firstDaySlots(request, 'Europe/Berlin');
  const guest = uniqueGuest();

  await page.goto(PAGE);
  await expect(page.getByText('Times are shown in Europe/Berlin')).toBeVisible();
  await timeButton(page, slot!).click();
  await expect(page.locator('.countdown')).toHaveText(/^Held for (5:00|4:[0-5]\d)$/);

  await page.getByLabel('Name').fill(guest.name);
  await page.getByLabel('Email').fill(guest.email);
  await page.getByRole('button', { name: 'Confirm booking' }).click();
  await expect(page.getByRole('heading', { name: "You're booked" })).toBeVisible();

  const link = page.locator('a.manage-link');
  const href = await link.getAttribute('href');
  expect(href).toMatch(/^\/manage#[A-Za-z0-9_-]{43}$/);
  const token = href!.split('#')[1]!;
  expect((await bookingByToken(request, token)).status).toBe('confirmed');

  // Manage page: reschedule to another free time (on the day the picker opens with).
  await link.click();
  await expect(page.getByText('Status: confirmed')).toBeVisible();
  await page.getByRole('button', { name: 'Reschedule' }).click();
  const [target] = await firstDaySlots(request, 'Europe/Berlin');
  await timeButton(page, target!).click();
  await expect(page.getByRole('status')).toHaveText(/^Moved to /);
  expect((await bookingByToken(request, token)).start_at).toBe(target!.start_at);

  await page.getByRole('button', { name: 'Cancel booking' }).click();
  await page.getByLabel('Reason (optional)').fill('E2E: plans changed');
  await page.getByRole('button', { name: 'Yes, cancel my booking' }).click();
  await expect(page.getByRole('status')).toHaveText('Your booking is cancelled.');
  await expect(page.getByRole('button', { name: 'Reschedule' })).toHaveCount(0);

  const final = await bookingByToken(request, token);
  expect([final.status, final.start_at, final.cancel_reason]).toEqual(['cancelled', target!.start_at, 'E2E: plans changed']);
});

test('two guests race for the same time: one holds it, the other is told it was just taken', async ({ browser, request }) => {
  const [slot] = await firstDaySlots(request, 'Europe/Berlin');
  const a = await (await browser.newContext()).newPage();
  const b = await (await browser.newContext()).newPage();
  await Promise.all([a.goto(PAGE), b.goto(PAGE)]);
  await expect(timeButton(a, slot!)).toBeVisible();
  await expect(timeButton(b, slot!)).toBeVisible(); // both see it as free

  await timeButton(a, slot!).click();
  await expect(a.locator('.countdown')).toBeVisible();
  await timeButton(b, slot!).click();
  await expect(b.getByRole('alert')).toHaveText(/that time was just taken/);
  await expect(timeButton(b, slot!)).toHaveCount(0); // B's list was refreshed without it
  await expect(b.getByRole('button', { name: 'Confirm booking' })).toHaveCount(0);

  // A still has it and can book it.
  const guest = uniqueGuest();
  await a.getByLabel('Name').fill(guest.name);
  await a.getByLabel('Email').fill(guest.email);
  await a.getByRole('button', { name: 'Confirm booking' }).click();
  await expect(a.getByRole('heading', { name: "You're booked" })).toBeVisible();
  await a.context().close();
  await b.context().close();
});

test('the same instant is shown in each browser’s own zone, and the switcher relabels it', async ({ browser, request }) => {
  const ny = await freeSlots(request, 'America/New_York');
  const kolkata = await freeSlots(request, 'Asia/Kolkata');
  // Same first free instant, two different local labels (server-side labels, checked below in the UI).
  expect(kolkata[0]!.start_at).toBe(ny[0]!.start_at);
  expect(kolkata[0]!.local.label).not.toBe(ny[0]!.local.label);

  const nyPage = await (await browser.newContext({ timezoneId: 'America/New_York' })).newPage();
  await nyPage.goto(PAGE);
  await expect(nyPage.getByText('Times are shown in America/New York')).toBeVisible();
  await expect(timeButton(nyPage, ny[0]!)).toBeVisible();

  // Chromium may report India as the legacy alias Asia/Calcutta; either is accepted by the API.
  const inPage = await (await browser.newContext({ timezoneId: 'Asia/Kolkata' })).newPage();
  await inPage.goto(PAGE);
  await expect(inPage.getByText(/Times are shown in Asia\/(Kolkata|Calcutta)/)).toBeVisible();
  await expect(timeButton(inPage, kolkata[0]!)).toBeVisible();

  // Switching the NY page to Kolkata shows the Kolkata label for the same instant.
  await nyPage.getByLabel('Your time zone').selectOption('Asia/Kolkata');
  await expect(nyPage.getByText('Times are shown in Asia/Kolkata')).toBeVisible();
  await expect(timeButton(nyPage, kolkata[0]!)).toBeVisible();
  await nyPage.context().close();
  await inPage.context().close();
});

test('a browser clock 10 minutes fast changes nothing: the countdown starts near 5:00 and confirm works', async ({ page, request }) => {
  // Only Date is moved; timers and performance.now() keep running (the countdown uses those
  // plus the server's own expires_at − server_now, never the browser's wall clock).
  await page.clock.setFixedTime(new Date(Date.now() + 10 * 60_000));
  const [slot] = await firstDaySlots(request, 'Europe/Berlin');
  await page.goto(PAGE);
  await timeButton(page, slot!).click();
  await expect(page.locator('.countdown')).toHaveText(/^Held for (5:00|4:[3-5]\d)$/);
  const guest = uniqueGuest();
  await page.getByLabel('Name').fill(guest.name);
  await page.getByLabel('Email').fill(guest.email);
  await page.getByRole('button', { name: 'Confirm booking' }).click();
  await expect(page.getByRole('heading', { name: "You're booked" })).toBeVisible();
});

test('leaving the page releases the hold (pagehide + keepalive): the time is offered again', async ({ page, request }) => {
  const [slot] = await firstDaySlots(request, 'Europe/Berlin');
  const offered = async () => (await freeSlots(request, 'Europe/Berlin')).some((s) => s.start_at === slot!.start_at);

  await page.goto(PAGE);
  await timeButton(page, slot!).click();
  await expect(page.locator('.countdown')).toBeVisible();
  expect(await offered()).toBe(false); // held → not offered to anyone else

  await page.goto('about:blank'); // navigating away fires pagehide
  await expect.poll(offered, { timeout: 10_000 }).toBe(true); // released long before the 5-minute expiry
});
