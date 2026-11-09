import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, PUBLIC_DEFAULT_APP_SECRET, startupWarnings } from '../../src/server/config.js';

const base = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  APP_SECRET: 'x'.repeat(32),
};

describe('loadConfig', () => {
  it('applies defaults for a minimal valid env', () => {
    const c = loadConfig(base);
    expect(c.PORT).toBe(3000);
    expect(c.DB_POOL_MAX).toBe(10);
    expect(c.TRUST_PROXY).toBe(false);
    expect(c.NODE_ENV).toBe('development');
  });

  it('fails fast when DATABASE_URL is missing', () => {
    expect(() => loadConfig({ APP_SECRET: base.APP_SECRET })).toThrow(ConfigError);
  });

  it('rejects an APP_SECRET shorter than 32 chars', () => {
    expect(() => loadConfig({ ...base, APP_SECRET: 'short' })).toThrow(/APP_SECRET/);
  });

  it.each([
    ['false', false],
    ['0', false],
    ['1', 1],
    ['2', 2],
  ] as const)('TRUST_PROXY=%s → %s', (raw, expected) => {
    expect(loadConfig({ ...base, TRUST_PROXY: raw }).TRUST_PROXY).toBe(expected);
  });

  it.each(['true', 'yes', '-1', '1.5', '10.0.0.1'])('rejects TRUST_PROXY=%s (no blanket trust)', (raw) => {
    expect(() => loadConfig({ ...base, TRUST_PROXY: raw })).toThrow(/TRUST_PROXY/);
  });
});

describe('startup warning for the public default APP_SECRET', () => {
  it('warns loudly when APP_SECRET is the default from docker-compose.yml / .env.example', () => {
    const w = startupWarnings(loadConfig({ ...base, APP_SECRET: PUBLIC_DEFAULT_APP_SECRET, NODE_ENV: 'production', APP_ORIGIN: 'http://localhost:3000' }));
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/^!!! INSECURE: APP_SECRET is the PUBLIC default/);
    expect(w[0]).toMatch(/NODE_ENV=production/);
  });

  it('is silent for any other secret', () => {
    expect(startupWarnings(loadConfig(base))).toEqual([]);
  });

  it('the constant is exactly what docker-compose.yml and .env.example ship (no drift)', () => {
    const root = resolve(import.meta.dirname, '../..');
    expect(readFileSync(join(root, 'docker-compose.yml'), 'utf8')).toContain(`APP_SECRET: \${APP_SECRET:-${PUBLIC_DEFAULT_APP_SECRET}}`);
    expect(readFileSync(join(root, '.env.example'), 'utf8')).toContain(`APP_SECRET=${PUBLIC_DEFAULT_APP_SECRET}\n`);
  });
});
