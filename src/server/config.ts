import { z } from 'zod';

/**
 * TRUST_PROXY (design §10 #11):
 *   "false" / "0" (default) → request.ip is the socket peer; X-Forwarded-For is ignored.
 *   "<n>" (n ≥ 1)           → trust exactly n proxy hops (Render: 1).
 * "true" (trust every hop) is rejected on purpose: any client could then spoof
 * X-Forwarded-For and dodge the per-IP hold cap.
 */
const trustProxySchema = z
  .string()
  .trim()
  .default('false')
  .transform((v, ctx): false | number => {
    if (v === 'false' || v === '0' || v === '') return false;
    if (/^[1-9]\d*$/.test(v)) return Number(v);
    ctx.addIssue({
      code: 'custom',
      message: 'TRUST_PROXY must be "false" or a hop count like "1" (never "true")',
    });
    return z.NEVER;
  });

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.string().url(),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(200).default(10),
  APP_SECRET: z.string().min(32, 'APP_SECRET must be at least 32 characters'),
  TRUST_PROXY: trustProxySchema,
  WEB_DIST_DIR: z.string().optional(),
  /** The public origin of the app, e.g. https://slotbook.onrender.com. Host writes must come from here. */
  APP_ORIGIN: z.string().url().optional(),
  /** Extra allowed origins, comma-separated (e.g. a staging UI). */
  EXTRA_ALLOWED_ORIGINS: z.string().optional(),
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(24 * 90).default(24 * 7),
}).superRefine((env, ctx) => {
  if (env.NODE_ENV === 'production' && !env.APP_ORIGIN) {
    ctx.addIssue({ code: 'custom', path: ['APP_ORIGIN'], message: 'APP_ORIGIN is required in production' });
  }
});

/** Vite's dev server: its proxy forwards the browser's Origin (http://localhost:5173) unchanged. */
export const VITE_DEV_ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173'];

/**
 * Origins allowed to make cookie-authenticated writes (design §5.7, CSRF defence in depth):
 * APP_ORIGIN (default http://localhost:PORT), + the Vite dev origins in development,
 * + EXTRA_ALLOWED_ORIGINS. Normalised with URL#origin (scheme + host + port).
 */
export function allowedOrigins(c: Pick<Config, 'NODE_ENV' | 'PORT' | 'APP_ORIGIN' | 'EXTRA_ALLOWED_ORIGINS'>): Set<string> {
  const list = [c.APP_ORIGIN ?? `http://localhost:${c.PORT}`];
  if (c.NODE_ENV === 'development') list.push(...VITE_DEV_ORIGINS);
  for (const o of (c.EXTRA_ALLOWED_ORIGINS ?? '').split(',')) if (o.trim()) list.push(o.trim());
  return new Set(list.map((o) => new URL(o).origin));
}

export type Config = z.output<typeof envSchema>;

export class ConfigError extends Error {
  override name = 'ConfigError';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(env)'}: ${i.message}`)
      .join('\n');
    throw new ConfigError(`Invalid environment configuration:\n${details}`);
  }
  return parsed.data;
}
