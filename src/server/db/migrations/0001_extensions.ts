import { sql, type Kysely } from 'kysely';

// btree_gist lets the occupancies exclusion constraint combine `host_id WITH =`
// (a btree-style operator) with `blocked WITH &&` (a range operator) in one GiST index.
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS btree_gist`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP EXTENSION IF EXISTS btree_gist`.execute(db);
}
