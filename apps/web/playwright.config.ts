/**
 * Playwright e2e (#536). Runs against the static production build served by
 * `tools/serve-dist.mjs`, with the API answered by contract-shaped fixtures
 * (e2e/builder-api-fixtures.ts) — no Functions host or database needed.
 *
 *   npm run build --workspace=@feasly/web -- --configuration=production
 *   npm run e2e --workspace=@feasly/web
 *
 * Env:
 *   PLAYWRIGHT_BASE_URL   test an already-running site (e.g. an SWA preview)
 *                         instead of starting the local dist server.
 *   PLAYWRIGHT_CHANNEL    use an installed browser (e.g. `chrome`) where
 *                         Playwright's bundled Chromium is unavailable.
 *   E2E_SCREENSHOTS=1     write 1440 / 390 full-page screenshots to
 *                         e2e-results/screenshots/ (for PR evidence).
 */
import { defineConfig } from '@playwright/test';

const port = 4280;
const externalBaseUrl = process.env['PLAYWRIGHT_BASE_URL'];
const channel = process.env['PLAYWRIGHT_CHANNEL'];

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.e2e.ts',
  outputDir: './e2e-results/artifacts',
  fullyParallel: true,
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 2 : 0,
  reporter: process.env['CI'] ? [['list'], ['html', { open: 'never', outputFolder: 'e2e-results/report' }]] : 'list',
  use: {
    baseURL: externalBaseUrl ?? `http://localhost:${port}`,
    trace: 'on-first-retry',
    ...(channel ? { channel } : {}),
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  ...(externalBaseUrl
    ? {}
    : {
        webServer: {
          command: `node tools/serve-dist.mjs --port ${port}`,
          url: `http://localhost:${port}/`,
          reuseExistingServer: !process.env['CI'],
          timeout: 30_000,
        },
      }),
});
