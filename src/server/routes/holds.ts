import type { FastifyInstance } from 'fastify';
import { sendResult } from '../http/reply.js';
import { createHold } from '../services/holds.js';
import { releaseHold } from '../services/release.js';
import { confirmHold, type Confirmed } from '../services/confirm.js';
import type { RouteContext } from './context.js';

type HoldId = { Params: { id: string } };
const bodyOf = (b: unknown) => (b && typeof b === 'object' ? (b as Record<string, unknown>) : {});

export function holdRoutes(ctx: RouteContext) {
  const deps = { db: ctx.db, appSecret: ctx.config.APP_SECRET, faults: ctx.faults, lockTimeoutMs: ctx.lockTimeoutMs };

  return async (app: FastifyInstance) => {
    // The hold secret is in the response, so it is sensitive too (no-store).
    app.post('/holds', { config: { sensitive: true } }, async (req, reply) => {
      const key = req.headers['idempotency-key'];
      if (typeof key !== 'string' || key.length === 0) {
        return reply.code(400).send({ error: { code: 'IDEMPOTENCY_KEY_REQUIRED', message: 'Send an Idempotency-Key header (e.g. a UUID)' } });
      }
      const b = bodyOf(req.body);
      return sendResult(reply, await createHold(deps, {
        host: b.host as string, slug: b.slug as string, start_at: b.start_at as string,
        clientIp: req.ip, idempotencyKey: key,
      }));
    });

    app.post<HoldId>('/holds/:id/release', { config: { sensitive: true } }, async (req, reply) =>
      sendResult(reply, await releaseHold(deps, req.params.id, bodyOf(req.body))));

    app.post<HoldId>('/holds/:id/confirm', { config: { sensitive: true } }, async (req, reply) => {
      const r = await confirmHold(deps, req.params.id, bodyOf(req.body));
      if (r.status === 200) {
        const body = r.body as Confirmed;
        // Fragment, not path: the token is never sent to a server or a Referer (design §5.7).
        return sendResult(reply, { ...r, body: { ...body, manage_url: `/manage#${body.manage_token}` } });
      }
      return sendResult(reply, r);
    });
  };
}
