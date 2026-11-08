import { pathToFileURL } from 'node:url';
import { hashPassword } from '../auth/password.js';
import { createDb, type Database } from './kysely.js';

export const DEMO_HOST = {
  email: 'demo@slotbook.dev',
  slug: 'demo',
  name: 'Demo Host',
  // A US zone so the demo shows DST behaviour (US and EU switch on different dates).
  timezone: 'America/New_York',
} as const;

export const DEMO_EVENT_TYPES = [
  {
    slug: 'intro-30',
    name: '30-min intro',
    duration_min: 30,
    capacity: 1,
    buffer_before_min: 0,
    buffer_after_min: 10,
    min_notice_min: 240,
    horizon_days: 30,
  },
  {
    slug: 'workshop',
    name: 'Group workshop',
    duration_min: 60,
    capacity: 5,
    buffer_before_min: 15,
    buffer_after_min: 15,
    min_notice_min: 240,
    horizon_days: 30,
  },
] as const;

/** Mon–Fri 09:00–17:00, except Wednesday which has a lunch break (several windows per day). */
export const DEMO_AVAILABILITY: ReadonlyArray<{ weekday: number; start_time: string; end_time: string }> = [
  { weekday: 1, start_time: '09:00', end_time: '17:00' },
  { weekday: 2, start_time: '09:00', end_time: '17:00' },
  { weekday: 3, start_time: '09:00', end_time: '12:00' },
  { weekday: 3, start_time: '13:00', end_time: '17:00' },
  { weekday: 4, start_time: '09:00', end_time: '17:00' },
  { weekday: 5, start_time: '09:00', end_time: '17:00' },
];

export interface SeedResult {
  created: boolean;
  hostId: string;
  inserted: number;
}

/**
 * Idempotent: creates the demo host with its event types and weekly availability only if
 * the host does not exist yet. Re-running never re-adds rows the host deleted or edited.
 * Concurrent runs (two instances booting) are safe: the host insert is ON CONFLICT DO NOTHING
 * inside one transaction, so only the run that created the host inserts its children.
 */
export async function seed(db: Database, opts: { password: string }): Promise<SeedResult> {
  const existing = await db.selectFrom('hosts').select('id').where('email', '=', DEMO_HOST.email).executeTakeFirst();
  if (existing) return { created: false, hostId: existing.id, inserted: 0 };

  const passwordHash = await hashPassword(opts.password);

  return db.transaction().execute(async (trx) => {
    const host = await trx
      .insertInto('hosts')
      .values({ ...DEMO_HOST, password_hash: passwordHash })
      .onConflict((oc) => oc.column('email').doNothing())
      .returning('id')
      .executeTakeFirst();

    if (!host) {
      // Lost a race with another seeding instance; it inserts the children.
      const winner = await trx.selectFrom('hosts').select('id').where('email', '=', DEMO_HOST.email).executeTakeFirstOrThrow();
      return { created: false, hostId: winner.id, inserted: 0 };
    }

    await trx.insertInto('event_types').values(DEMO_EVENT_TYPES.map((e) => ({ ...e, host_id: host.id }))).execute();
    await trx.insertInto('availability_rules').values(DEMO_AVAILABILITY.map((r) => ({ ...r, host_id: host.id }))).execute();

    return { created: true, hostId: host.id, inserted: 1 + DEMO_EVENT_TYPES.length + DEMO_AVAILABILITY.length };
  });
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const password = process.env.SEED_HOST_PASSWORD ?? 'demo1234';
  const db = createDb({ connectionString: url, max: 1 });
  try {
    const r = await seed(db, { password });
    console.log(
      r.created
        ? `[seed] created demo host ${DEMO_HOST.email} (/${DEMO_HOST.slug}) with ${DEMO_EVENT_TYPES.length} event types (${r.inserted} rows)`
        : `[seed] demo host already exists — nothing to do`,
    );
  } finally {
    await db.destroy();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error('[seed] failed:', err);
    process.exit(1);
  });
}
