import type { FastifyInstance } from 'fastify';
import { buildApp, type AppDeps } from '../../src/server/app.js';
import { loadConfig, type Config } from '../../src/server/config.js';
import type { Database } from '../../src/server/db/kysely.js';
import { hashPassword } from '../../src/server/auth/password.js';
import { APP_SECRET } from './scenario.js';

export const TEST_ORIGIN = 'http://localhost:3000';

export function testConfig(env: Record<string, string> = {}): Config {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://unused:unused@127.0.0.1:1/unused', // the app gets `db` injected
    APP_SECRET,
    LOG_LEVEL: 'silent',
    APP_ORIGIN: TEST_ORIGIN,
    ...env,
  });
}

export async function makeApp(db: Database, o: Partial<Omit<AppDeps, 'db'>> & { env?: Record<string, string> } = {}): Promise<FastifyInstance> {
  const { env, ...rest } = o;
  return buildApp({ config: testConfig(env), db, log: false, ...rest });
}

/** Log in as a host through the real route; returns the Cookie header value. */
export async function loginCookie(app: FastifyInstance, email: string, password: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });
  if (res.statusCode !== 200) throw new Error(`login failed: ${res.statusCode} ${res.body}`);
  const c = res.cookies.find((x) => x.name === 'sb_session');
  if (!c) throw new Error('no session cookie');
  return `sb_session=${c.value}`;
}

export const HOST_PASSWORD = 'correct horse battery';

/** Give a test host a real password and log in; returns the Cookie header value. */
export async function loginAs(app: FastifyInstance, db: Database, hostId: string): Promise<string> {
  await db.updateTable('hosts').set({ password_hash: await hashPassword(HOST_PASSWORD) }).where('id', '=', hostId).execute();
  const { email } = await db.selectFrom('hosts').select('email').where('id', '=', hostId).executeTakeFirstOrThrow();
  return loginCookie(app, email, HOST_PASSWORD);
}

/** Pretend to be a different client for each call (per-IP cap / rate limit). */
let n = 0;
export const nextIp = () => { n += 1; return `192.0.2.${(n % 250) + 1}`; };
