import type { FastifyInstance } from 'fastify';
import { sendResult } from '../http/reply.js';
import { bookingByToken } from '../services/host-queries.js';
import { rescheduleBooking } from '../services/reschedule.js';
import { cancelByGuest } from '../services/cancel.js';
import { rateLimit, type RouteContext } from './context.js';

type Token = { Params: { token: string } };

/** The guest's private manage link: /api/bookings/{token}/… (URL is redacted in logs). */
export function bookingRoutes(ctx: RouteContext) {
  const deps = { db: ctx.db, faults: ctx.faults, lockTimeoutMs: ctx.lockTimeoutMs };
  return async (app: FastifyInstance) => {
    app.get<Token>('/bookings/:token', { config: { sensitive: true, rateLimit: rateLimit(ctx, 'bookingView') } }, async (req, reply) =>
      sendResult(reply, await bookingByToken(ctx.db, req.params.token)));
    app.post<Token>('/bookings/:token/reschedule', { config: { sensitive: true, rateLimit: rateLimit(ctx, 'reschedule') } }, async (req, reply) =>
      sendResult(reply, await rescheduleBooking(deps, req.params.token, req.body ?? {})));
    app.post<Token>('/bookings/:token/cancel', { config: { sensitive: true, rateLimit: rateLimit(ctx, 'cancel') } }, async (req, reply) =>
      sendResult(reply, await cancelByGuest(deps, req.params.token, req.body ?? {})));
  };
}
