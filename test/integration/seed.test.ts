import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { verifyPassword } from '../../src/server/auth/password.js';
import { DEMO_HOST, seed } from '../../src/server/db/seed.js';
import { testDb, truncateAll } from '../helpers/db.js';

const db = testDb();
afterAll(() => db.destroy());
beforeEach(() => truncateAll(db));

async function counts() {
  const n = async (t: 'hosts' | 'event_types' | 'availability_rules') =>
    Number((await db.selectFrom(t).select((eb) => eb.fn.countAll().as('n')).executeTakeFirstOrThrow()).n);
  return { hosts: await n('hosts'), eventTypes: await n('event_types'), rules: await n('availability_rules') };
}

describe('seed', () => {
  it('creates the demo host (America/New_York) with two event types and weekly availability', async () => {
    const r = await seed(db, { password: 'demo1234' });
    expect(r.created).toBe(true);
    expect(await counts()).toEqual({ hosts: 1, eventTypes: 2, rules: 6 });

    const host = await db.selectFrom('hosts').selectAll().where('id', '=', r.hostId).executeTakeFirstOrThrow();
    expect(host).toMatchObject({ slug: 'demo', email: DEMO_HOST.email, timezone: 'America/New_York' });
    expect(await verifyPassword('demo1234', host.password_hash)).toBe(true);

    const evs = await db.selectFrom('event_types').select(['slug', 'duration_min', 'capacity']).orderBy('slug').execute();
    expect(evs).toEqual([
      { slug: 'intro-30', duration_min: 30, capacity: 1 },
      { slug: 'workshop', duration_min: 60, capacity: 5 },
    ]);

    const wed = await db.selectFrom('availability_rules').select(['start_time', 'end_time'])
      .where('weekday', '=', 3).orderBy('start_time').execute();
    expect(wed).toEqual([
      { start_time: '09:00:00', end_time: '12:00:00' },
      { start_time: '13:00:00', end_time: '17:00:00' },
    ]);
  });

  it('is idempotent: a second run inserts nothing', async () => {
    await seed(db, { password: 'demo1234' });
    const r2 = await seed(db, { password: 'demo1234' });
    expect(r2).toMatchObject({ created: false, inserted: 0 });
    expect(await counts()).toEqual({ hosts: 1, eventTypes: 2, rules: 6 });
  });

  it("re-running does not undo the host's edits (deleted availability stays deleted)", async () => {
    const r = await seed(db, { password: 'demo1234' });
    await db.deleteFrom('availability_rules').where('host_id', '=', r.hostId).where('weekday', '=', 5).execute();
    await seed(db, { password: 'demo1234' });
    expect((await counts()).rules).toBe(5);
  });

  it('two instances seeding at the same time create exactly one demo host', async () => {
    const results = await Promise.all([seed(db, { password: 'a-password' }), seed(db, { password: 'a-password' })]);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(await counts()).toEqual({ hosts: 1, eventTypes: 2, rules: 6 });
  });
});
