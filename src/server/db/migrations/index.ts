import type { Migration } from 'kysely/migration';
import * as m0001 from './0001_extensions.js';
import * as m0002 from './0002_schema.js';

/**
 * Static migration list. Kysely's FileMigrationProvider imports files by path at
 * runtime, which is fragile across tsx (src/*.ts) and compiled (dist/*.js) runs.
 * Listing them here works identically in both. Keys sort lexically = run order.
 */
export const migrations: Record<string, Migration> = {
  '0001_extensions': m0001,
  '0002_schema': m0002,
};
