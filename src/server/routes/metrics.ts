import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { collectMetrics, renderMetrics } from '../services/metrics.js';
import type { RouteContext } from './context.js';

/**
 * GET /metrics. Access (agreed in the Phase 12 plan):
 *  - METRICS_TOKEN set   → requires `Authorization: Bearer <token>` (401 otherwise)
 *  - unset, development/test → open
 *  - unset, production   → 404 (as if the route did not exist)
 * Not rate limited (scrapers poll it); never cached.
 */
export function metricsRoutes(ctx: RouteContext) {
  const token = ctx.config.METRICS_TOKEN;
  const authorized = (header: string | undefined): boolean => {
    if (!token) return true;
    const want = Buffer.from(`Bearer ${token}`);
    const got = Buffer.from(header ?? '');
    return got.length === want.length && timingSafeEqual(got, want);
  };

  return async (app: FastifyInstance) => {
    app.get('/metrics', async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!token && ctx.config.NODE_ENV === 'production') {
        return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
      }
      if (!authorized(req.headers.authorization)) {
        reply.header('WWW-Authenticate', 'Bearer');
        return reply.code(401).send({ error: { code: 'UNAUTHENTICATED', message: 'Metrics need a bearer token' } });
      }
      const body = renderMetrics(await collectMetrics(ctx.db), ctx.rateLimited);
      return reply.type('text/plain; version=0.0.4; charset=utf-8').send(body);
    });
  };
}
