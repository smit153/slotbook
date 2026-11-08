/**
 * pnpm db:types            → regenerate src/server/db/types.ts from the migrated schema
 * pnpm db:types --verify   → fail if the committed types are out of date
 *
 * Source of truth is the migrations, not a live dev DB: we start a throwaway
 * postgres:16-alpine (Testcontainers), run all migrations, then point
 * kysely-codegen at it. Set TYPES_DATABASE_URL to use an existing empty DB instead.
 */
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createDb } from '../src/server/db/kysely.js';
import { migrateToLatest } from '../src/server/db/migrate.js';

export const OUT_FILE = 'src/server/db/types.ts';

export function runCodegen(url: string, verify: boolean): number {
  const args = [
    'exec', 'kysely-codegen',
    '--dialect', 'postgres',
    '--date-parser', 'string',
    '--url', url,
    '--out-file', OUT_FILE,
    '--exclude-pattern', 'kysely_migration*',
    '--log-level', verify ? 'error' : 'info',
  ];
  if (verify) args.push('--verify');
  const res = spawnSync('pnpm', args, { stdio: 'inherit' });
  return res.status ?? 1;
}

async function main(): Promise<void> {
  const verify = process.argv.includes('--verify');
  let container: StartedPostgreSqlContainer | undefined;
  let url = process.env.TYPES_DATABASE_URL;
  try {
    if (!url) {
      container = await new PostgreSqlContainer('postgres:16-alpine').start();
      url = container.getConnectionUri();
    }
    const db = createDb({ connectionString: url, max: 1 });
    try {
      await migrateToLatest(db);
    } finally {
      await db.destroy();
    }
    const code = runCodegen(url, verify);
    if (code !== 0) process.exitCode = code;
  } finally {
    await container?.stop();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
