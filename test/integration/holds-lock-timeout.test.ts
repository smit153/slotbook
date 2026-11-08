import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { createHold } from '../../src/server/services/holds.js';
import { testDb, truncateAll } from '../helpers/db.js';
import { assertSeatInvariant } from '../helpers/invariants.js';
import { APP_SECRET, holdRequest, scenario } from '../helpers/scenario.js';

/**
 * Write paths SET LOCAL lock_timeout (design §5.8): a burst on one host fails fast with 503
 * instead of parking every pooled connection behind the host lock.
 */
const db = testDb({ max: 10 });
afterAll(() => db.destroy());
beforeEach(() => truncateAll(db));
afterEach(() => assertSeatInvariant(db));

/** Hold the host row lock until `release()` is called. */
async function holdHostLock(hostId: string) {
  let release!: () => void;
  const released = new Promise<void>((r) => { release = r; });
  let locked!: () => void;
  const isLocked = new Promise<void>((r) => { locked = r; });
  const done = db.transaction().execute(async (trx) => {
    await sql`SELECT id FROM hosts WHERE id = ${hostId} FOR UPDATE`.execute(trx);
    locked();
    await released;
  });
  await isLocked;
  return { release: async () => { release(); await done; } };
}

describe('lock_timeout on the hold path', () => {
  it('a hold stuck behind the host lock longer than lock_timeout gets 503 fast, and nothing is stored', async () => {
    const sc = await scenario(db);
    const lock = await holdHostLock(sc.hostId);
    const req = holdRequest(sc);

    const started = Date.now();
    const res = await createHold({ db, appSecret: APP_SECRET, lockTimeoutMs: 300 }, req);
    const waited = Date.now() - started;
    await lock.release();

    expect(res).toMatchObject({ status: 503, body: { error: { code: 'HOST_BUSY' } } });
    expect(waited).toBeGreaterThanOrEqual(250);
    expect(waited).toBeLessThan(2_000);
    expect(await db.selectFrom('idempotency_keys').selectAll().execute()).toEqual([]);
    expect(await db.selectFrom('bookings').selectAll().execute()).toEqual([]);

    // Not cached: once the host is free, the SAME key goes through.
    expect((await createHold({ db, appSecret: APP_SECRET }, req)).status).toBe(201);
  });

  it('a short wait under the timeout still succeeds', async () => {
    const sc = await scenario(db);
    const lock = await holdHostLock(sc.hostId);
    const pending = createHold({ db, appSecret: APP_SECRET, lockTimeoutMs: 2_000 }, holdRequest(sc));
    await new Promise((r) => setTimeout(r, 200));
    await lock.release();
    expect((await pending).status).toBe(201);
  });

  it('the default timeout is 2.5 s and is scoped to the transaction (SET LOCAL)', async () => {
    const sc = await scenario(db);
    const lock = await holdHostLock(sc.hostId);
    const started = Date.now();
    const res = await createHold({ db, appSecret: APP_SECRET }, holdRequest(sc));
    const waited = Date.now() - started;
    await lock.release();
    expect(res.status).toBe(503);
    expect(waited).toBeGreaterThanOrEqual(2_400);
    expect(waited).toBeLessThan(4_000);

    // The setting did not leak into the pooled connection.
    const { rows } = await sql<{ lock_timeout: string }>`SHOW lock_timeout`.execute(db);
    expect(rows[0]!.lock_timeout).toBe('0');
  }, 10_000);
});
