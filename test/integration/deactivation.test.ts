import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { createEventType, createHost, pgError, testDb, truncateAll } from '../helpers/db.js';

const db = testDb();
afterAll(() => db.destroy());
beforeEach(() => truncateAll(db));

describe('deactivate, never delete (design §4.2)', () => {
  it('no foreign-key path can cascade a DELETE/SET NULL into bookings (catalog check)', async () => {
    // Tables whose row deletion would reach bookings through ON DELETE CASCADE/SET NULL/SET DEFAULT,
    // following FK chains of any length. Must be empty.
    const { rows } = await sql<{ parent: string }>`
      WITH RECURSIVE reaches(tbl) AS (
        SELECT 'bookings'::regclass
        UNION
        SELECT c.confrelid::regclass
          FROM pg_constraint c JOIN reaches r ON c.conrelid = r.tbl
         WHERE c.contype = 'f' AND c.confdeltype IN ('c', 'n', 'd')
      )
      SELECT tbl::text AS parent FROM reaches WHERE tbl <> 'bookings'::regclass`.execute(db);
    expect(rows).toEqual([]);
  });

  it('the catalog check is not vacuous: a cascade added in a rolled-back txn is detected', async () => {
    const ROLLBACK = new Error('rollback');
    let detected: string[] = [];
    await db.transaction().execute(async (trx) => {
      await sql`ALTER TABLE bookings DROP CONSTRAINT bookings_event_type_fk,
        ADD CONSTRAINT bookings_event_type_fk FOREIGN KEY (event_type_id, host_id)
          REFERENCES event_types (id, host_id) ON DELETE CASCADE`.execute(trx);
      const { rows } = await sql<{ parent: string }>`
        WITH RECURSIVE reaches(tbl) AS (
          SELECT 'bookings'::regclass
          UNION
          SELECT c.confrelid::regclass FROM pg_constraint c JOIN reaches r ON c.conrelid = r.tbl
           WHERE c.contype = 'f' AND c.confdeltype IN ('c', 'n', 'd'))
        SELECT tbl::text AS parent FROM reaches WHERE tbl <> 'bookings'::regclass`.execute(trx);
      detected = rows.map((r) => r.parent);
      throw ROLLBACK;
    }).catch((e: unknown) => { if (e !== ROLLBACK) throw e; });
    expect(detected).toEqual(['event_types']);
  });

  it('every FK on bookings, occupancies and event_types is NO ACTION/RESTRICT on delete', async () => {
    const { rows } = await sql<{ conname: string; confdeltype: string }>`
      SELECT conname, confdeltype FROM pg_constraint
       WHERE contype = 'f'
         AND conrelid IN ('bookings'::regclass, 'occupancies'::regclass, 'event_types'::regclass)
         AND confdeltype NOT IN ('a', 'r')`.execute(db);
    expect(rows).toEqual([]);
  });

  it('DELETE on an event type is refused; deactivating it works', async () => {
    const ev = await createEventType(db, await createHost(db));
    const err = await pgError(() => db.deleteFrom('event_types').where('id', '=', ev.id).execute());
    expect(err.code).toBe('23001');
    expect(err.message).toMatch(/set active = false/);

    await db.updateTable('event_types').set({ active: false }).where('id', '=', ev.id).execute();
    const row = await db.selectFrom('event_types').select('active').where('id', '=', ev.id).executeTakeFirstOrThrow();
    expect(row.active).toBe(false);
  });

  it('DELETE on a host is refused, even with no event types; deactivating it works', async () => {
    const host = await createHost(db);
    expect((await pgError(() => db.deleteFrom('hosts').where('id', '=', host).execute())).code).toBe('23001');

    await db.updateTable('hosts').set({ active: false }).where('id', '=', host).execute();
    const row = await db.selectFrom('hosts').select('active').where('id', '=', host).executeTakeFirstOrThrow();
    expect(row.active).toBe(false);
  });

  it('hosts default to active', async () => {
    const host = await createHost(db);
    const row = await db.selectFrom('hosts').select('active').where('id', '=', host).executeTakeFirstOrThrow();
    expect(row.active).toBe(true);
  });

  it('config rows without booking data (availability, overrides) can still be deleted', async () => {
    const host = await createHost(db);
    await db.insertInto('availability_rules').values({ host_id: host, weekday: 1, start_time: '09:00', end_time: '17:00' }).execute();
    await db.deleteFrom('availability_rules').where('host_id', '=', host).execute();
  });
});
