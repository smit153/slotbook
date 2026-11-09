import { Writable } from 'node:stream';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { testDb, truncateAll } from '../../helpers/db.js';
import { assertSeatInvariant } from '../../helpers/invariants.js';
import { GUEST } from '../../helpers/flows.js';
import { HOST_PASSWORD, loginAs, makeApp, TEST_ORIGIN } from '../../helpers/app.js';
import { scenario } from '../../helpers/scenario.js';
import { PUBLIC_DEFAULT_APP_SECRET } from '../../../src/server/config.js';

/** R21: no guest or host secret ever reaches the logs; tokenised URLs are redacted. */
const db = testDb();
afterAll(() => db.destroy());
beforeEach(() => truncateAll(db));
afterEach(() => assertSeatInvariant(db));

function capture() {
  const lines: string[] = [];
  const stream = new Writable({ write(chunk, _enc, cb) { lines.push(String(chunk)); cb(); } });
  return { stream, text: () => lines.join('') };
}

describe('R21: secrets never reach the logs', () => {
  it('a full HTTP journey logs request lines with :token and no secret of any kind', async () => {
    const sc = await scenario(db);
    const logs = capture();
    const app = await makeApp(db, { log: { level: 'debug', stream: logs.stream } });
    const key = 'idem-key-SECRET-0123456789';

    const hold = await app.inject({ method: 'POST', url: '/api/holds', headers: { 'idempotency-key': key },
      payload: { host: sc.hostSlug, slug: sc.ev.slug, start_at: sc.slot.toISOString() } });
    const { hold_id, hold_secret } = hold.json();
    const confirm = await app.inject({ method: 'POST', url: `/api/holds/${hold_id}/confirm`, payload: { hold_secret, ...GUEST } });
    const { manage_token } = confirm.json();
    expect(confirm.json().manage_url).toBe(`/manage#${manage_token}`);

    await app.inject({ method: 'GET', url: `/api/bookings/${manage_token}` });
    await app.inject({ method: 'POST', url: `/api/bookings/${manage_token}/reschedule`,
      payload: { start_at: new Date(sc.slot.getTime() + 60 * 60_000).toISOString() } });
    await app.inject({ method: 'POST', url: `/api/bookings/${manage_token}/cancel`, payload: { reason: 'log test' } });

    const cookie = await loginAs(app, db, sc.hostId);
    await app.inject({ method: 'GET', url: '/api/host/bookings', headers: { cookie } });
    await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie, origin: TEST_ORIGIN } });
    await app.close();

    const text = logs.text();
    const sessionValue = cookie.split('=')[1]!;
    for (const [what, secret] of Object.entries({ hold_secret, manage_token, sessionValue, key, HOST_PASSWORD })) {
      expect(text.includes(secret as string), `${what} leaked into logs`).toBe(false);
    }
    expect(text).toContain('/api/bookings/:token');
    expect(text).toContain('/api/bookings/:token/reschedule');
    expect(text).toContain('"request_id"');
    // Sanity: the logs are not simply empty.
    expect(text.split('\n').filter(Boolean).length).toBeGreaterThan(10);
  });
});

describe('startup warning', () => {
  it('the app logs a loud warn line when APP_SECRET is the public compose default', async () => {
    const logs = capture();
    const app = await makeApp(db, { env: { APP_SECRET: PUBLIC_DEFAULT_APP_SECRET }, log: { level: 'info', stream: logs.stream } });
    await app.close();
    const warn = logs.text().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { level: number; msg: string; security?: boolean })
      .find((l) => l.msg.includes('APP_SECRET'));
    expect(warn).toMatchObject({ level: 40, security: true });
    expect(warn!.msg).toMatch(/^!!! INSECURE/);
  });
});
