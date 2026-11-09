import { defineConfig, devices } from '@playwright/test';

/**
 * Real-browser tests of the guest flow against the production Docker build.
 * Run with `pnpm e2e` (scripts/e2e.sh starts and removes the stack). Chromium only (agreed).
 *
 * - workers: 1: every request comes from the same Docker-network IP, and the per-IP cap allows
 *   3 active holds; tests run one at a time and confirm or release what they hold.
 * - retries: 0: a flaky test should fail loudly, not be retried into green.
 * - Default browser zone is Europe/Berlin; tests that need another zone set their own.
 */
export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3100',
    locale: 'en-US',
    timezoneId: 'Europe/Berlin',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
