import { afterAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { createDb } from '../../src/server/db/kysely.js';
import { migrateToLatest } from '../../src/server/db/migrate.js';
import { testDb } from '../helpers/db.js';
import { makeApp } from '../helpers/app.js';

const db = testDb();
afterAll(() => db.destroy());

describe('scaffold smoke', () => {
  it('GET /health → 200 with db ok against the real test database', async () => {
    const app = await makeApp(db);
    const res = await app.inject({ method: 'GET', url: '/health' });
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', db: 'ok' });
  });

  it('GET /health → 503 when the database is unreachable', async () => {
    const deadDb = createDb({ connectionString: 'postgres://u:p@127.0.0.1:1/none', connectionTimeoutMillis: 500 });
    const app = await makeApp(deadDb);
    const res = await app.inject({ method: 'GET', url: '/health' });
    await app.close();
    await deadDb.destroy();
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'error', db: 'down' });
  });

  it('migrations already applied by globalSetup; re-running is a no-op', async () => {
    const results = await migrateToLatest(db);
    expect(results).toEqual([]);
  });

  it('btree_gist is installed (needed by the occupancies exclusion constraint)', async () => {
    const { rows } = await sql<{ extname: string }>`select extname from pg_extension where extname = 'btree_gist'`.execute(db);
    expect(rows).toHaveLength(1);
  });

  it('runs on Postgres 15+', async () => {
    const { rows } = await sql<{ v: number }>`select current_setting('server_version_num')::int as v`.execute(db);
    expect(rows[0]!.v).toBeGreaterThanOrEqual(150000);
  });
});
