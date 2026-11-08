import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { createHold, normalizeIp, type HoldCreated } from '../../src/server/services/holds.js';
import { testDb, truncateAll } from '../helpers/db.js';
import { assertSeatInvariant } from '../helpers/invariants.js';
import { APP_SECRET, holdRequest, scenario, type Scenario } from '../helpers/scenario.js';

/** R22: one client cannot hold every slot. Cap = 3 live holds per IP, across all hosts. */
const db = testDb({ max: 20 });
const deps = { db, appSecret: APP_SECRET };
afterAll(() => db.destroy());
beforeEach(() => truncateAll(db));
afterEach(() => assertSeatInvariant(db));

const IP = '203.0.113.7';
const nth = (sc: Scenario, i: number) => new Date(sc.slot.getTime() + i * 30 * 60_000); // 09:00, 09:30, …
const keys = async () => Number((await db.selectFrom('idempotency_keys').select((eb) => eb.fn.countAll().as('n')).executeTakeFirstOrThrow()).n);

describe('R22: per-IP active-hold cap', () => {
  it('3 holds from one IP succeed, the 4th gets 429 HOLD_LIMIT and is NOT stored for its key', async () => {
    const sc = await scenario(db);
    for (let i = 0; i < 3; i++) expect((await createHold(deps, holdRequest(sc, { ip: IP, startAt: nth(sc, i) }))).status).toBe(201);

    const fourth = holdRequest(sc, { ip: IP, startAt: nth(sc, 3) });
    expect(await createHold(deps, fourth)).toMatchObject({ status: 429, body: { error: { code: 'HOLD_LIMIT' } } });
    expect(await keys()).toBe(3);

    // Once one of them expires, retrying the SAME key goes through (429 was never cached).
    const first = await db.selectFrom('bookings').select('id').orderBy('created_at').executeTakeFirstOrThrow();
    await sql`UPDATE bookings SET expires_at = clock_timestamp() - interval '1 second' WHERE id = ${first.id}`.execute(db);
    expect((await createHold(deps, fourth)).status).toBe(201);
  });

  it('other IPs are unaffected', async () => {
    const sc = await scenario(db);
    for (let i = 0; i < 3; i++) await createHold(deps, holdRequest(sc, { ip: IP, startAt: nth(sc, i) }));
    expect((await createHold(deps, holdRequest(sc, { ip: '198.51.100.1', startAt: nth(sc, 3) }))).status).toBe(201);
  });

  it('the cap counts holds across ALL hosts', async () => {
    const a = await scenario(db);
    const b = await scenario(db);
    await createHold(deps, holdRequest(a, { ip: IP, startAt: nth(a, 0) }));
    await createHold(deps, holdRequest(b, { ip: IP, startAt: nth(b, 0) }));
    await createHold(deps, holdRequest(a, { ip: IP, startAt: nth(a, 1) }));
    expect((await createHold(deps, holdRequest(b, { ip: IP, startAt: nth(b, 1) }))).status).toBe(429);
  });

  it('confirmed bookings and expired holds do not count', async () => {
    const sc = await scenario(db);
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((((await createHold(deps, holdRequest(sc, { ip: IP, startAt: nth(sc, i) }))).body) as HoldCreated).hold_id);
    await sql`UPDATE bookings SET status = 'confirmed', guest_name = 'G', guest_email = 'g@x.test',
                manage_token_hash = sha256(id::text::bytea), confirmed_at = clock_timestamp() WHERE id = ${ids[0]}`.execute(db);
    await sql`UPDATE bookings SET expires_at = clock_timestamp() - interval '1 second' WHERE id = ${ids[1]}`.execute(db);
    expect((await createHold(deps, holdRequest(sc, { ip: IP, startAt: nth(sc, 3) }))).status).toBe(201);
    expect((await createHold(deps, holdRequest(sc, { ip: IP, startAt: nth(sc, 4) }))).status).toBe(201);
    expect((await createHold(deps, holdRequest(sc, { ip: IP, startAt: nth(sc, 5) }))).status).toBe(429);
  });

  it('10 parallel holds from one IP on 10 different slots → exactly 3 × 201, 7 × 429 (IP lock serialises)', async () => {
    const sc = await scenario(db);
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => createHold(deps, holdRequest(sc, { ip: IP, startAt: nth(sc, i) }))));
    expect(results.filter((r) => r.status === 201)).toHaveLength(3);
    expect(results.filter((r) => r.status === 429)).toHaveLength(7);
  });

  it('an IPv4-mapped IPv6 address is the same client as its IPv4 form', async () => {
    expect(normalizeIp('::ffff:203.0.113.7')).toBe(IP);
    expect(normalizeIp('2001:DB8::1')).toBe('2001:db8::1');
    expect(normalizeIp('not-an-ip')).toBeNull();

    const sc = await scenario(db);
    await createHold(deps, holdRequest(sc, { ip: IP, startAt: nth(sc, 0) }));
    await createHold(deps, holdRequest(sc, { ip: `::ffff:${IP}`, startAt: nth(sc, 1) }));
    await createHold(deps, holdRequest(sc, { ip: IP, startAt: nth(sc, 2) }));
    expect((await createHold(deps, holdRequest(sc, { ip: `::ffff:${IP}`, startAt: nth(sc, 3) }))).status).toBe(429);
  });
});
