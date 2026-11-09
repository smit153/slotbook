import { expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';

/**
 * Small API helpers so every spec can set up its own state and check the server's view.
 * Nothing here depends on another spec having run (each test stands alone).
 */
export const HOST = 'demo';
export const EVENT = 'intro-30';
export const DEMO_LOGIN = { email: 'demo@slotbook.dev', password: 'demo1234' };

export interface Slot {
  start_at: string;
  end_at: string;
  seats_left: number;
  local: { date: string; time: string; label: string; ambiguous: boolean };
}

/** Free slots for the next 30 days, labelled in `tz` (the same call the booking page makes). */
export async function freeSlots(request: APIRequestContext, tz: string, slug = EVENT): Promise<Slot[]> {
  const from = new Date().toISOString();
  const to = new Date(Date.now() + 30 * 24 * 3600_000).toISOString();
  const res = await request.get(`/api/hosts/${HOST}/events/${slug}/slots`, { params: { from, to, tz } });
  expect(res.status()).toBe(200);
  const slots = ((await res.json()) as { slots: Slot[] }).slots;
  expect(slots.length).toBeGreaterThan(0);
  return slots;
}

/** The free slots on the first day that has any: the day the picker selects by default. */
export async function firstDaySlots(request: APIRequestContext, tz: string): Promise<Slot[]> {
  const slots = await freeSlots(request, tz);
  return slots.filter((s) => s.local.date === slots[0]!.local.date);
}

/** Book through the API (hold + confirm), as another guest would. */
export async function bookViaApi(request: APIRequestContext, slot: Slot, guest: { name: string; email: string; tz: string }) {
  const hold = await request.post('/api/holds', {
    headers: { 'Idempotency-Key': `e2e-${crypto.randomUUID()}` },
    data: { host: HOST, slug: EVENT, start_at: slot.start_at },
  });
  expect(hold.status()).toBe(201);
  const { hold_id, hold_secret } = (await hold.json()) as { hold_id: string; hold_secret: string };
  const confirm = await request.post(`/api/holds/${hold_id}/confirm`, { data: { hold_secret, ...guest } });
  expect(confirm.status()).toBe(200);
  return (await confirm.json()) as { manage_token: string; booking: { id: string; start_at: string; end_at: string } };
}

export async function bookingByToken(request: APIRequestContext, token: string) {
  const res = await request.get(`/api/bookings/${token}`);
  expect(res.status()).toBe(200);
  return ((await res.json()) as { booking: { status: string; start_at: string; cancel_reason: string | null } }).booking;
}

export const uniqueGuest = (tz = 'Europe/Berlin') => {
  const id = crypto.randomUUID().slice(0, 8);
  return { name: `E2E Guest ${id}`, email: `e2e-${id}@example.test`, tz };
};

/** A time button in the picker; its accessible name is the server's label ("Mon 16 Nov, 15:00 GMT+1"). */
export const timeButton = (page: Page, slot: Slot): Locator =>
  page.getByRole('list', { name: /^Times on/ }).getByRole('button', { name: slot.local.label, exact: true });
