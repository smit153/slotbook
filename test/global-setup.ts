import type { TestProject } from 'vitest/node';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createDb } from '../src/server/db/kysely.js';
import { migrateToLatest } from '../src/server/db/migrate.js';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

/**
 * `pnpm test` is one command (design §9.2):
 *  1. TEST_DATABASE_URL set (CI service container / local PG) → use it.
 *  2. Otherwise start postgres:16-alpine via Testcontainers on a random port.
 * Then migrate and hand the URL to the tests. Teardown stops the container.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  let container: StartedPostgreSqlContainer | undefined;
  let url = process.env.TEST_DATABASE_URL;

  if (!url) {
    container = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('slotbook_test')
      .withUsername('slotbook')
      .withPassword('slotbook')
      // Throwaway DB: durability off makes tests faster and does not change
      // locking/constraint semantics, which is what the tests are about.
      // deadlock_timeout 100 ms (default 1 s): the R4 lock-bypass test provokes exclusion-
      // constraint deadlocks on purpose; detection timing changes, not who wins.
      .withCommand(['postgres', '-c', 'fsync=off', '-c', 'synchronous_commit=off', '-c', 'full_page_writes=off',
        '-c', 'max_connections=200', '-c', 'deadlock_timeout=100ms'])
      .start();
    url = container.getConnectionUri();
  }

  const db = createDb({ connectionString: url, max: 1 });
  try {
    await migrateToLatest(db);
  } finally {
    await db.destroy();
  }

  project.provide('databaseUrl', url);

  return async () => {
    await container?.stop();
  };
}
