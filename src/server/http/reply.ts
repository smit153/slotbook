import type { FastifyReply } from 'fastify';
import type { ServiceResult } from '../services/errors.js';

/** Send a service result with the protocol headers that go with it. */
export function sendResult(reply: FastifyReply, r: ServiceResult<unknown>): FastifyReply {
  if (r.replayed) reply.header('Idempotent-Replayed', 'true');
  if (r.status === 503) reply.header('Retry-After', '1');
  if (r.status === 429 && !reply.hasHeader('Retry-After')) reply.header('Retry-After', '60');
  return reply.code(r.status).send(r.body);
}
