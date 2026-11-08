import { describe, expect, it } from 'vitest';
import { runCodegen } from '../../scripts/db-types.js';
import { testDatabaseUrl } from '../helpers/db.js';

describe('generated Kysely types', () => {
  it('src/server/db/types.ts matches the migrated schema (run `pnpm db:types` if this fails)', () => {
    // The test DB is freshly migrated by globalSetup — the same source pnpm db:types uses.
    expect(runCodegen(testDatabaseUrl(), true)).toBe(0);
  }, 60_000);
});
