import { defineConfig } from 'vitest/config';

/**
 * Two projects:
 *  - unit:        pure code, no database.
 *  - integration: real Postgres. globalSetup starts a throwaway container (or uses
 *                 TEST_DATABASE_URL), migrates it and provides the URL to tests.
 *                 Files run one at a time because they share that database.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['test/unit/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          environment: 'node',
          globalSetup: ['test/global-setup.ts'],
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
