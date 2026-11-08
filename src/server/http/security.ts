import type { FastifyInstance, FastifyRequest } from 'fastify';

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Response carries a guest secret or booking details: no caching, no indexing (design §5.7). */
    sensitive?: boolean;
  }
}

/**
 * Rewrite URLs before they are logged (design §5.7): manage tokens travel in the path of
 * /api/bookings/{token}/…, so access logs would otherwise contain them.
 */
export function redactUrl(url: string): string {
  return url.replace(/^\/api\/bookings\/[^/?#]+/, '/api/bookings/:token');
}

/** Only these fields of a request are ever logged — never headers or bodies. */
export const logSerializers = {
  req(req: FastifyRequest) {
    return { method: req.method, url: redactUrl(req.url), remoteAddress: req.ip };
  },
};

/** Belt and braces in case a header or body object is logged explicitly somewhere. */
export const logRedactPaths = [
  'req.headers.cookie', 'req.headers.authorization', 'req.headers["idempotency-key"]',
  'res.headers["set-cookie"]', '*.hold_secret', '*.manage_token', '*.password',
];

export function installSecurityHeaders(app: FastifyInstance): void {
  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('X-Request-Id', req.id);
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    if (req.routeOptions.config?.sensitive) {
      reply.header('Cache-Control', 'no-store');
      reply.header('X-Robots-Tag', 'noindex, nofollow');
    }
    return payload;
  });
}
