import { expect, test, type Locator, type Page } from '@playwright/test';
import { EVENT, firstDaySlots, HOST, timeButton, uniqueGuest } from './api.js';

/**
 * Keyboard only: no clicks and no programmatic focus. Focus moves with Tab, buttons and links
 * are activated with Enter, forms submit with Enter. Also checks that the focused control
 * shows a visible focus ring. (A screen-reader walk-through is NOT covered; see README.)
 */
async function tabTo(page: Page, target: Locator, maxTabs = 250): Promise<void> {
  for (let i = 0; i < maxTabs; i++) {
    if (await target.evaluate((el) => el === document.activeElement).catch(() => false)) {
      const outline = await target.evaluate((el) => getComputedStyle(el).outlineStyle);
      expect(outline, 'focused control must show a focus ring').not.toBe('none');
      return;
    }
    await page.keyboard.press('Tab');
  }
  throw new Error(`could not reach ${target.toString()} with ${maxTabs} Tab presses`);
}

test('keyboard only: book a time, open the manage link, cancel', async ({ page, request }) => {
  const [slot] = await firstDaySlots(request, 'Europe/Berlin');
  const guest = uniqueGuest();
  await page.goto(`/${HOST}/${EVENT}`);
  await expect(timeButton(page, slot!)).toBeVisible();

  await tabTo(page, timeButton(page, slot!));
  await page.keyboard.press('Enter');
  await expect(page.locator('.countdown')).toBeVisible();

  await tabTo(page, page.getByLabel('Name'));
  await page.keyboard.type(guest.name);
  await page.keyboard.press('Tab'); // Name → Email: the natural order
  await expect(page.getByLabel('Email')).toBeFocused();
  await page.keyboard.type(guest.email);
  await page.keyboard.press('Enter'); // submits the form
  await expect(page.getByRole('heading', { name: "You're booked" })).toBeVisible();

  await tabTo(page, page.locator('a.manage-link'));
  await page.keyboard.press('Enter');
  await expect(page.getByText('Status: confirmed')).toBeVisible();

  await tabTo(page, page.getByRole('button', { name: 'Cancel booking' }));
  await page.keyboard.press('Enter');
  await tabTo(page, page.getByLabel('Reason (optional)'));
  await page.keyboard.type('keyboard test');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('status')).toHaveText('Your booking is cancelled.');
  await expect(page.getByText('Status: cancelled')).toBeVisible();
});
