import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { createDb } from '../../../src/server/db/kysely.js';
import { testDatabaseUrl, testDb, truncateAll } from '../../helpers/db.js';
import { assertSeatInvariant } from '../../helpers/invariants.js';
import { makeApp } from '../../helpers/app.js';
import { scenario } from '../../helpers/scenario.js';

/**
 * Found by the k6 load test (many hosts at 200 iterations/s): when every pooled connection is
 * busy for longer than the pool's connectionTimeoutMillis, pg-pool throws a plain
 * Error('timeout exceeded when trying to connect'), which used to become a 500 INTERNAL.
 * Overload must be a 503 with Retry-After (like HOST_BUSY), never a 500.
 */
const db = testDb();
afterAll(() => db.destroy());
beforeEach(() => truncateAll(db));
afterEach(() => assertSeatInvariant(db));

/** An app whose pool has ONE connection and gives up waiting for it after 150 ms. */
async function starvedApp() {
  const tiny = createDb({ connectionString: testDatabaseUrl(), max: 1, connectionTimeoutMillis: 150 });
  const app = await makeApp(tiny);
  let release!: () => void;
  const released = new Promise<void>((r) => { release = r; });
  let taken!: () => void;
  const isTaken = new Promise<void>((r) => { taken = r; });
  // Occupy the only connection (an open transaction keeps it checked out).
  const hog = tiny.transaction().execute(async (trx) => { await sql`SELECT 1`.execute(trx); taken(); await released; });
  await isTaken;
  return { app, done: async () => { release(); await hog; await app.close(); await tiny.destroy(); } };
}

describe('pool exhausted → 503 SERVER_BUSY with Retry-After, never 500', () => {
  it('GET slots and POST /api/holds both get 503 while no connection is free', async () => {
    const sc = await scenario(db);
    const { app, done } = await starvedApp();
    try {
      const slots = await app.inject({ method: 'GET', url: `/api/hosts/${sc.hostSlug}/events/${sc.ev.slug}/slots?from=${sc.slot.toISOString()}&to=${new Date(sc.slot.getTime() + 86_400_000).toISOString()}&tz=UTC` });
      const hold = await app.inject({ method: 'POST', url: '/api/holds', headers: { 'idempotency-key': 'k-overload-1' }, payload: { host: sc.hostSlug, slug: sc.ev.slug, start_at: sc.slot.toISOString() } });
      for (const res of [slots, hold]) {
        expect([res.statusCode, res.headers['retry-after'], res.json().error.code]).toEqual([503, '1', 'SERVER_BUSY']);
      }
    } finally {
      await done();
    }
    // Nothing was stored for the refused hold; the same key works once a connection is free.
    expect(await db.selectFrom('idempotency_keys').selectAll().execute()).toEqual([]);
  });

  it('a real error is still a 500 (the check is specific to the pool timeout)', async () => {
    const app = await makeApp(db);
    app.get('/api/__test/other', async () => { throw new Error('timeout exceeded somewhere else'); });
    const res = await app.inject({ method: 'GET', url: '/api/__test/other' });
    expect([res.statusCode, res.json().error.code]).toEqual([500, 'INTERNAL']);
    await app.close();
  });
});
