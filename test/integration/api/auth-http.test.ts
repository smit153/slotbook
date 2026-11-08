import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { hashPassword } from '../../../src/server/auth/password.js';
import { allowedOrigins, loadConfig } from '../../../src/server/config.js';
import { testDb, truncateAll } from '../../helpers/db.js';
import { HOST_PASSWORD, loginAs, makeApp, nextIp, testConfig, TEST_ORIGIN } from '../../helpers/app.js';
import { scenario } from '../../helpers/scenario.js';

const db = testDb();
afterAll(() => db.destroy());
beforeEach(() => truncateAll(db));

async function hostWithPassword() {
  const sc = await scenario(db);
  await db.updateTable('hosts').set({ password_hash: await hashPassword(HOST_PASSWORD) }).where('id', '=', sc.hostId).execute();
  const { email } = await db.selectFrom('hosts').select('email').where('id', '=', sc.hostId).executeTakeFirstOrThrow();
  return { ...sc, email };
}

describe('login / session / logout', () => {
  it('login sets an HttpOnly, SameSite=Lax, 7-day session cookie; /api/me works with it', async () => {
    const h = await hostWithPassword();
    const app = await makeApp(db);
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: h.email.toUpperCase(), password: HOST_PASSWORD } });
    expect(res.statusCode).toBe(200);
    const c = res.cookies.find((x) => x.name === 'sb_session')!;
    expect(c).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/', maxAge: 7 * 24 * 3600 });
    expect(c.secure).toBeUndefined(); // test/dev: plain http
    expect(res.headers['cache-control']).toBe('no-store');

    const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: `sb_session=${c.value}` } });
    expect(me.json().host).toMatchObject({ id: h.hostId, email: h.email, timezone: 'America/New_York' });
    await app.close();
  });

  it('in production the cookie is also Secure', async () => {
    const h = await hostWithPassword();
    const app = await makeApp(db, { env: { NODE_ENV: 'production' } });
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: h.email, password: HOST_PASSWORD } });
    expect(res.cookies.find((x) => x.name === 'sb_session')!.secure).toBe(true);
    await app.close();
  });

  it('wrong password, unknown email and a deactivated host all get the same 401', async () => {
    const h = await hostWithPassword();
    const app = await makeApp(db);
    const wrong = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: h.email, password: 'nope' } });
    const unknown = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'nobody@example.test', password: 'nope' } });
    await db.updateTable('hosts').set({ active: false }).where('id', '=', h.hostId).execute();
    const inactive = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: h.email, password: HOST_PASSWORD } });
    for (const r of [wrong, unknown, inactive]) {
      expect(r.statusCode).toBe(401);
      expect(r.json()).toEqual({ error: { code: 'INVALID_CREDENTIALS', message: 'Wrong email or password' } });
      expect(r.cookies).toEqual([]);
    }
    await app.close();
  });

  it('only sha256 of the session token is stored', async () => {
    const h = await hostWithPassword();
    const app = await makeApp(db);
    const cookie = await loginAs(app, db, h.hostId);
    const raw = cookie.split('=')[1]!;
    const { rows } = await sql<{ hit: boolean }>`SELECT EXISTS (SELECT 1 FROM host_sessions s WHERE s::text LIKE ${'%' + raw + '%'}) AS hit`.execute(db);
    expect(rows[0]!.hit).toBe(false);
    await app.close();
  });

  it('no cookie, a garbage cookie, an expired session or a deactivated host → 401 on /api/host/*', async () => {
    const h = await hostWithPassword();
    const app = await makeApp(db);
    const get = (cookie?: string) => app.inject({ method: 'GET', url: '/api/host/settings', headers: cookie ? { cookie } : {} });
    expect((await get()).statusCode).toBe(401);
    expect((await get('sb_session=garbage')).statusCode).toBe(401);

    const cookie = await loginAs(app, db, h.hostId);
    expect((await get(cookie)).statusCode).toBe(200);
    await sql`UPDATE host_sessions SET expires_at = now() - interval '1 second'`.execute(db);
    expect((await get(cookie)).statusCode).toBe(401);

    const fresh = await loginAs(app, db, h.hostId);
    await db.updateTable('hosts').set({ active: false }).where('id', '=', h.hostId).execute();
    expect((await get(fresh)).statusCode).toBe(401);
    await app.close();
  });

  it('logout deletes the session: the old cookie stops working', async () => {
    const h = await hostWithPassword();
    const app = await makeApp(db);
    const cookie = await loginAs(app, db, h.hostId);
    const out = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie, origin: TEST_ORIGIN } });
    expect(out.statusCode).toBe(204);
    expect(out.cookies.find((x) => x.name === 'sb_session')?.value).toBe('');
    expect((await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).statusCode).toBe(401);
    await app.close();
  });
});

describe('login rate limit (@fastify/rate-limit, login route only)', () => {
  it('10 attempts per minute per IP; the 11th → 429 RATE_LIMITED with Retry-After; other IPs unaffected', async () => {
    const h = await hostWithPassword();
    const app = await makeApp(db);
    const attempt = (ip: string) => app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress: ip, payload: { email: h.email, password: 'wrong' } });
    for (let i = 0; i < 10; i++) expect((await attempt('198.51.100.20')).statusCode).toBe(401);
    const limited = await attempt('198.51.100.20');
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe('RATE_LIMITED');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect((await attempt('198.51.100.21')).statusCode).toBe(401);
    // Other routes are not limited.
    for (let i = 0; i < 15; i++) expect((await app.inject({ method: 'GET', url: '/health', remoteAddress: nextIp() })).statusCode).toBe(200);
    await app.close();
  });
});

describe('Origin check on cookie-authenticated writes (configurable)', () => {
  const putSettings = (app: Awaited<ReturnType<typeof makeApp>>, cookie: string, origin?: string) =>
    app.inject({ method: 'PUT', url: '/api/host/settings', headers: { cookie, ...(origin ? { origin } : {}) }, payload: { name: 'Renamed' } });

  it('test/production config: APP_ORIGIN allowed, no Origin allowed, Vite :5173 and others refused', async () => {
    const h = await hostWithPassword();
    const app = await makeApp(db);
    const cookie = await loginAs(app, db, h.hostId);
    expect((await putSettings(app, cookie, TEST_ORIGIN)).statusCode).toBe(200);
    expect((await putSettings(app, cookie)).statusCode).toBe(200);
    for (const bad of ['http://localhost:5173', 'https://evil.example', 'null']) {
      const r = await putSettings(app, cookie, bad);
      expect([r.statusCode, r.json().error.code]).toEqual([403, 'ORIGIN_NOT_ALLOWED']);
    }
    await app.close();
  });

  it('development config: the Vite dev origin (pnpm dev on :5173) is allowed too', async () => {
    const h = await hostWithPassword();
    const app = await makeApp(db, { env: { NODE_ENV: 'development' } });
    const cookie = await loginAs(app, db, h.hostId);
    expect((await putSettings(app, cookie, 'http://localhost:5173')).statusCode).toBe(200);
    expect((await putSettings(app, cookie, 'http://127.0.0.1:5173')).statusCode).toBe(200);
    expect((await putSettings(app, cookie, 'https://evil.example')).statusCode).toBe(403);
    await app.close();
  });

  it('EXTRA_ALLOWED_ORIGINS adds origins; login itself is origin-checked', async () => {
    const h = await hostWithPassword();
    const app = await makeApp(db, { env: { EXTRA_ALLOWED_ORIGINS: 'https://staging.slotbook.test, https://ui.slotbook.test' } });
    const cookie = await loginAs(app, db, h.hostId);
    expect((await putSettings(app, cookie, 'https://ui.slotbook.test')).statusCode).toBe(200);
    const evilLogin = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: 'https://evil.example' }, payload: { email: h.email, password: HOST_PASSWORD } });
    expect(evilLogin.statusCode).toBe(403);
    await app.close();
  });

  it('allowedOrigins(): defaults, dev extras, normalisation; production requires APP_ORIGIN', () => {
    expect([...allowedOrigins(testConfig({ APP_ORIGIN: 'https://slotbook.example/' }))]).toEqual(['https://slotbook.example']);
    expect([...allowedOrigins(testConfig({ NODE_ENV: 'development' }))].sort())
      .toEqual(['http://127.0.0.1:5173', 'http://localhost:3000', 'http://localhost:5173']);
    const prodWithout = { NODE_ENV: 'production', DATABASE_URL: 'postgres://u:p@h/db', APP_SECRET: 'x'.repeat(32) };
    expect(() => loadConfig(prodWithout)).toThrow(/APP_ORIGIN is required in production/);
    expect(() => loadConfig({ ...prodWithout, APP_ORIGIN: 'https://slotbook.example' })).not.toThrow();
  });
});
