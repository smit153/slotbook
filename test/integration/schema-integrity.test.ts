import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import {
  createBooking, createEventType, createHost, createOccupancy, pgError, testDb, truncateAll,
} from '../helpers/db.js';
import { assertSeatInvariant } from '../helpers/invariants.js';

const db = testDb();
afterAll(() => db.destroy());
beforeEach(() => truncateAll(db));
afterEach(() => assertSeatInvariant(db));

const T = '2030-01-07T15:00:00Z';

describe('host consistency (composite FKs)', () => {
  it("an occupancy can't use another host's event type", async () => {
    const a = await createHost(db);
    const evB = await createEventType(db, await createHost(db));
    const err = await pgError(() => createOccupancy(db, { ...evB, host_id: a }, T));
    expect(err.constraint).toBe('occupancies_event_type_fk');
  });

  it("a booking can't point at another host's event type or occupancy", async () => {
    const evA = await createEventType(db, await createHost(db));
    const evB = await createEventType(db, await createHost(db));
    const occB = await createOccupancy(db, evB, T);

    // host A + event type B
    expect((await pgError(() => createBooking(db, occB, { ...evB, host_id: evA.host_id }))).constraint)
      .toBe('bookings_event_type_fk');
    // host A + event type A + occupancy of host B
    expect((await pgError(() => createBooking(db, occB, evA))).constraint).toBe('bookings_occupancy_fk');
  });
});

describe('bookings: data shape per status (not transitions)', () => {
  async function base() {
    const ev = await createEventType(db, await createHost(db));
    const occ = await createOccupancy(db, ev, T);
    return { ev, occ, row: {
      host_id: ev.host_id, event_type_id: ev.id, occupancy_id: occ.id,
      start_at: occ.start_at, end_at: occ.end_at,
    } };
  }

  it('held needs expires_at', async () => {
    const { row } = await base();
    const err = await pgError(() => db.insertInto('bookings').values({ ...row, status: 'held' }).execute());
    expect(err.constraint).toBe('bookings_held_shape');
  });

  it('confirmed needs guest name, email, manage token hash and confirmed_at', async () => {
    const { row } = await base();
    const err = await pgError(() =>
      db.insertInto('bookings').values({ ...row, status: 'confirmed', guest_name: 'G', guest_email: 'g@x.test' }).execute());
    expect(err.constraint).toBe('bookings_confirmed_shape');
  });

  it('cancelled needs cancelled_at and cancelled_by', async () => {
    const { row } = await base();
    const err = await pgError(() => db.insertInto('bookings').values({ ...row, status: 'cancelled' }).execute());
    expect(err.constraint).toBe('bookings_cancelled_shape');
  });

  it('manage token hash is exactly 32 bytes (sha256) and unique', async () => {
    const { ev, occ, row } = await base();
    const bad = await pgError(() => db.insertInto('bookings').values({
      ...row, status: 'expired', manage_token_hash: Buffer.alloc(16),
    }).execute());
    expect(bad.constraint).toBe('bookings_manage_token_hash_len');

    const id = await createBooking(db, occ, ev, 'expired');
    const hash = Buffer.alloc(32, 7);
    await db.updateTable('bookings').set({ manage_token_hash: hash }).where('id', '=', id).execute();
    const dup = await pgError(() => db.insertInto('bookings').values({ ...row, status: 'expired', manage_token_hash: hash }).execute());
    expect(dup.constraint).toBe('bookings_manage_token_hash_unique');
  });

  it('the shape CHECKs do NOT police transitions (that is the service’s job)', async () => {
    const { ev, occ } = await base();
    const id = await createBooking(db, occ, ev, 'cancelled');
    // cancelled → held is an illegal transition, but the row shape is valid, so the DB allows it.
    await sql`UPDATE bookings SET status = 'held' WHERE id = ${id}`.execute(db);
    const row = await db.selectFrom('bookings').select('status').where('id', '=', id).executeTakeFirstOrThrow();
    expect(row.status).toBe('held');
  });
});

describe('event type and host field rules', () => {
  it.each([
    ['duration 14', { duration_min: 14 }, 'event_types_duration_range'],
    ['duration 121', { duration_min: 121 }, 'event_types_duration_range'],
    ['capacity 0', { capacity: 0 }, 'event_types_capacity_min'],
    ['buffer before 31', { buffer_before_min: 31 }, 'event_types_buffer_before'],
    ['buffer after -1', { buffer_after_min: -1 }, 'event_types_buffer_after'],
    ['horizon 0', { horizon_days: 0 }, 'event_types_horizon'],
    ['min notice -1', { min_notice_min: -1 }, 'event_types_min_notice'],
    ['bad slug', { slug: 'Not A Slug' }, 'event_types_slug_format'],
  ] as const)('rejects %s', async (_label, o, constraint) => {
    const host = await createHost(db);
    expect((await pgError(() => createEventType(db, host, o))).constraint).toBe(constraint);
  });

  it('accepts the boundaries (15/120 min, buffers 0/30, horizon 1/365)', async () => {
    const host = await createHost(db);
    await createEventType(db, host, { duration_min: 15, buffer_before_min: 0, buffer_after_min: 30, horizon_days: 1 });
    await createEventType(db, host, { duration_min: 120, buffer_before_min: 30, buffer_after_min: 0, horizon_days: 365 });
  });

  it('event slugs are unique per host, not globally', async () => {
    const h1 = await createHost(db);
    const h2 = await createHost(db);
    await createEventType(db, h1, { slug: 'intro' });
    await createEventType(db, h2, { slug: 'intro' });
    expect((await pgError(() => createEventType(db, h1, { slug: 'intro' }))).constraint).toBe('event_types_host_slug_unique');
  });

  it('host email must be lower-case; host slug unique and well-formed', async () => {
    expect((await pgError(() => createHost(db, { email: 'Demo@Example.test' }))).constraint).toBe('hosts_email_lower');
    await createHost(db, { slug: 'demo' });
    expect((await pgError(() => createHost(db, { slug: 'demo' }))).constraint).toBe('hosts_slug_unique');
    expect((await pgError(() => createHost(db, { slug: '-demo' }))).constraint).toBe('hosts_slug_format');
  });
});
