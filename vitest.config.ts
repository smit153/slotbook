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
        // UI tests: jsdom + Testing Library; fetch is routed into the REAL Fastify app and the
        // real test Postgres (test/web/fetch-shim.ts), so the UI is tested against the real API.
        test: {
          name: 'web',
          include: ['test/web/**/*.test.{ts,tsx}'],
          environment: 'jsdom',
          globalSetup: ['test/global-setup.ts'],
          setupFiles: ['test/web/setup.ts'],
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 120_000,
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
