import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Design §5.5: no time-zone math in SQL. Postgres compares UTC instants only; every
 * wall-clock/zone computation goes through Luxon. This scans all server code (including
 * migrations) for SQL constructs that depend on a zone or on the session TimeZone.
 */
const FORBIDDEN: Array<[string, RegExp]> = [
  ['AT TIME ZONE', /\bAT\s+TIME\s+ZONE\b/i],
  ['timezone()', /\btimezone\s*\(/i],
  ['SET TIME ZONE / SET timezone', /\bSET\s+(?:LOCAL\s+)?(?:TIME\s+ZONE|timezone)\b/i],
  ['::date cast', /::\s*date\b/i],
  ['date_trunc()', /\bdate_trunc\s*\(/i],
  ['extract()/date_part()', /\b(?:extract|date_part)\s*\(/i],
  ['to_char()', /\bto_char\s*\(/i],
  ['current_date / localtime(stamp)', /\b(?:current_date|localtime(?:stamp)?)\b/i],
  // Day/week/month/year intervals on timestamptz are evaluated in the session TimeZone.
  ['calendar interval literal', /interval\s+'[^']*\b(?:days?|weeks?|months?|years?)\b[^']*'/i],
  ['calendar make_interval', /make_interval\s*\([^)]*\b(?:days|weeks|months|years)\s*=>/i],
];

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return tsFiles(path);
    return path.endsWith('.ts') ? [path] : [];
  });
}

describe('no time-zone math in SQL (design §5.5)', () => {
  it('src/ contains none of the forbidden SQL constructs', () => {
    const hits: string[] = [];
    for (const file of tsFiles('src')) {
      readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        for (const [label, re] of FORBIDDEN) if (re.test(line)) hits.push(`${file}:${i + 1} ${label}: ${line.trim()}`);
      });
    }
    expect(hits).toEqual([]);
  });

  it('the patterns catch what they should (scanner is not vacuous)', () => {
    const samples = [
      "SELECT start_at AT TIME ZONE 'America/New_York'",
      "SELECT timezone('UTC', now())",
      "SET LOCAL TIME ZONE 'UTC'",
      'SELECT start_at::date',
      "SELECT date_trunc('day', start_at)",
      'SELECT extract(hour from start_at)',
      "SELECT to_char(start_at, 'HH24')",
      'SELECT current_date',
      "SELECT now() + interval '1 day'",
      'SELECT now() + make_interval(days => 1)',
    ];
    for (const s of samples) expect(FORBIDDEN.some(([, re]) => re.test(s)), s).toBe(true);
  });

  it('…and allow the zone-independent forms we do use', () => {
    const ok = [
      "now() + interval '5 minutes'",
      'start_at - make_interval(mins => 15)',
      'date date NOT NULL',
      'timezone text NOT NULL',
    ];
    for (const s of ok) expect(FORBIDDEN.some(([, re]) => re.test(s)), s).toBe(false);
  });
});
