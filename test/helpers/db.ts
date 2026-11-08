import { inject } from 'vitest';
import { createDb, type Database } from '../../src/server/db/kysely.js';

/** A Kysely instance on the per-run test database. Caller must `destroy()` it. */
export function testDb(opts: { max?: number } = {}): Database {
  return createDb({ connectionString: inject('databaseUrl'), max: opts.max ?? 5 });
}

export function testDatabaseUrl(): string {
  return inject('databaseUrl');
}
