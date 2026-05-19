// Docs-only Playwright config used for end-to-end tests that don't
// depend on the wasm-backed chordpro / irealpro entries. Pairs with
// `vite.docs.config.ts` + `scripts/build-docs-static.mjs`.
//
// The canonical `playwright.config.ts` remains the single source of
// truth for CI; this sibling exists so the docs suite can be
// exercised locally without a built `@chordsketch/wasm`.

import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.PLAYWRIGHT_DOCS_PORT ?? 4174);
const HOST = '127.0.0.1';

export default defineConfig({
  testDir: './tests-e2e',
  testMatch: /docs(?:-links)?\.spec\.ts$/,
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: `http://${HOST}:${PORT}/chordsketch/`,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    navigationTimeout: 30_000,
    actionTimeout: 10_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `npx vite preview --config vite.docs.config.ts --port ${PORT} --host ${HOST} --strictPort`,
    url: `http://${HOST}:${PORT}/chordsketch/docs/`,
    timeout: 60_000,
    reuseExistingServer: false,
  },
});
