/**
 * Tiny typed client for the Slotbook API (design §7).
 *  - JSON in/out; errors {error:{code,message}} become ApiError.
 *  - 503 (HOST_BUSY / TRY_AGAIN) means the server rolled back, so ONE automatic retry after
 *    Retry-After is always safe. The caller's Idempotency-Key is reused for that retry.
 *  - 4xx are never retried.
 */
export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface ApiOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  idempotencyKey?: string;
  /** Extra request headers (e.g. Waitlist-Token). */
  headers?: Record<string, string>;
  /** Best effort, survives page unload (used for releasing a hold on pagehide). */
  keepalive?: boolean;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const MAX_RETRY_WAIT_MS = 3_000;

export async function api<T>(path: string, opts: ApiOptions = {}): Promise<T> {
  const method = opts.method ?? 'GET';
  const headers: Record<string, string> = { accept: 'application/json' };
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.idempotencyKey) headers['idempotency-key'] = opts.idempotencyKey;
  Object.assign(headers, opts.headers);

  for (let attempt = 1; ; attempt++) {
    const res = await fetch(path, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      credentials: 'same-origin',
      keepalive: opts.keepalive,
    });
    if (res.status === 503 && attempt === 1) {
      const wait = Math.min(Number(res.headers.get('retry-after') ?? '1') * 1000 || 1000, MAX_RETRY_WAIT_MS);
      await (opts.sleep ?? defaultSleep)(wait);
      continue;
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    const data = text ? (JSON.parse(text) as unknown) : undefined;
    if (!res.ok) {
      const e = (data as { error?: { code?: string; message?: string } } | undefined)?.error;
      throw new ApiError(res.status, e?.code ?? 'HTTP_ERROR', e?.message ?? `Request failed (${res.status})`);
    }
    return data as T;
  }
}

export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

// ───────────── response shapes (mirroring the server) ─────────────
export interface Slot {
  start_at: string;
  end_at: string;
  seats_left: number;
  /** Only when slots were requested with include_full=1, on full slots (design §13.5). */
  waitlist?: { open: boolean; waiting: number };
  local: { date: string; time: string; label: string; ambiguous: boolean };
}
export interface WaitlistJoined { entry_id: string; waitlist_token: string; waitlist_url: string; position: number }
export interface WaitlistState {
  status: 'waiting' | 'offered' | 'booked' | 'lapsed' | 'left' | 'closed';
  position: number | null;
  offer: { expires_at: string; server_now: string } | null;
  name: string;
  slot: { start_at: string; end_at: string; host: { slug: string; name: string }; event_type: { slug: string; name: string; duration_min: number } };
}
export interface EventInfo {
  host: { slug: string; name: string; timezone: string };
  event_type: { slug: string; name: string; duration_min: number; capacity: number; min_notice_min: number; horizon_days: number };
}
export interface SlotsResponse extends EventInfo { tz: string; from: string; to: string; slots: Slot[] }
export interface Hold { hold_id: string; hold_secret: string; expires_at: string; server_now: string; start_at: string; end_at: string }
export interface Booking {
  id: string;
  status: 'held' | 'confirmed' | 'cancelled' | 'expired';
  start_at: string;
  end_at: string;
  guest_name: string | null;
  guest_email: string | null;
  guest_tz: string | null;
  host: { slug: string; name: string; timezone: string };
  event_type: { slug: string; name: string; duration_min: number };
  cancel_reason: string | null;
  cancelled_by: string | null;
}
export interface Confirmed { booking: Booking; manage_token: string; manage_url: string }
export interface HostMe { id: string; slug: string; name: string; email: string; timezone: string }
export interface EventType {
  id: string; name: string; slug: string; duration_min: number; capacity: number;
  buffer_before_min: number; buffer_after_min: number; min_notice_min: number; horizon_days: number; active: boolean;
}
export interface HostBooking {
  id: string; status: string; start_at: string; end_at: string; guest_name: string | null; guest_email: string | null;
  guest_tz: string | null; cancel_reason: string | null; cancelled_by: string | null; cancelled_at: string | null;
  event_slug: string; event_name: string;
}
export interface WindowRow { start: string; end: string }
export interface Availability {
  weekly: Array<WindowRow & { weekday: number }>;
  overrides: Array<{ date: string; kind: 'off' | 'custom'; windows: WindowRow[] }>;
}
export interface NotificationRow { id: number; type: string; payload: Record<string, unknown>; created_at: string; delivered_at: string | null }
