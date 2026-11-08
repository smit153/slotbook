import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import Fastify, { LogController, type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { sql } from 'kysely';
import { allowedOrigins, type Config } from './config.js';
import type { Database } from './db/kysely.js';
import { installErrorHandling } from './http/errors.js';
import { installSecurityHeaders, logRedactPaths, logSerializers } from './http/security.js';
import type { Faults } from './services/tx.js';
import type { RouteContext } from './routes/context.js';
import { publicRoutes } from './routes/public.js';
import { holdRoutes } from './routes/holds.js';
import { bookingRoutes } from './routes/bookings.js';
import { authRoutes } from './routes/auth.js';
import { hostRoutes } from './routes/host.js';

export interface AppDeps {
  config: Config;
  db: Database;
  /** false = no logging (most tests); a stream captures logs (R21 test). */
  log?: false | { level?: string; stream?: NodeJS.WritableStream };
  /** Test hooks forwarded to the write services. */
  faults?: Faults;
  lockTimeoutMs?: number;
}

/**
 * Hop-count trust, the same semantics as proxy-addr's numeric option (Fastify's
 * types only accept boolean/string/function): hop 0 is the socket peer, so with
 * n = 1 we trust the peer (Render's proxy) and take the next address from
 * X-Forwarded-For as the client.
 */
export function trustProxyOption(hops: false | number): false | ((addr: string, hop: number) => boolean) {
  if (hops === false) return false;
  return (_addr, hop) => hop < hops;
}

export async function buildApp({ config, db, log, faults, lockTimeoutMs }: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: log === false
      ? false
      : {
          level: log?.level ?? config.LOG_LEVEL,
          serializers: logSerializers,
          redact: logRedactPaths,
          ...(log?.stream ? { stream: log.stream } : {}),
        },
    trustProxy: trustProxyOption(config.TRUST_PROXY),
    genReqId: () => randomUUID(),
    // (Fastify 5.x: requestIdLogLabel moved into the log controller.)
    logController: new LogController({ requestIdLogLabel: 'request_id' }),
  });

  installSecurityHeaders(app);
  installErrorHandling(app);
  await app.register(fastifyCookie);
  // global: false → only routes that opt in (login today; abuse protection later) are limited.
  await app.register(fastifyRateLimit, { global: false });

  const ctx: RouteContext = { db, config, origins: allowedOrigins(config), faults, lockTimeoutMs };

  app.get('/health', async (_req, reply) => {
    try {
      await sql`select 1`.execute(db);
      return { status: 'ok', db: 'ok' };
    } catch (err) {
      app.log.error({ err }, 'health check: database unreachable');
      return reply.code(503).send({ status: 'error', db: 'down' });
    }
  });

  await app.register(publicRoutes(ctx), { prefix: '/api' });
  await app.register(holdRoutes(ctx), { prefix: '/api' });
  await app.register(bookingRoutes(ctx), { prefix: '/api' });
  await app.register(authRoutes(ctx), { prefix: '/api' });
  await app.register(hostRoutes(ctx), { prefix: '/api/host' });

  // Serve the built SPA when present (production / docker). In dev, Vite serves it.
  const webDist = config.WEB_DIST_DIR;
  const spa = !!webDist && existsSync(join(webDist, 'index.html'));
  if (spa) await app.register(fastifyStatic, { root: webDist, wildcard: false });

  app.setNotFoundHandler((req, reply) => {
    const isApi = req.url.startsWith('/api/') || req.url === '/api' || req.url === '/health';
    if (spa && req.method === 'GET' && !isApi) return reply.sendFile('index.html');
    return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
  });

  return app;
}
