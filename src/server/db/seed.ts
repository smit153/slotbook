import { pathToFileURL } from 'node:url';
import { createDb, type Database } from './kysely.js';

/**
 * Idempotent seed. Phase 2 adds the demo host and its two event types; until the
 * schema exists there is nothing to insert.
 */
export async function seed(_db: Database): Promise<{ inserted: number }> {
  return { inserted: 0 };
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const db = createDb({ connectionString: url, max: 1 });
  try {
    const { inserted } = await seed(db);
    console.log(`[seed] done (${inserted} rows inserted)`);
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
