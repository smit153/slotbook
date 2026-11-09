import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_ERRORS, MIN_REFETCH_MS, POLL_MS, SILENCE_MS, watchSlots, type EventSourceLike } from '../../src/web/lib/slot-events.js';

/** The page side of live updates (Phase 14): throttle, fallback to polling, reconnect on silence. */
class FakeES implements EventSourceLike {
  static all: FakeES[] = [];
  readyState = 0;
  onerror: (() => void) | null = null;
  private handlers = new Map<string, Array<() => void>>();
  constructor(readonly url: string) { FakeES.all.push(this); }
  addEventListener(type: string, fn: () => void) { this.handlers.set(type, [...(this.handlers.get(type) ?? []), fn]); }
  emit(type: string) { for (const fn of this.handlers.get(type) ?? []) fn(); }
  close() { this.readyState = 2; }
}

afterEach(() => { vi.useRealTimers(); FakeES.all = []; });

function start() {
  vi.useFakeTimers();
  const onChange = vi.fn();
  const modes: string[] = [];
  const stop = watchSlots({ url: '/stream', onChange, createEventSource: (u) => new FakeES(u), now: () => Date.now(), onMode: (m) => modes.push(m) });
  const es = FakeES.all[0]!;
  es.readyState = 1;
  es.emit('ready');
  return { onChange, stop, es, modes };
}

describe('watchSlots', () => {
  it(`throttles: a burst of changes → one refetch now and one trailing; never more than one per ${MIN_REFETCH_MS / 1000} s`, () => {
    const { onChange, stop, es } = start();
    for (let i = 0; i < 10; i++) es.emit('slots');
    expect(onChange).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(MIN_REFETCH_MS);
    expect(onChange).toHaveBeenCalledTimes(2);

    // A host changing constantly for a minute: ≤ 13 refetches (well inside the 60/min slots limit).
    onChange.mockClear();
    for (let t = 0; t < 60_000; t += 100) { es.emit('slots'); es.emit('ping'); vi.advanceTimersByTime(100); }
    expect(onChange.mock.calls.length).toBeLessThanOrEqual(13);
    expect(onChange.mock.calls.length).toBeGreaterThanOrEqual(11);
    stop();
  });

  it('a refused stream (readyState 2, e.g. 429) → falls back to polling every 30 s', () => {
    const { onChange, stop, es, modes } = start();
    es.readyState = 2;
    es.onerror?.();
    expect(modes.at(-1)).toBe('polling');
    vi.advanceTimersByTime(POLL_MS * 2);
    expect(onChange).toHaveBeenCalledTimes(2);
    stop();
  });

  it(`after ${MAX_ERRORS} errors in a row (browser keeps retrying) → polling`, () => {
    const { stop, es, modes } = start();
    for (let i = 0; i < MAX_ERRORS; i++) es.onerror?.();
    expect(modes.at(-1)).toBe('polling');
    stop();
  });

  it('silence (no heartbeat) for longer than 60 s → reconnects with a new stream and refetches once', () => {
    const { onChange, stop } = start();
    vi.advanceTimersByTime(SILENCE_MS + SILENCE_MS / 4);
    expect(FakeES.all).toHaveLength(2);
    expect(FakeES.all[0]!.readyState).toBe(2);
    expect(onChange).toHaveBeenCalledTimes(1); // catch up on anything missed while it was dead
    stop();
  });

  it('heartbeats keep it live: no reconnect while pings arrive', () => {
    const { stop, es } = start();
    for (let t = 0; t < 5 * 60_000; t += 25_000) { es.emit('ping'); vi.advanceTimersByTime(25_000); }
    expect(FakeES.all).toHaveLength(1);
    stop();
  });

  it('stop() ends everything: no more refetches', () => {
    const { onChange, stop, es } = start();
    es.emit('slots');
    es.emit('slots');
    stop();
    vi.advanceTimersByTime(60_000);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(es.readyState).toBe(2);
  });
});
