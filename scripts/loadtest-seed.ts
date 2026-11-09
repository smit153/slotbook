/**
 * Seed for the k6 load test (scripts/loadtest.sh). NOT used by the app or by `pnpm seed`.
 *
 *  - "load-busy": one host that every virtual user hammers (contention on one host lock)
 *  - "load-001" … "load-NNN": many hosts, so load spreads over many host locks
 *
 * Every host has one 15-minute, capacity-1 event type "call", open 24/7, no notice, a 365-day
 * horizon (≈35,000 slots per host, so the busy host cannot run out during a run). Zones rotate
 * over four IANA zones so the slot engine does real zone work.
 */
import { createDb } from '../src/server/db/kysely.js';

const ZONES = ['America/New_York', 'Europe/Berlin', 'Asia/Kolkata', 'UTC'];

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const count = Number(process.argv[2] ?? 200);
  const db = createDb({ connectionString: url, max: 2 });
  try {
    const slugs = ['load-busy', ...Array.from({ length: count }, (_, i) => `load-${String(i + 1).padStart(3, '0')}`)];
    await db.transaction().execute(async (trx) => {
      const hosts = await trx.insertInto('hosts')
        .values(slugs.map((slug, i) => ({
          slug, name: `Load ${slug}`, email: `${slug}@loadtest.test`,
          password_hash: 'not-a-login', // these hosts never log in
          timezone: ZONES[i % ZONES.length]!,
        })))
        .returning(['id'])
        .execute();
      await trx.insertInto('event_types')
        .values(hosts.map((h) => ({
          host_id: h.id, slug: 'call', name: '15-min call', duration_min: 15, capacity: 1,
          buffer_before_min: 0, buffer_after_min: 0, min_notice_min: 0, horizon_days: 365,
        })))
        .execute();
      await trx.insertInto('availability_rules')
        .values(hosts.flatMap((h) => [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ host_id: h.id, weekday, start_time: '00:00', end_time: '24:00' }))))
        .execute();
    });
    console.log(`[loadtest-seed] ${slugs.length} hosts (1 busy + ${count}), each with event type "call"`);
  } finally {
    await db.destroy();
  }
}

main().catch((err: unknown) => {
  console.error('[loadtest-seed] failed:', err);
  process.exit(1);
});
