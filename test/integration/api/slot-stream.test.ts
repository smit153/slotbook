import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import type { FastifyInstance } from 'fastify';
import { testDb, truncateAll } from '../../helpers/db.js';
import { assertSeatInvariant } from '../../helpers/invariants.js';
import { makeApp } from '../../helpers/app.js';
import { scenario, type Scenario } from '../../helpers/scenario.js';
import { MAX_STREAMS_PER_IP } from '../../../src/server/routes/stream.js';

/**
 * Live slot updates (Phase 14) over a REAL listening server (app.inject cannot stream).
 * The notifications come from triggers inside the booking transactions (migration 0005).
 */
const db = testDb({ max: 10 });
let app: FastifyInstance;
let base: string;
afterAll(() => db.destroy());
beforeEach(async () => {
  await truncateAll(db);
  app = await makeApp(db, { streamHeartbeatMs: 150 });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const addr = app.server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});
afterEach(async () => {
  await app.close();
  await assertSeatInvariant(db);
});

/** Open a stream and collect its text; `until(re)` waits for the pattern (or times out). */
async function openStream(sc: Scenario) {
  const ctl = new AbortController();
  const res = await fetch(`${base}/api/hosts/${sc.hostSlug}/events/${sc.ev.slug}/stream`, { signal: ctl.signal });
  let text = '';
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  void (async () => {
    try { for (;;) { const { done, value } = await reader.read(); if (done) break; text += decoder.decode(value, { stream: true }); } } catch { /* aborted */ }
  })();
  const count = (re: RegExp) => (text.match(new RegExp(re.source, 'g')) ?? []).length;
  return {
    res,
    text: () => text,
    count,
    async until(re: RegExp, n = 1, timeoutMs = 4_000) {
      const end = Date.now() + timeoutMs;
      while (count(re) < n) {
        if (Date.now() > end) throw new Error(`timed out waiting for ${re} ×${n}; got: ${JSON.stringify(text)}`);
        await new Promise((r) => setTimeout(r, 20));
      }
    },
    close: () => ctl.abort(),
  };
}
const SLOTS = /event: slots\ndata: \{\}\n\n/;
const hold = (sc: Scenario, key: string, extra: { headers?: Record<string, string> } = {}) =>
  fetch(`${base}/api/holds`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': key, ...extra.headers },
    body: JSON.stringify({ host: sc.hostSlug, slug: sc.ev.slug, start_at: sc.slot.toISOString() }),
  });

describe('GET …/stream (Server-Sent Events)', () => {
  it('a hold by one client sends "slots changed" to another client watching the event type', async () => {
    const sc = await scenario(db);
    const s = await openStream(sc);
    expect(s.res.headers.get('content-type')).toMatch(/^text\/event-stream/);
    expect(s.res.headers.get('cache-control')).toBe('no-store');
    await s.until(/event: ready/);
    expect((await hold(sc, 'k-stream-0001')).status).toBe(201);
    await s.until(SLOTS);
    // Only the signal: no booking id, no guest data, nothing but `{}` as data.
    expect(s.text().split('\n').filter((l) => l.startsWith('data:')).every((l) => l === 'data: {}')).toBe(true);
    s.close();
  });

  it('a ROLLED-BACK change sends nothing; the next committed change does', async () => {
    const sc = await scenario(db);
    const s = await openStream(sc);
    await s.until(/event: ready/);
    // Write a booking row inside a transaction that then fails: the trigger ran, the notify didn't go out.
    await expect(db.transaction().execute(async (trx) => {
      await sql`UPDATE event_types SET name = name WHERE id = ${sc.ev.id}`.execute(trx);
      throw new Error('roll back');
    })).rejects.toThrow('roll back');
    await new Promise((r) => setTimeout(r, 800)); // well past the 200 ms coalescing window
    expect(s.count(SLOTS)).toBe(0);

    expect((await hold(sc, 'k-stream-0002')).status).toBe(201);
    await s.until(SLOTS);
    s.close();
  });

  it('a change for another host does not wake this stream', async () => {
    const mine = await scenario(db);
    const other = await scenario(db, { hostSlug: 'other-host' });
    const s = await openStream(mine);
    await s.until(/event: ready/);
    expect((await hold(other, 'k-stream-0003')).status).toBe(201);
    await new Promise((r) => setTimeout(r, 800));
    expect(s.count(SLOTS)).toBe(0);
    s.close();
  });

  it('heartbeats keep the stream alive (`event: ping`)', async () => {
    const sc = await scenario(db);
    const s = await openStream(sc);
    await s.until(/event: ping/, 2);
    s.close();
  });

  it(`at most ${MAX_STREAMS_PER_IP} concurrent streams per IP → 429 STREAM_LIMIT; closing one frees a place`, async () => {
    const sc = await scenario(db);
    const streams = [];
    for (let i = 0; i < MAX_STREAMS_PER_IP; i++) { const s = await openStream(sc); await s.until(/event: ready/); streams.push(s); }
    const over = await fetch(`${base}/api/hosts/${sc.hostSlug}/events/${sc.ev.slug}/stream`);
    expect([over.status, ((await over.json()) as { error: { code: string } }).error.code, over.headers.get('retry-after')]).toEqual([429, 'STREAM_LIMIT', '30']);
    streams.pop()!.close();
    await new Promise((r) => setTimeout(r, 200));
    const again = await openStream(sc);
    await again.until(/event: ready/);
    for (const s of [...streams, again]) s.close();
  });

  it('the shared listener reconnects after its connection is killed, and resyncs every stream', async () => {
    const sc = await scenario(db);
    const s = await openStream(sc);
    await s.until(/event: ready/);
    const pid = (await sql<{ pid: number }>`
      SELECT pid FROM pg_stat_activity WHERE query = 'SELECT pg_backend_pid() AS pid' OR query LIKE 'LISTEN%'`.execute(db)).rows;
    expect(pid.length).toBeGreaterThan(0);
    for (const p of pid) await sql`SELECT pg_terminate_backend(${p.pid})`.execute(db);
    await s.until(SLOTS, 1, 6_000); // the resync after reconnecting
    expect((await hold(sc, 'k-stream-0004')).status).toBe(201);
    await s.until(SLOTS, 2, 6_000); // and live notifications flow again
    s.close();
  });

  it('an unknown event type → 404 JSON (no stream)', async () => {
    const res = await fetch(`${base}/api/hosts/nobody/events/none/stream`);
    expect([res.status, ((await res.json()) as { error: { code: string } }).error.code]).toEqual([404, 'NOT_FOUND']);
  });
});
