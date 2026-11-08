import type { FastifyInstance } from 'fastify';
import { sendResult } from '../http/reply.js';
import { login, logout, SESSION_COOKIE } from '../services/auth.js';
import { originGuard, requireHost, type RouteContext } from './context.js';

export function authRoutes(ctx: RouteContext) {
  const cookieOptions = {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: ctx.config.NODE_ENV === 'production',
    path: '/',
  };

  return async (app: FastifyInstance) => {
    // Brute-force protection: @fastify/rate-limit on this route only (~10/min per client IP;
    // request.ip respects TRUST_PROXY). In-memory store: per app instance (design §5.8 notes).
    app.post('/auth/login', {
      config: { sensitive: true, rateLimit: { max: 10, timeWindow: '1 minute' } },
      preHandler: originGuard(ctx),
    }, async (req, reply) => {
      const r = await login(ctx.db, req.body ?? {}, ctx.config.SESSION_TTL_HOURS);
      if (r.sessionToken) {
        reply.setCookie(SESSION_COOKIE, r.sessionToken, { ...cookieOptions, maxAge: ctx.config.SESSION_TTL_HOURS * 3600 });
      }
      return sendResult(reply, { status: r.status, body: r.body });
    });

    app.post('/auth/logout', { preHandler: originGuard(ctx) }, async (req, reply) => {
      await logout(ctx.db, req.cookies[SESSION_COOKIE]);
      reply.clearCookie(SESSION_COOKIE, cookieOptions);
      return reply.code(204).send();
    });

    app.get('/me', { preHandler: requireHost(ctx) }, async (req) => ({ host: req.sessionHost }));
  };
}
