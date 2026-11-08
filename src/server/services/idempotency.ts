import { sql, type Transaction } from 'kysely';
import type { DB, Json } from '../db/types.js';
import { sha256 } from '../auth/secrets.js';

/**
 * Idempotency keys (design §5.1 step 1). The key row is claimed INSIDE the business
 * transaction, so the stored response commits atomically with the hold — or not at all.
 *
 * Concurrency: a duplicate request's INSERT blocks on the primary key until the first
 * transaction ends. If that one committed, the duplicate sees the row and replays it; if it
 * rolled back (5xx, crash, 429), the row is gone and the duplicate executes normally.
 */

export type KeyClaim =
  | { kind: 'new' }
  | { kind: 'replay'; status: number; body: Json }
  | { kind: 'mismatch' };

/**
 * Canonical request hash. start_at is normalised to UTC, so "09:00-05:00" and "14:00Z" for
 * the same instant are the same request.
 */
export function holdRequestHash(r: { host: string; slug: string; start_at: string }): Buffer {
  return sha256(JSON.stringify({ host: r.host, slug: r.slug, start_at: new Date(r.start_at).toISOString() }));
}

export async function claimKey(trx: Transaction<DB>, scope: string, key: string, hash: Buffer): Promise<KeyClaim> {
  const inserted = await sql<{ key: string }>`
    INSERT INTO idempotency_keys (scope, key, request_hash) VALUES (${scope}, ${key}, ${hash})
    ON CONFLICT (scope, key) DO NOTHING
    RETURNING key`.execute(trx);
  if (inserted.rows.length > 0) return { kind: 'new' };

  const row = await trx.selectFrom('idempotency_keys')
    .select(['request_hash', 'response_status', 'response_body'])
    .where('scope', '=', scope).where('key', '=', key)
    .executeTakeFirstOrThrow();
  if (!row.request_hash.equals(hash)) return { kind: 'mismatch' };
  if (row.response_status === null || row.response_body === null) {
    // Cannot happen: the row and its response commit together. Fail loudly if it ever does.
    throw new Error(`idempotency key ${scope}/${key} committed without a response`);
  }
  return { kind: 'replay', status: row.response_status, body: row.response_body };
}

/** Store the outcome for the key. The body must never contain a secret (design §5.0). */
export async function storeResponse(trx: Transaction<DB>, scope: string, key: string, status: number, body: Json): Promise<void> {
  await trx.updateTable('idempotency_keys')
    .set({ response_status: status, response_body: JSON.stringify(body) as unknown as Json })
    .where('scope', '=', scope).where('key', '=', key)
    .execute();
}
