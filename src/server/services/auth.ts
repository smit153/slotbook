import { randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import { z } from 'zod';
import type { Database } from '../db/kysely.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { sha256 } from '../auth/secrets.js';
import { failure, type ServiceResult } from './errors.js';

export const SESSION_COOKIE = 'sb_session';

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email().max(320)),
  password: z.string().min(1).max(200),
});

export interface HostMe {
  id: string;
  slug: string;
  name: string;
  email: string;
  timezone: string;
}

let dummyHash: Promise<string> | undefined;

/**
 * POST /api/auth/login. Unknown email, inactive host and wrong password all give the same 401,
 * and all run scrypt once (against a dummy hash when there is no real one), so neither the
 * answer nor the timing tells an attacker which emails exist.
 */
export async function login(db: Database, body: unknown, ttlHours: number):
  Promise<ServiceResult<{ host: HostMe }> & { sessionToken?: string }> {
  const parsed = loginSchema.safeParse(body);
  if (!parsed.success) return failure(400, 'VALIDATION', 'email and password are required');

  const host = await db.selectFrom('hosts')
    .select(['id', 'slug', 'name', 'email', 'timezone', 'password_hash', 'active'])
    .where('email', '=', parsed.data.email)
    .executeTakeFirst();

  dummyHash ??= hashPassword(randomBytes(16).toString('hex'));
  const ok = await verifyPassword(parsed.data.password, host?.password_hash ?? (await dummyHash));
  if (!host || !host.active || !ok) return failure(401, 'INVALID_CREDENTIALS', 'Wrong email or password');

  const token = randomBytes(32).toString('base64url');
  await db.insertInto('host_sessions').values({
    host_id: host.id,
    token_hash: sha256(token),
    expires_at: sql<Date>`now() + make_interval(hours => ${ttlHours}::int)`,
  }).execute();

  return {
    status: 200,
    body: { host: { id: host.id, slug: host.slug, name: host.name, email: host.email, timezone: host.timezone } },
    sessionToken: token,
  };
}

/** POST /api/auth/logout — deletes the session row (config data, not booking history). */
export async function logout(db: Database, token: string | undefined): Promise<void> {
  if (!token) return;
  await db.deleteFrom('host_sessions').where('token_hash', '=', sha256(token)).execute();
}

/** Resolve a session cookie: unexpired by the DATABASE clock and the host still active. */
export async function sessionHost(db: Database, token: string | undefined): Promise<HostMe | null> {
  if (!token || token.length > 128) return null;
  const r = await db.selectFrom('host_sessions as s').innerJoin('hosts as h', 'h.id', 's.host_id')
    .select(['h.id', 'h.slug', 'h.name', 'h.email', 'h.timezone'])
    .where('s.token_hash', '=', sha256(token))
    .where('s.expires_at', '>', sql<Date>`now()`)
    .where('h.active', '=', true)
    .executeTakeFirst();
  return r ?? null;
}
