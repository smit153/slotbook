import { afterEach, describe, expect, it, vi } from 'vitest';
import { DateTime } from 'luxon';
import { api, ApiError } from '../../src/web/lib/api.js';
import { formatRange, groupByDay, nextDaysRange, slotButtonLabel, zoneAbbr } from '../../src/web/lib/time.js';
import { deadlineFrom, formatMmSs, remainingMs } from '../../src/web/lib/countdown.js';
import { checkAvailability } from '../../src/web/lib/availability-check.js';

describe('time helpers', () => {
  it('fall-back duplicates get their zone on the button; other times stay plain', () => {
    const tz = 'America/New_York';
    expect(slotButtonLabel({ start_at: '2026-11-01T05:00:00Z', local: { time: '01:00', ambiguous: true } }, tz)).toBe('01:00 EDT');
    expect(slotButtonLabel({ start_at: '2026-11-01T06:00:00Z', local: { time: '01:00', ambiguous: true } }, tz)).toBe('01:00 EST');
    expect(slotButtonLabel({ start_at: '2026-11-02T14:00:00Z', local: { time: '09:00', ambiguous: false } }, tz)).toBe('09:00');
  });

  it('dashboard ranges always carry the zone', () => {
    expect(formatRange('2026-11-02T14:00:00Z', '2026-11-02T14:30:00Z', 'America/New_York')).toBe('09:00–09:30 EST');
    expect(zoneAbbr('2026-10-26T13:00:00Z', 'Europe/Berlin')).toBe('GMT+1');
  });

  it('groupByDay keeps order and splits on the date key', () => {
    const g = groupByDay(['a1', 'a2', 'b1'], (s) => s[0]!);
    expect(g).toEqual([{ date: 'a', items: ['a1', 'a2'] }, { date: 'b', items: ['b1'] }]);
  });

  it('nextDaysRange is [start of today, +N days) in the chosen zone', () => {
    const now = DateTime.fromISO('2026-11-09T03:00:00Z');
    expect(nextDaysRange('America/New_York', 30, now)).toEqual({ from: '2026-11-08T05:00:00.000Z', to: '2026-12-08T05:00:00.000Z' });
    expect(nextDaysRange('Asia/Kolkata', 1, now)).toEqual({ from: '2026-11-08T18:30:00.000Z', to: '2026-11-09T18:30:00.000Z' });
  });
});

describe('countdown uses the server offset, not the browser clock', () => {
  it('a browser clock 10 minutes off changes nothing', () => {
    const d = deadlineFrom('2026-11-09T10:05:00Z', '2026-11-09T10:00:00Z', 1_000);
    expect(remainingMs(d, 1_000)).toBe(5 * 60_000);
    expect(remainingMs(d, 1_000 + 61_000)).toBe(239_000);
    expect(remainingMs(d, 1_000 + 10 * 60_000)).toBe(0);
    expect(formatMmSs(239_000)).toBe('3:59');
    expect(formatMmSs(5 * 60_000)).toBe('5:00');
  });
});

describe('availability client checks', () => {
  const base = { weekly: [], overrides: [] };
  it('flags overlap, end ≤ start, day off with hours, custom with none, duplicate dates', () => {
    const errs = checkAvailability({
      weekly: [{ weekday: 1, start: '09:00', end: '12:00' }, { weekday: 1, start: '11:00', end: '13:00' }, { weekday: 2, start: '10:00', end: '09:00' }],
      overrides: [
        { date: '2030-12-24', kind: 'off', windows: [{ start: '09:00', end: '10:00' }] },
        { date: '2030-12-25', kind: 'custom', windows: [] },
        { date: '2030-12-25', kind: 'off', windows: [] },
      ],
    });
    expect(errs.map((e) => e.path).sort()).toEqual(['overrides.0', 'overrides.1', 'overrides.2', 'weekly.1', 'weekly.2']);
  });

  it('accepts touching windows, 24:00 and a clean form', () => {
    expect(checkAvailability({ ...base, weekly: [{ weekday: 3, start: '09:00', end: '12:00' }, { weekday: 3, start: '12:00', end: '24:00' }] })).toEqual([]);
  });
});

describe('api client', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('503 is retried once with the SAME Idempotency-Key after Retry-After', async () => {
    const seen: Array<string | null> = [];
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      seen.push(new Headers(init.headers).get('idempotency-key'));
      return seen.length === 1
        ? new Response('{"error":{"code":"HOST_BUSY","message":"busy"}}', { status: 503, headers: { 'retry-after': '1' } })
        : new Response('{"ok":true}', { status: 201 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const waits: number[] = [];
    const out = await api('/api/holds', { method: 'POST', body: {}, idempotencyKey: 'k-1', sleep: async (ms) => { waits.push(ms); } });
    expect(out).toEqual({ ok: true });
    expect(seen).toEqual(['k-1', 'k-1']);
    expect(waits).toEqual([1000]);
  });

  it('a second 503 surfaces as ApiError; 4xx are never retried', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":{"code":"TRY_AGAIN","message":"x"}}', { status: 503 })));
    await expect(api('/x', { sleep: async () => {} })).rejects.toMatchObject({ status: 503, code: 'TRY_AGAIN' });

    const f = vi.fn(async () => new Response('{"error":{"code":"SLOT_UNAVAILABLE","message":"taken"}}', { status: 409 }));
    vi.stubGlobal('fetch', f);
    const err = await api('/x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 409, code: 'SLOT_UNAVAILABLE', message: 'taken' });
    expect(f).toHaveBeenCalledTimes(1);
  });
});
