import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHold } from '../../src/server/services/holds.js';
import { testDb, truncateAll } from '../helpers/db.js';
import { assertSeatInvariant } from '../helpers/invariants.js';
import { APP_SECRET, holdRequest, scenario } from '../helpers/scenario.js';

/** 40P01 / 40001 → one automatic retry of the whole transaction, then 503; never a raw 500. */
const db = testDb();
afterAll(() => db.destroy());
beforeEach(() => truncateAll(db));
afterEach(() => assertSeatInvariant(db));

const pgError = (code: string) => Object.assign(new Error(`simulated ${code}`), { code });
const count = async () => Number((await db.selectFrom('bookings').select((eb) => eb.fn.countAll().as('n')).executeTakeFirstOrThrow()).n);

describe('write transactions: retry on deadlock / serialization failure', () => {
  it.each(['40P01', '40001'])('a single %s is retried transparently → 201, exactly one hold', async (code) => {
    const sc = await scenario(db);
    const attempts: number[] = [];
    const res = await createHold({
      db, appSecret: APP_SECRET,
      faults: { onAttempt: (n) => { attempts.push(n); if (n === 1) throw pgError(code); } },
    }, holdRequest(sc));
    expect(res.status).toBe(201);
    expect(attempts).toEqual([1, 2]);
    expect(await count()).toBe(1);
  });

  it('a failure AFTER the writes (just before COMMIT) is retried too, and still creates one hold', async () => {
    const sc = await scenario(db);
    let n = 0;
    const res = await createHold({
      db, appSecret: APP_SECRET,
      faults: { beforeCommit: () => { n += 1; if (n === 1) throw pgError('40P01'); } },
    }, holdRequest(sc));
    expect(res.status).toBe(201);
    expect(await count()).toBe(1);
  });

  it('failing twice → 503 TRY_AGAIN (not a raw error), nothing stored, same key works later', async () => {
    const sc = await scenario(db);
    const req = holdRequest(sc);
    const res = await createHold({ db, appSecret: APP_SECRET, faults: { onAttempt: () => { throw pgError('40001'); } } }, req);
    expect(res).toMatchObject({ status: 503, body: { error: { code: 'TRY_AGAIN' } } });
    expect(await count()).toBe(0);
    expect(await db.selectFrom('idempotency_keys').selectAll().execute()).toEqual([]);
    expect((await createHold({ db, appSecret: APP_SECRET }, req)).status).toBe(201);
  });

  it('other errors are not retried and propagate (the API layer turns them into a generic 500)', async () => {
    const sc = await scenario(db);
    const attempts: number[] = [];
    await expect(createHold({
      db, appSecret: APP_SECRET,
      faults: { onAttempt: (n) => { attempts.push(n); throw new Error('boom'); } },
    }, holdRequest(sc))).rejects.toThrow('boom');
    expect(attempts).toEqual([1]);
  });
});
