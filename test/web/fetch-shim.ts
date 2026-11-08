import type { FastifyInstance } from 'fastify';
import { TEST_ORIGIN } from '../helpers/app.js';

/**
 * Routes the web app's fetch() into the real Fastify app via app.inject — same routes,
 * services, constraints and Postgres as production; no mocks. Behaves like a same-origin
 * browser: keeps a cookie jar (incl. HttpOnly cookies) and sends Origin on non-GET requests.
 */
export function installFetchShim(app: FastifyInstance, o: { remoteAddress?: string } = {}) {
  const jar = new Map<string, string>();
  const calls: Array<{ method: string; url: string; status: number }> = [];

  const shim = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.pathname + input.search : input.url;
    const method = (init.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => { headers[k] = v; });
    if (jar.size > 0) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (method !== 'GET') headers.origin = TEST_ORIGIN;

    const res = await app.inject({
      method: method as 'GET', url, headers,
      ...(init.body !== undefined && init.body !== null ? { payload: String(init.body) } : {}),
      remoteAddress: o.remoteAddress ?? '203.0.113.200',
    });
    for (const c of res.cookies) {
      if (c.value === '' || (c.maxAge !== undefined && c.maxAge <= 0)) jar.delete(c.name);
      else jar.set(c.name, c.value);
    }
    calls.push({ method, url, status: res.statusCode });
    const outHeaders = new Headers();
    for (const [k, v] of Object.entries(res.headers)) if (v !== undefined && k !== 'set-cookie') outHeaders.set(k, String(v));
    const body = res.statusCode === 204 || res.statusCode === 304 ? null : res.body;
    return new Response(body, { status: res.statusCode, headers: outHeaders });
  };

  const original = globalThis.fetch;
  globalThis.fetch = shim as typeof fetch;
  return { calls, jar, restore: () => { globalThis.fetch = original; } };
}
