import { defineConfig, devices } from '@playwright/test';

/**
 * Set WEREWOLF_BASE_URL to run against an already-running deployment (e.g. the
 * hosted app) instead of booting a local server. Its clocks belong to that
 * deployment, so the per-test budget widens accordingly.
 */
const externalBaseURL = process.env.WEREWOLF_BASE_URL;
const port = process.env.WEREWOLF_E2E_PORT ?? '3100';

export default defineConfig({
  testDir: './tests',
  timeout: externalBaseURL ? 900_000 : 300_000,
  expect: { timeout: 20_000 },
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  fullyParallel: false,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  outputDir: './test-results',
  use: {
    baseURL: externalBaseURL ?? `http://127.0.0.1:${port}`,
    trace: 'retain-on-failure',
    viewport: { width: 1280, height: 800 },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: externalBaseURL
    ? undefined
    : {
        command:
          'npm run build -w @werewolf/web && node scripts/start-server.mjs',
        url: `http://127.0.0.1:${port}`,
        // The production build is what a hosted deployment serves — the e2e
        // suite must exercise the same bytes, not the dev server.
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
        stdout: 'pipe',
        stderr: 'pipe',
      },
});
