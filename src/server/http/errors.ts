import type { FastifyError, FastifyInstance } from 'fastify';
import { isLockTimeout, isRetryable } from '../services/tx.js';

const FASTIFY_CODES: Record<string, string> = {
  FST_ERR_CTP_INVALID_MEDIA_TYPE: 'UNSUPPORTED_MEDIA_TYPE',
  FST_ERR_CTP_EMPTY_JSON_BODY: 'VALIDATION',
  FST_ERR_CTP_INVALID_JSON_BODY: 'INVALID_JSON',
  FST_ERR_CTP_BODY_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
};

/**
 * One JSON error shape everywhere: {error: {code, message}}. Never a stack trace in a response.
 * A deadlock / serialization failure / lock timeout that escapes a service is still a 503
 * with Retry-After, never a 500 (the write paths already retry once inside writeTx).
 */
export function installErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError, req, reply) => {
    if (isRetryable(err) || isLockTimeout(err)) {
      req.log.warn({ code: err.code }, 'transient database conflict reached the error handler');
      reply.header('Retry-After', '1');
      return reply.code(503).send({ error: { code: isLockTimeout(err) ? 'HOST_BUSY' : 'TRY_AGAIN', message: 'Please retry in a moment' } });
    }
    if (err.validation) return reply.code(400).send({ error: { code: 'VALIDATION', message: err.message } });
    const status = err.statusCode ?? 500;
    if (status === 429) {
      return reply.code(429).send({ error: { code: 'RATE_LIMITED', message: 'Too many attempts; please wait a minute' } });
    }
    if (status >= 400 && status < 500) {
      return reply.code(status).send({ error: { code: FASTIFY_CODES[err.code] ?? 'BAD_REQUEST', message: err.message } });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: { code: 'INTERNAL', message: 'Something went wrong', request_id: req.id } });
  });
}
