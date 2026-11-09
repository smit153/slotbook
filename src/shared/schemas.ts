import { z } from 'zod';

/** Shared between the API and the web app. */

/** RFC 3339 instant with an explicit offset or Z; the server normalises to UTC. */
export const instantSchema = z.iso.datetime({ offset: true });

export const holdRequestSchema = z.object({
  host: z.string().min(1).max(64),
  slug: z.string().min(1).max(64),
  start_at: instantSchema,
});
export type HoldRequestBody = z.infer<typeof holdRequestSchema>;

/** Idempotency-Key header: 8–128 visible ASCII characters (a UUID is typical). */
export const idempotencyKeySchema = z.string().regex(/^[\x21-\x7e]{8,128}$/, 'Idempotency-Key must be 8–128 visible ASCII characters');

export const uuidSchema = z.uuid();

export const holdSecretBodySchema = z.object({ hold_secret: z.string().min(1).max(128) });

export const confirmRequestSchema = z.object({
  hold_secret: z.string().min(1).max(128),
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().toLowerCase().pipe(z.email().max(320)),
  tz: z.string().min(1).max(64),
});
export type ConfirmRequestBody = z.infer<typeof confirmRequestSchema>;

export const rescheduleRequestSchema = z.object({ start_at: instantSchema });

export const guestCancelSchema = z.object({ reason: z.string().trim().max(500).optional() });
export const hostCancelSchema = z.object({ reason: z.string().trim().min(1).max(500) });

/** POST /api/waitlist (design §13.5). Email trimmed + lower-cased like confirm. */
export const waitlistJoinSchema = z.object({
  host: z.string().min(1).max(64),
  slug: z.string().min(1).max(64),
  start_at: instantSchema,
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().toLowerCase().pipe(z.email().max(320)),
  tz: z.string().min(1).max(64),
});
