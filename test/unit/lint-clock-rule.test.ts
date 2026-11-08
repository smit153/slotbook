import { describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';

const eslint = new ESLint();

async function clockViolations(code: string, filePath: string): Promise<number> {
  const [result] = await eslint.lintText(code, { filePath });
  return (result?.messages ?? []).filter((m) => m.ruleId === 'no-restricted-syntax').length;
}

describe('ESLint clock rule (design §5.5)', () => {
  const bad = 'export const a = Date.now();\nexport const b = new Date();\n';

  it('flags Date.now() and new Date() in services and engine', async () => {
    expect(await clockViolations(bad, 'src/server/services/x.ts')).toBe(2);
    expect(await clockViolations(bad, 'src/server/engine/x.ts')).toBe(2);
  });

  it("flags Luxon's clock reads (DateTime.now, DateTime.local(), Settings.now) in engine code", async () => {
    const luxon = [
      "import { DateTime, Settings } from 'luxon';",
      'export const a = DateTime.now();',
      'export const b = DateTime.local();',
      'export const c = Settings.now;',
    ].join('\n');
    expect(await clockViolations(luxon, 'src/server/engine/x.ts')).toBe(3);
  });

  it('allows Luxon calls that take explicit values', async () => {
    const ok = [
      "import { DateTime } from 'luxon';",
      'export const a = DateTime.local(2026, 11, 1);',
      "export const b = DateTime.fromISO('2026-11-01', { zone: 'utc' });",
    ].join('\n');
    expect(await clockViolations(ok, 'src/server/engine/x.ts')).toBe(0);
  });

  it('allows new Date(value), which parses rather than reads the clock', async () => {
    expect(await clockViolations('export const d = new Date("2026-01-01T00:00:00Z");\n', 'src/server/services/x.ts')).toBe(0);
  });

  it('does not apply outside booking logic (e.g. logging)', async () => {
    expect(await clockViolations(bad, 'src/server/app.ts')).toBe(0);
  });
});
