import { existsSync } from 'node:fs';
import { join } from 'node:path';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import fastifyStatic from '@fastify/static';
import { sql } from 'kysely';
import type { Config } from './config.js';
import type { Database } from './db/kysely.js';

export interface AppDeps {
  config: Pick<Config, 'TRUST_PROXY' | 'LOG_LEVEL' | 'WEB_DIST_DIR'>;
  db: Database;
  /** Override the Fastify logger (tests pass false). */
  logger?: FastifyServerOptions['logger'];
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

export async function buildApp({ config, db, logger }: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: logger ?? { level: config.LOG_LEVEL },
    trustProxy: trustProxyOption(config.TRUST_PROXY),
  });

  app.get('/health', async (_req, reply) => {
    try {
      await sql`select 1`.execute(db);
      return { status: 'ok', db: 'ok' };
    } catch (err) {
      app.log.error({ err }, 'health check: database unreachable');
      return reply.code(503).send({ status: 'error', db: 'down' });
    }
  });

  // Serve the built SPA when present (production / docker). In dev, Vite serves it.
  const webDist = config.WEB_DIST_DIR;
  if (webDist && existsSync(join(webDist, 'index.html'))) {
    await app.register(fastifyStatic, { root: webDist, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      const isApi = req.url.startsWith('/api/') || req.url === '/api' || req.url === '/health';
      if (req.method === 'GET' && !isApi) return reply.sendFile('index.html');
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
    });
  }

  return app;
}
