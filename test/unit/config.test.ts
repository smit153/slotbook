import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../src/server/config.js';

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
