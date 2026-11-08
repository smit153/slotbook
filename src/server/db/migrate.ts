import { pathToFileURL } from 'node:url';
import { Migrator, type MigrationResult } from 'kysely/migration';
import { createDb, type Database } from './kysely.js';
import { migrations } from './migrations/index.js';

export function createMigrator(db: Database): Migrator {
  return new Migrator({
    db,
    provider: { getMigrations: async () => migrations },
  });
}

/** Applies all pending migrations. Throws if any migration fails. */
export async function migrateToLatest(db: Database): Promise<MigrationResult[]> {
  const { error, results = [] } = await createMigrator(db).migrateToLatest();
  if (error) {
    const failed = results.find((r) => r.status === 'Error');
    throw new Error(`Migration ${failed?.migrationName ?? '(unknown)'} failed`, { cause: error });
  }
  return results;
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const db = createDb({ connectionString: url, max: 1 });
  try {
    const results = await migrateToLatest(db);
    if (results.length === 0) console.log('[migrate] already up to date');
    for (const r of results) console.log(`[migrate] ${r.status}: ${r.migrationName}`);
  } finally {
    await db.destroy();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error('[migrate] failed:', err);
    process.exit(1);
  });
}
