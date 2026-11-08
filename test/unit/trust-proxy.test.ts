import { afterAll, describe, expect, it } from 'vitest';
import { makeApp } from '../helpers/app.js';
import { createDb } from '../../src/server/db/kysely.js';

// The pool is lazy: no connection is attempted because no route touches the DB.
const db = createDb({ connectionString: 'postgres://u:p@127.0.0.1:1/none' });
afterAll(() => db.destroy());

async function ipSeen(trustProxy: false | number, xff?: string): Promise<string> {
  const app = await makeApp(db, { env: { TRUST_PROXY: trustProxy === false ? 'false' : String(trustProxy) } });
  app.get('/__ip', async (req) => ({ ip: req.ip }));
  const res = await app.inject({
    method: 'GET',
    url: '/__ip',
    remoteAddress: '10.0.0.9', // the "proxy" (socket peer)
    headers: xff ? { 'x-forwarded-for': xff } : {},
  });
  await app.close();
  return (res.json() as { ip: string }).ip;
}

describe('trustProxy (design §10 #11)', () => {
  it('TRUST_PROXY=false ignores X-Forwarded-For entirely', async () => {
    expect(await ipSeen(false, '1.2.3.4')).toBe('10.0.0.9');
  });

  it('TRUST_PROXY=1 takes the address one hop behind the proxy', async () => {
    expect(await ipSeen(1, '1.2.3.4')).toBe('1.2.3.4');
  });

  it('TRUST_PROXY=1 cannot be fooled by a client-prepended fake address', async () => {
    // Client sends "X-Forwarded-For: 6.6.6.6"; the proxy appends the real client 1.2.3.4.
    expect(await ipSeen(1, '6.6.6.6, 1.2.3.4')).toBe('1.2.3.4');
  });
});
