import type { FastifyInstance } from 'fastify';
import { sendResult } from '../http/reply.js';
import { claimOffer, joinWaitlist, leaveWaitlist, waitlistStatus } from '../services/waitlist.js';
import { rateLimit, type RouteContext } from './context.js';

type EntryId = { Params: { id: string } };
const bodyOf = (b: unknown) => (b && typeof b === 'object' ? (b as Record<string, unknown>) : {});

/**
 * Waitlist (design §13.5). The private token travels in the Waitlist-Token HEADER (never the
 * path or the body that could be logged); the page keeps it in the URL fragment.
 */
export function waitlistRoutes(ctx: RouteContext) {
  const deps = { db: ctx.db, appSecret: ctx.config.APP_SECRET, faults: ctx.faults, lockTimeoutMs: ctx.lockTimeoutMs };
  const token = (headers: Record<string, unknown>) => headers['waitlist-token'];

  return async (app: FastifyInstance) => {
    app.post('/waitlist', { config: { sensitive: true, rateLimit: rateLimit(ctx, 'waitlistJoin') } }, async (req, reply) => {
      const key = req.headers['idempotency-key'];
      if (typeof key !== 'string' || key.length === 0) {
        return reply.code(400).send({ error: { code: 'IDEMPOTENCY_KEY_REQUIRED', message: 'Send an Idempotency-Key header (e.g. a UUID)' } });
      }
      const b = bodyOf(req.body);
      return sendResult(reply, await joinWaitlist(deps, {
        host: b.host as string, slug: b.slug as string, start_at: b.start_at as string,
        name: b.name as string, email: b.email as string, tz: b.tz as string, clientIp: req.ip, idempotencyKey: key,
      }));
    });
    app.get<EntryId>('/waitlist/:id', { config: { sensitive: true, rateLimit: rateLimit(ctx, 'waitlistView') } }, async (req, reply) =>
      sendResult(reply, await waitlistStatus(deps, req.params.id, token(req.headers))));
    app.post<EntryId>('/waitlist/:id/claim', { config: { sensitive: true, rateLimit: rateLimit(ctx, 'waitlistClaim') } }, async (req, reply) =>
      sendResult(reply, await claimOffer(deps, req.params.id, token(req.headers))));
    app.post<EntryId>('/waitlist/:id/leave', { config: { sensitive: true, rateLimit: rateLimit(ctx, 'waitlistLeave') } }, async (req, reply) =>
      sendResult(reply, await leaveWaitlist(deps, req.params.id, token(req.headers))));
  };
}
