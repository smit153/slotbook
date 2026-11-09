import pg from 'pg';

/**
 * Live slot updates (Phase 14): ONE shared Postgres connection does `LISTEN slots_changed`
 * and fans each notification out to the streams watching that host.
 *  - The notifications come from triggers inside the booking transactions (migration 0005),
 *    so only COMMITTED changes arrive; a rolled-back hold never notifies.
 *  - Bursts are coalesced per host (coalesceMs), so a busy host doesn't flood clients.
 *  - The connection starts with the first subscriber (no connection if nobody watches) and
 *    reconnects with backoff. After a reconnect every subscriber is told "slots changed",
 *    because notifications sent while it was down are lost.
 * This is only a hint to refetch: the hold transaction stays the only authority.
 */
export interface SlotEventsOptions {
  connectionString: string;
  coalesceMs?: number;
  log?: { warn: (obj: object, msg: string) => void };
}

type Listener = () => void;

export class SlotEventHub {
  private client: pg.Client | null = null;
  private connecting: Promise<void> | null = null;
  private readonly subs = new Map<string, Set<Listener>>();
  private readonly pending = new Map<string, NodeJS.Timeout>();
  private reconnectTimer: NodeJS.Timeout | null = null;
  private delayMs = 250;
  private closed = false;
  private pid: number | null = null;

  constructor(private readonly opts: SlotEventsOptions) {}

  /** Watch one host. Resolves once the listener is connected; returns the unsubscribe function. */
  async subscribe(hostId: string, fn: Listener): Promise<() => void> {
    if (this.closed) throw new Error('slot event hub is closed');
    await this.ensureListening();
    const set = this.subs.get(hostId) ?? new Set<Listener>();
    set.add(fn);
    this.subs.set(hostId, set);
    return () => {
      set.delete(fn);
      if (set.size === 0) this.subs.delete(hostId);
    };
  }

  /** For /metrics-style introspection and tests. */
  stats(): { listening: boolean; hosts: number; subscribers: number; backendPid: number | null } {
    let subscribers = 0;
    for (const s of this.subs.values()) subscribers += s.size;
    return { listening: this.client !== null, hosts: this.subs.size, subscribers, backendPid: this.pid };
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    for (const t of this.pending.values()) clearTimeout(t);
    this.pending.clear();
    this.subs.clear();
    const c = this.client;
    this.client = null;
    if (c) await c.end().catch(() => undefined);
  }

  private async ensureListening(): Promise<void> {
    if (this.client) return;
    this.connecting ??= this.connect().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  private async connect(): Promise<void> {
    const c = new pg.Client({ connectionString: this.opts.connectionString });
    c.on('notification', (msg) => { if (msg.payload) this.onNotify(msg.payload); });
    c.on('error', (err) => this.opts.log?.warn({ err }, 'slot event listener error'));
    c.on('end', () => {
      if (this.client === c) {
        this.client = null;
        this.pid = null;
        this.scheduleReconnect();
      }
    });
    await c.connect();
    await c.query('LISTEN slots_changed');
    const { rows } = await c.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    this.pid = rows[0]!.pid;
    this.client = c;
    this.delayMs = 250;
  }

  private onNotify(hostId: string): void {
    if (!this.subs.has(hostId) || this.pending.has(hostId)) return;
    this.pending.set(hostId, setTimeout(() => {
      this.pending.delete(hostId);
      for (const fn of [...(this.subs.get(hostId) ?? [])]) fn();
    }, this.opts.coalesceMs ?? 200));
  }

  private scheduleReconnect(): void {
    if (this.closed || this.subs.size === 0 || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.ensureListening()
        .then(() => {
          // Anything that changed while we were disconnected was not delivered: resync everyone.
          for (const set of this.subs.values()) for (const fn of [...set]) fn();
        })
        .catch((err: unknown) => {
          this.opts.log?.warn({ err }, 'slot event listener reconnect failed');
          this.delayMs = Math.min(this.delayMs * 2, 10_000);
          this.scheduleReconnect();
        });
    }, this.delayMs);
    this.reconnectTimer.unref();
  }
}
