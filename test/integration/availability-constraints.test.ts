import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createHost, pgError, testDb, truncateAll } from '../helpers/db.js';

const db = testDb();
afterAll(() => db.destroy());
beforeEach(() => truncateAll(db));

const rule = (host_id: string, weekday: number, start_time: string, end_time: string) =>
  db.insertInto('availability_rules').values({ host_id, weekday, start_time, end_time }).execute();

const override = (host_id: string, date: string, kind: string) =>
  db.insertInto('date_overrides').values({ host_id, date, kind }).execute();

const window = (host_id: string, date: string, start_time: string, end_time: string, kind?: string) =>
  db.insertInto('date_override_windows').values({ host_id, date, start_time, end_time, ...(kind ? { kind } : {}) }).execute();

describe('weekly availability rules', () => {
  it('weekday is ISO 1..7 (1 = Mon, 7 = Sun)', async () => {
    const h = await createHost(db);
    await rule(h, 1, '09:00', '17:00');
    await rule(h, 7, '09:00', '17:00');
    expect((await pgError(() => rule(h, 0, '09:00', '17:00'))).constraint).toBe('availability_rules_weekday_iso');
    expect((await pgError(() => rule(h, 8, '09:00', '17:00'))).constraint).toBe('availability_rules_weekday_iso');
  });

  it('end must be after start', async () => {
    const h = await createHost(db);
    expect((await pgError(() => rule(h, 1, '17:00', '09:00'))).constraint).toBe('availability_rules_time_order');
    expect((await pgError(() => rule(h, 1, '09:00', '09:00'))).constraint).toBe('availability_rules_time_order');
  });

  it('several windows per day are fine; touching windows are fine; overlapping ones are refused', async () => {
    const h = await createHost(db);
    await rule(h, 3, '09:00', '12:00');
    await rule(h, 3, '13:00', '17:00');
    await rule(h, 3, '12:00', '13:00'); // touches both ends: [12:00,13:00)
    const err = await pgError(() => rule(h, 3, '11:30', '12:30'));
    expect(err.code).toBe('23P01');
    expect(err.constraint).toBe('availability_rules_no_overlap');
  });

  it('same times on another weekday or for another host do not conflict', async () => {
    const h1 = await createHost(db);
    const h2 = await createHost(db);
    await rule(h1, 1, '09:00', '17:00');
    await rule(h1, 2, '09:00', '17:00');
    await rule(h2, 1, '09:00', '17:00');
  });

  it('a window may end at 24:00 (Postgres time allows it) — "until midnight"', async () => {
    const h = await createHost(db);
    await rule(h, 5, '20:00', '24:00');
  });
});

describe('date overrides: a day off XOR custom hours', () => {
  it("custom override with windows works; its windows can't overlap", async () => {
    const h = await createHost(db);
    await override(h, '2030-12-24', 'custom');
    await window(h, '2030-12-24', '09:00', '12:00');
    await window(h, '2030-12-24', '14:00', '16:00');
    expect((await pgError(() => window(h, '2030-12-24', '11:00', '15:00'))).constraint).toBe('date_override_windows_no_overlap');
  });

  it('a day-off date cannot also get hours (composite FK pins kind = custom)', async () => {
    const h = await createHost(db);
    await override(h, '2030-12-25', 'off');
    const err = await pgError(() => window(h, '2030-12-25', '09:00', '12:00'));
    expect(err.code).toBe('23503');
    expect(err.constraint).toBe('date_override_windows_override_fk');
  });

  it("a window can't claim kind = 'off' to sneak past the FK", async () => {
    const h = await createHost(db);
    await override(h, '2030-12-25', 'off');
    expect((await pgError(() => window(h, '2030-12-25', '09:00', '12:00', 'off'))).constraint).toBe('date_override_windows_kind_custom');
  });

  it("windows need an existing override for that date", async () => {
    const h = await createHost(db);
    expect((await pgError(() => window(h, '2030-12-26', '09:00', '12:00'))).code).toBe('23503');
  });

  it('a date has one override: you cannot add both an off row and a custom row', async () => {
    const h = await createHost(db);
    await override(h, '2030-12-24', 'custom');
    expect((await pgError(() => override(h, '2030-12-24', 'off'))).constraint).toBe('date_overrides_pkey');
  });

  it("flipping custom → off while windows exist is refused; after removing them it's allowed", async () => {
    const h = await createHost(db);
    await override(h, '2030-12-24', 'custom');
    await window(h, '2030-12-24', '09:00', '12:00');
    const flip = () =>
      db.updateTable('date_overrides').set({ kind: 'off' }).where('host_id', '=', h).where('date', '=', '2030-12-24').execute();
    expect((await pgError(flip)).code).toBe('23503');

    await db.deleteFrom('date_override_windows').where('host_id', '=', h).execute();
    await flip();
  });

  it('kind must be off or custom', async () => {
    const h = await createHost(db);
    expect((await pgError(() => override(h, '2030-12-24', 'holiday'))).constraint).toBe('date_overrides_kind_valid');
  });

  it('deleting an override deletes its windows', async () => {
    const h = await createHost(db);
    await override(h, '2030-12-24', 'custom');
    await window(h, '2030-12-24', '09:00', '12:00');
    await db.deleteFrom('date_overrides').where('host_id', '=', h).execute();
    const left = await db.selectFrom('date_override_windows').select('id').where('host_id', '=', h).execute();
    expect(left).toEqual([]);
  });

  it("dates round-trip as 'YYYY-MM-DD' strings, not shifted JS Dates", async () => {
    const h = await createHost(db);
    await override(h, '2030-03-31', 'off');
    const row = await db.selectFrom('date_overrides').select('date').where('host_id', '=', h).executeTakeFirstOrThrow();
    expect(row.date).toBe('2030-03-31');
  });
});
