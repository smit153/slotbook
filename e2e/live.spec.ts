import { expect, test } from '@playwright/test';
import { EVENT, firstDaySlots, HOST, timeButton } from './api.js';

/**
 * Live slot updates (Phase 14) in real browsers: guest A holds a time, and guest B's open page
 * shows it as taken WITHOUT a reload (the stream says "slots changed", B refetches). B's page
 * must get there long before its 30 s polling fallback would.
 */
test('a hold in one browser updates the other browser’s page without a reload', async ({ browser, request }) => {
  const [slot] = await firstDaySlots(request, 'Europe/Berlin');
  const a = await (await browser.newContext()).newPage();
  const b = await (await browser.newContext()).newPage();
  const slotRequests: number[] = [];
  b.on('request', (r) => { if (r.url().includes('/slots?')) slotRequests.push(Date.now()); });
  const streamOpened = b.waitForResponse((r) => r.url().endsWith(`/events/${EVENT}/stream`) && r.status() === 200);

  await Promise.all([a.goto(`/${HOST}/${EVENT}`), b.goto(`/${HOST}/${EVENT}`)]);
  await streamOpened;
  await expect(timeButton(b, slot!)).toBeVisible();
  const before = slotRequests.length;
  const t0 = Date.now();

  await timeButton(a, slot!).click();
  await expect(a.locator('.countdown')).toBeVisible();

  // B: the time turns into "full, join the waitlist" on its own (capacity 1, now held by A).
  const full = b.getByRole('list', { name: /^Times on/ }).getByRole('button', { name: `${slot!.local.label}, full: join the waitlist`, exact: true });
  await expect(full).toBeVisible({ timeout: 10_000 });
  expect(Date.now() - t0).toBeLessThan(10_000);
  expect(slotRequests.length).toBeGreaterThan(before); // it refetched…
  expect(slotRequests.length - before).toBeLessThanOrEqual(2); // …once (throttled), not in a loop

  // Release A's hold so the per-IP cap stays clean for the other tests.
  await a.goto('about:blank');
  await a.context().close();
  await b.context().close();
});
