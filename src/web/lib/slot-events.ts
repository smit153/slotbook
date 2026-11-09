/**
 * Live slot updates in the page (Phase 14). The server's stream only says "slots changed"; the
 * page then refetches the slots, which is the only source of truth (the hold transaction
 * decides, never this hint).
 *
 * Rate-limit budget: the slots endpoint allows 60 requests/min per IP. Refetches triggered here
 * are throttled to at most one per MIN_REFETCH_MS (5 s) → at most 12/min, plus the page's own
 * loads; the polling fallback adds 2/min. A normal page stays well inside 60/min.
 */
export const MIN_REFETCH_MS = 5_000;
export const POLL_MS = 30_000;
/** No event (not even a heartbeat) for this long → the stream is dead: reconnect. */
export const SILENCE_MS = 60_000;
/** After this many errors in a row (or a refused stream, e.g. 429), stop and poll instead. */
export const MAX_ERRORS = 3;

export interface EventSourceLike {
  readonly readyState: number; // 0 connecting, 1 open, 2 closed
  addEventListener(type: string, fn: () => void): void;
  onerror: (() => void) | null;
  close(): void;
}

export interface WatchOptions {
  url: string;
  onChange: () => void;
  createEventSource?: (url: string) => EventSourceLike;
  now?: () => number;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (t: unknown) => void;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (t: unknown) => void;
  /** Reports the current mode, for the page and for tests. */
  onMode?: (mode: 'live' | 'polling') => void;
}

/** Start watching; returns stop(). */
export function watchSlots(o: WatchOptions): () => void {
  const now = o.now ?? (() => Date.now());
  const st = o.setTimeout ?? ((fn, ms) => globalThis.setTimeout(fn, ms));
  const ct = o.clearTimeout ?? ((t) => globalThis.clearTimeout(t as ReturnType<typeof setTimeout>));
  const si = o.setInterval ?? ((fn, ms) => globalThis.setInterval(fn, ms));
  const ci = o.clearInterval ?? ((t) => globalThis.clearInterval(t as ReturnType<typeof setInterval>));
  const create = o.createEventSource ?? (typeof EventSource === 'undefined' ? null : (url: string) => new EventSource(url) as unknown as EventSourceLike);

  let stopped = false;
  let es: EventSourceLike | null = null;
  let errors = 0;
  let lastSeen = now();
  let lastFire = -Infinity;
  let trailing: unknown = null;
  let watchdog: unknown = null;
  let poller: unknown = null;

  const fire = () => {
    if (stopped) return;
    lastFire = now();
    o.onChange();
  };
  /** Throttle: at most one refetch per MIN_REFETCH_MS; a burst ends with one trailing refetch. */
  const changed = () => {
    lastSeen = now();
    if (trailing !== null) return;
    const wait = lastFire + MIN_REFETCH_MS - now();
    if (wait <= 0) fire();
    else trailing = st(() => { trailing = null; fire(); }, wait);
  };

  const startPolling = () => {
    if (stopped || poller !== null) return;
    es?.close();
    es = null;
    if (watchdog !== null) { ci(watchdog); watchdog = null; }
    o.onMode?.('polling');
    poller = si(fire, POLL_MS);
  };

  const open = () => {
    if (stopped || !create) return startPolling();
    es = create(o.url);
    lastSeen = now();
    es.addEventListener('ready', () => { errors = 0; lastSeen = now(); o.onMode?.('live'); });
    es.addEventListener('ping', () => { lastSeen = now(); });
    es.addEventListener('slots', changed);
    es.onerror = () => {
      errors += 1;
      // readyState 2: the browser gave up (e.g. 429/503 or not an event stream) → no auto-retry.
      if (es?.readyState === 2 || errors >= MAX_ERRORS) startPolling();
    };
  };

  open();
  if (create) {
    watchdog = si(() => {
      if (stopped || poller !== null) return;
      if (now() - lastSeen > SILENCE_MS) {
        // Half-open connection: close it ourselves and reconnect (counts as an error).
        es?.close();
        errors += 1;
        if (errors >= MAX_ERRORS) startPolling();
        else { open(); changed(); }
      }
    }, SILENCE_MS / 4);
  }

  return () => {
    stopped = true;
    es?.close();
    if (trailing !== null) ct(trailing);
    if (watchdog !== null) ci(watchdog);
    if (poller !== null) ci(poller);
  };
}
