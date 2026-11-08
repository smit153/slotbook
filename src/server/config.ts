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
});

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
