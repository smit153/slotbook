import type { FastifyInstance } from 'fastify';
import type { ServerResponse } from 'node:http';
import { rateLimit, type RouteContext } from './context.js';

/** Concurrent live-update streams per client IP (several tabs are fine; a bot opening hundreds is not). */
export const MAX_STREAMS_PER_IP = 3;
/** Heartbeats keep proxies from closing an idle stream and let the page notice a dead one. */
export const HEARTBEAT_MS = 25_000;

type HostEvent = { Params: { host: string; slug: string } };

/**
 * GET /api/hosts/{host}/events/{slug}/stream (Phase 14): Server-Sent Events. Sends only
 * `event: slots` ("slots changed, refetch"), `event: ready` once, and `event: ping` heartbeats.
 * Never booking or guest data. Opening it is rate-limited (slotStream) and the number of
 * concurrent streams per IP is capped separately (429 STREAM_LIMIT).
 */
export function streamRoutes(ctx: RouteContext, opts: { heartbeatMs?: number } = {}) {
  const perIp = new Map<string, number>();
  const open = new Set<ServerResponse>();
  const heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;

  return async (app: FastifyInstance) => {
    // End every stream before the server closes, or close() would wait on them forever.
    app.addHook('preClose', async () => { for (const res of open) res.end(); });

    app.get<HostEvent>('/hosts/:host/events/:slug/stream', { config: { rateLimit: rateLimit(ctx, 'slotStream') } }, async (req, reply) => {
      const row = await ctx.db.selectFrom('event_types as e').innerJoin('hosts as h', 'h.id', 'e.host_id')
        .select('h.id as host_id')
        .where('h.slug', '=', req.params.host).where('h.active', '=', true)
        .where('e.slug', '=', req.params.slug).where('e.active', '=', true)
        .executeTakeFirst();
      if (!row) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Unknown host or event type' } });

      const ip = req.ip;
      if ((perIp.get(ip) ?? 0) >= MAX_STREAMS_PER_IP) {
        reply.header('Retry-After', '30');
        return reply.code(429).send({ error: { code: 'STREAM_LIMIT', message: `At most ${MAX_STREAMS_PER_IP} live-update streams at once` } });
      }

      let ready = false;
      const res = reply.raw;
      const send = (event: string) => { if (ready && !res.writableEnded) res.write(`event: ${event}\ndata: {}\n\n`); };
      let unsubscribe: () => void;
      try {
        unsubscribe = await ctx.slotEvents.subscribe(row.host_id, () => send('slots'));
      } catch (err) {
        req.log.warn({ err }, 'live updates unavailable');
        reply.header('Retry-After', '5');
        return reply.code(503).send({ error: { code: 'SERVER_BUSY', message: 'Live updates are unavailable; the page will poll instead' } });
      }

      perIp.set(ip, (perIp.get(ip) ?? 0) + 1);
      open.add(res);
      reply.hijack(); // from here on we own the raw response (onSend hooks don't run: set headers here)
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
        'x-request-id': String(req.id),
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
      });
      res.write('retry: 3000\n\n');
      ready = true;
      send('ready');
      const heartbeat = setInterval(() => send('ping'), heartbeatMs);

      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        clearInterval(heartbeat);
        unsubscribe();
        open.delete(res);
        const n = (perIp.get(ip) ?? 1) - 1;
        if (n <= 0) perIp.delete(ip); else perIp.set(ip, n);
      };
      req.raw.on('close', cleanup);
      res.on('close', cleanup);
    });
  };
}
