import type { FastifyInstance } from 'fastify';
import { sendResult } from '../http/reply.js';
import { eventInfo, guestSlots } from '../services/slots-view.js';
import type { RouteContext } from './context.js';

type HostEvent = { Params: { host: string; slug: string } };

export function publicRoutes(ctx: RouteContext) {
  return async (app: FastifyInstance) => {
    app.get<HostEvent>('/hosts/:host/events/:slug', async (req, reply) =>
      sendResult(reply, await eventInfo(ctx.db, req.params.host, req.params.slug)));

    app.get<HostEvent>('/hosts/:host/events/:slug/slots', async (req, reply) =>
      sendResult(reply, await guestSlots(ctx.db, req.params.host, req.params.slug, req.query)));
  };
}
