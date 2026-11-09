import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ENV_KEYS } from '../../src/server/config.js';

/**
 * The README's configuration table is the documentation of every environment variable.
 * This fails when a variable is added to the config schema, read via process.env, or
 * substituted in docker-compose.yml without a row in that table.
 */
const root = resolve(import.meta.dirname, '../..');
const readme = readFileSync(join(root, 'README.md'), 'utf8');
const configSection = readme.slice(readme.indexOf('## Configuration'), readme.indexOf('\n## ', readme.indexOf('## Configuration') + 1));
/** Every `NAME` in the first column of a table row (a cell may list several: `A` / `B`). */
const documented = new Set(
  configSection.split('\n')
    .filter((l) => l.startsWith('| `'))
    .flatMap((l) => [...l.split('|')[1]!.matchAll(/`([A-Z][A-Z0-9_]*)`/g)].map((m) => m[1]!)),
);

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? filesUnder(p) : /\.tsx?$/.test(name) ? [p] : [];
  });
}

describe('README configuration table', () => {
  it('has a configuration section with rows', () => {
    expect(configSection.startsWith('## Configuration')).toBe(true);
    expect(documented.size).toBeGreaterThan(10);
  });

  it('documents every variable in the config schema', () => {
    expect(ENV_KEYS.filter((k) => !documented.has(k))).toEqual([]);
  });

  it('documents every process.env read in src/, scripts/ and the test global setup', () => {
    const files = [...filesUnder(join(root, 'src')), ...filesUnder(join(root, 'scripts')), join(root, 'test/global-setup.ts')];
    const read = new Set(files.flatMap((f) => [...readFileSync(f, 'utf8').matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)].map((m) => m[1]!)));
    expect(read.size).toBeGreaterThan(0);
    expect([...read].filter((k) => !documented.has(k))).toEqual([]);
  });

  it('documents every ${VAR} substituted in docker-compose.yml', () => {
    const compose = readFileSync(join(root, 'docker-compose.yml'), 'utf8');
    const vars = [...compose.matchAll(/\$\{([A-Z][A-Z0-9_]*)/g)].map((m) => m[1]!);
    expect(vars.length).toBeGreaterThan(0);
    expect(vars.filter((k) => !documented.has(k))).toEqual([]);
  });
});
