import pg from 'pg';
import { Kysely, PostgresDialect } from 'kysely';
import type { DB } from './types.js';

// int8 (e.g. count(*)) comes back as a string by default. Our counts are tiny,
// so parse them as numbers. This is a process-wide pg setting.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));

// `date` columns (date overrides) are calendar days in the HOST's time zone. pg's default
// turns '2026-11-01' into a JS Date at the *server's* local midnight, which can shift the
// day. Keep them as plain 'YYYY-MM-DD' strings (codegen runs with --date-parser string).
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);

export type Database = Kysely<DB>;

export interface DbOptions {
  connectionString: string;
  max?: number;
  connectionTimeoutMillis?: number;
}

export function createDb({ connectionString, max = 10, connectionTimeoutMillis = 5_000 }: DbOptions): Database {
  const pool = new pg.Pool({ connectionString, max, connectionTimeoutMillis });
  return new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
}
