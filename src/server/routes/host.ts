import type { FastifyInstance } from 'fastify';
import { sendResult } from '../http/reply.js';
import {
  createEventType, getAvailability, getSettings, listEventTypes, replaceAvailability, updateEventType, updateSettings,
} from '../services/host-admin.js';
import { listHostBookings, listHostNotifications } from '../services/host-queries.js';
import { cancelByHost } from '../services/cancel.js';
import { timeZoneChoices } from '../../shared/timezones.js';
import { originGuard, requireHost, type RouteContext } from './context.js';

type Id = { Params: { id: string } };

/** Everything under /api/host requires a session; writes also pass the Origin check. */
export function hostRoutes(ctx: RouteContext) {
  const deps = { db: ctx.db, faults: ctx.faults, lockTimeoutMs: ctx.lockTimeoutMs };
  return async (app: FastifyInstance) => {
    app.addHook('preHandler', requireHost(ctx));
    const write = { preHandler: originGuard(ctx), config: { sensitive: true } };
    const hostId = (req: { sessionHost?: { id: string } }) => req.sessionHost!.id;

    app.get('/settings', async (req) => ({ ...(await getSettings(ctx.db, hostId(req))), timezones: timeZoneChoices() }));
    app.put('/settings', write, async (req, reply) => sendResult(reply, await updateSettings(deps, hostId(req), req.body ?? {})));

    app.get('/event-types', async (req) => ({ event_types: await listEventTypes(ctx.db, hostId(req)) }));
    app.post('/event-types', write, async (req, reply) => sendResult(reply, await createEventType(deps, hostId(req), req.body ?? {})));
    app.patch<Id>('/event-types/:id', write, async (req, reply) =>
      sendResult(reply, await updateEventType(deps, hostId(req), req.params.id, req.body ?? {})));
    // Deliberately no DELETE: event types are deactivated (active: false), never deleted.

    app.get('/availability', async (req) => getAvailability(ctx.db, hostId(req)));
    app.put('/availability', write, async (req, reply) => sendResult(reply, await replaceAvailability(deps, hostId(req), req.body ?? {})));

    app.get<{ Querystring: { upcoming?: string } }>('/bookings', { config: { sensitive: true } }, async (req) =>
      ({ bookings: await listHostBookings(ctx.db, hostId(req), { upcoming: req.query.upcoming === '1' || req.query.upcoming === 'true' }) }));
    app.post<Id>('/bookings/:id/cancel', write, async (req, reply) =>
      sendResult(reply, await cancelByHost(deps, hostId(req), req.params.id, req.body ?? {})));

    app.get('/notifications', { config: { sensitive: true } }, async (req) => ({ notifications: await listHostNotifications(ctx.db, hostId(req)) }));
  };
}
