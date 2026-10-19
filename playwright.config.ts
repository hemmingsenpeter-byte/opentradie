import { existsSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';

/**
 * Essential-journey e2e tests run against the real API, real PostgreSQL and the mock agent.
 *
 * Prerequisites: `pnpm setup:dev` (writes .env, migrates and seeds the synthetic demo tenant).
 * Then `pnpm test:e2e` starts `pnpm dev` (API on :3000, web on :5173) unless E2E_BASE_URL points
 * at an already running stack. Credentials come from .env: OWNER_EMAIL/OWNER_PASSWORD and
 * VIEWER_EMAIL/VIEWER_PASSWORD. The base URL must equal the API's APP_ORIGIN, because the API
 * rejects mutations from any other Origin.
 */
if (existsSync('.env')) process.loadEnvFile('.env');

const baseURL = process.env.E2E_BASE_URL ?? process.env.APP_ORIGIN ?? 'http://localhost:5173';

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  // E2E_BROWSER_CHANNEL=chrome uses an installed Google Chrome (needed on macOS 12, which
  // Playwright's bundled Chromium no longer supports).
  projects: [
    {
      name: 'iphone-chromium',
      use: {
        ...devices['iPhone 13'],
        defaultBrowserType: 'chromium',
        ...(process.env.E2E_BROWSER_CHANNEL ? { channel: process.env.E2E_BROWSER_CHANNEL } : {}),
      },
    },
  ],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: process.env.E2E_WEB_COMMAND ?? 'pnpm dev',
        url: baseURL,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
        stdout: 'pipe',
        stderr: 'pipe',
      },
});
