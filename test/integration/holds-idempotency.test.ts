import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { createHold, type HoldCreated } from '../../src/server/services/holds.js';
import { testDb, truncateAll } from '../helpers/db.js';
import { assertSeatInvariant } from '../helpers/invariants.js';
import { APP_SECRET, holdRequest, scenario } from '../helpers/scenario.js';

const db = testDb({ max: 20 });
const deps = { db, appSecret: APP_SECRET };
afterAll(() => db.destroy());
beforeEach(() => truncateAll(db));
afterEach(() => assertSeatInvariant(db));

const count = async (t: 'bookings' | 'idempotency_keys') =>
  Number((await db.selectFrom(t).select((eb) => eb.fn.countAll().as('n')).executeTakeFirstOrThrow()).n);
const created = (r: { body: unknown }) => r.body as HoldCreated;
const withoutClock = ({ server_now: _n, ...rest }: HoldCreated) => rest;

describe('R5: retries with the same Idempotency-Key', () => {
  it('a sequential retry (e.g. the response was lost) replays the same hold and the same secret', async () => {
    const sc = await scenario(db);
    const req = holdRequest(sc);
    const first = await createHold(deps, req);
    const second = await createHold(deps, req);

    expect(first.status).toBe(201);
    expect(second).toMatchObject({ status: 201, replayed: true });
    expect(withoutClock(created(second))).toEqual(withoutClock(created(first)));
    expect(await count('bookings')).toBe(1);
  });

  it('10 concurrent requests with one key (double-click storm) → one hold, ten identical answers', async () => {
    const sc = await scenario(db);
    const req = holdRequest(sc);
    const results = await Promise.all(Array.from({ length: 10 }, () => createHold(deps, req)));

    expect(results.every((r) => r.status === 201)).toBe(true);
    expect(new Set(results.map((r) => created(r).hold_id)).size).toBe(1);
    expect(new Set(results.map((r) => created(r).hold_secret)).size).toBe(1);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(await count('bookings')).toBe(1);
  });

  it('the replay carries the CURRENT server time (for the countdown), not the stored one', async () => {
    const sc = await scenario(db);
    const req = holdRequest(sc);
    const first = created(await createHold(deps, req));
    await new Promise((r) => setTimeout(r, 30));
    const again = created(await createHold(deps, req));
    expect(new Date(again.server_now).getTime()).toBeGreaterThan(new Date(first.server_now).getTime());
    expect(again.expires_at).toBe(first.expires_at);
  });

  it('the same instant written with a different offset is the same request', async () => {
    const sc = await scenario(db);
    const req = holdRequest(sc);
    const first = await createHold(deps, req);
    // 14:00Z written as 09:00-05:00 (EST): same hash → replay, not 422.
    const offsetForm = new Date(req.start_at).toISOString().replace('Z', '+00:00');
    const second = await createHold(deps, { ...req, start_at: offsetForm });
    expect(second).toMatchObject({ status: 201, replayed: true });
    expect(created(second).hold_id).toBe(created(first).hold_id);
  });
});

describe('R18: same key, different request', () => {
  it('→ 422 IDEMPOTENCY_KEY_REUSED, and the original response is untouched', async () => {
    const sc = await scenario(db);
    const req = holdRequest(sc);
    const first = await createHold(deps, req);
    const other = await createHold(deps, { ...req, start_at: new Date(sc.slot.getTime() + 30 * 60_000).toISOString() });

    expect(other).toMatchObject({ status: 422, body: { error: { code: 'IDEMPOTENCY_KEY_REUSED' } } });
    expect(created(await createHold(deps, req)).hold_id).toBe(created(first).hold_id);
    expect(await count('bookings')).toBe(1);
  });
});

describe('R19: a stored 409/422 stays the answer for that key', () => {
  it('a retry after a 409 is still 409 even once the slot has become free', async () => {
    const sc = await scenario(db);
    const winner = await createHold(deps, holdRequest(sc));
    const loserReq = holdRequest(sc);
    expect((await createHold(deps, loserReq)).status).toBe(409);

    // The winner's hold expires: the slot is free again.
    await sql`UPDATE bookings SET expires_at = clock_timestamp() - interval '1 second' WHERE id = ${created(winner).hold_id}`.execute(db);

    expect(await createHold(deps, loserReq)).toMatchObject({ status: 409, replayed: true, body: { error: { code: 'SLOT_UNAVAILABLE' } } });
    // A NEW intent (new key) gets the free slot.
    expect((await createHold(deps, holdRequest(sc))).status).toBe(201);
  });

  it('422 SLOT_NOT_OFFERED is stored and replayed too', async () => {
    const sc = await scenario(db);
    const offGrid = holdRequest(sc, { startAt: new Date(sc.slot.getTime() + 10 * 60_000) });
    expect((await createHold(deps, offGrid)).status).toBe(422);
    expect(await createHold(deps, offGrid)).toMatchObject({ status: 422, replayed: true });
  });
});

describe('what is NOT stored for a key', () => {
  it('400 (bad key or body) and 404 (unknown host) leave no key row behind', async () => {
    const sc = await scenario(db);
    expect((await createHold(deps, holdRequest(sc, { key: 'short' }))).status).toBe(400);
    expect((await createHold(deps, { ...holdRequest(sc), start_at: 'tomorrow' })).status).toBe(400);
    expect((await createHold(deps, { ...holdRequest(sc), host: 'nobody' })).status).toBe(404);
    expect(await count('idempotency_keys')).toBe(0);
  });
});

describe('R13: crash just before COMMIT', () => {
  it('leaves no booking, seat or key behind, and a retry with the SAME key succeeds', async () => {
    const sc = await scenario(db);
    const req = holdRequest(sc);
    const crashing = { ...deps, faults: { beforeCommit: () => { throw new Error('simulated crash before COMMIT'); } } };

    await expect(createHold(crashing, req)).rejects.toThrow(/simulated crash/);
    expect(await count('bookings')).toBe(0);
    expect(await count('idempotency_keys')).toBe(0);
    const seats = await db.selectFrom('occupancies').select('seats_taken').execute();
    expect(seats.every((o) => o.seats_taken === 0)).toBe(true);

    const retry = await createHold(deps, req);
    expect(retry).toMatchObject({ status: 201 });
    expect(retry.replayed).toBeUndefined();
  });
});

describe('R20 (holds): no secret at rest', () => {
  it('the hold secret appears nowhere in the database', async () => {
    const sc = await scenario(db);
    const { hold_secret } = created(await createHold(deps, holdRequest(sc)));
    const { rows } = await sql<{ hit: boolean }>`
      SELECT EXISTS (SELECT 1 FROM idempotency_keys k WHERE k::text LIKE ${'%' + hold_secret + '%'})
          OR EXISTS (SELECT 1 FROM bookings b WHERE b::text LIKE ${'%' + hold_secret + '%'}) AS hit`.execute(db);
    expect(rows[0]!.hit).toBe(false);
    const stored = await db.selectFrom('idempotency_keys').select('response_body').executeTakeFirstOrThrow();
    expect(Object.keys(stored.response_body as object).sort()).toEqual(['end_at', 'expires_at', 'hold_id', 'start_at']);
  });
});
