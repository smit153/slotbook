import type { FastifyReply, FastifyRequest } from 'fastify';
import type {} from '@fastify/cookie';
import type {} from '@fastify/rate-limit';
import type { Config } from '../config.js';
import type { Database } from '../db/kysely.js';
import type { Faults } from '../services/tx.js';
import { SESSION_COOKIE, sessionHost, type HostMe } from '../services/auth.js';

export interface RouteContext {
  db: Database;
  config: Config;
  origins: Set<string>;
  /** Test hooks forwarded to the write services. */
  faults?: Faults;
  lockTimeoutMs?: number;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by requireHost. (Fastify's own `request.host` is the Host header.) */
    sessionHost?: HostMe;
  }
}

/**
 * CSRF defence in depth for cookie-authenticated writes (design §5.7). SameSite=Lax + JSON-only
 * bodies already stop cross-site form posts; additionally, a browser-sent Origin must be one of
 * ours (APP_ORIGIN, the Vite dev origin in development, EXTRA_ALLOWED_ORIGINS). Requests without
 * an Origin header (curl, server-to-server) are allowed — they cannot carry a victim's cookie.
 */
export function originGuard(ctx: RouteContext) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const origin = req.headers.origin;
    if (origin !== undefined && !ctx.origins.has(origin)) {
      return reply.code(403).send({ error: { code: 'ORIGIN_NOT_ALLOWED', message: 'Cross-origin request refused' } });
    }
  };
}

/** /api/host/* and /api/me: a valid, unexpired session of an active host. */
export function requireHost(ctx: RouteContext) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const host = await sessionHost(ctx.db, req.cookies[SESSION_COOKIE]);
    if (!host) return reply.code(401).send({ error: { code: 'UNAUTHENTICATED', message: 'Please log in' } });
    req.sessionHost = host;
  };
}
