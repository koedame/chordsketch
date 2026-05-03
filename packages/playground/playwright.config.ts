// Playwright config for the playground browser smoke suite added in
// #2397. The suite verifies that `mountChordSketchUi` actually wires
// every editor adapter the playground exposes — pre-existing unit
// tests covered each layer in isolation but missed the host-level
// integration where the iRealb factory raced wasm initialisation.
//
// The suite intentionally targets the production build (`vite preview`
// over `vite build` output) rather than the dev server. The deployed
// playground is what users hit; matching that is what catches the
// real regression class. The dev-only `fs.allow` fix that ships
// alongside this suite is not exercised by Playwright because the
// preview server does not consult `fs.allow`.

import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.PLAYWRIGHT_PLAYGROUND_PORT ?? 4173);
const HOST = '127.0.0.1';
const isCI = process.env.CI === 'true';

export default defineConfig({
  testDir: './tests-e2e',
  // The playground is a single-page app; tests are I/O bound on
  // wasm fetch. Keeping the worker count low keeps the CI runner
  // memory ceiling well below the GitHub-hosted 7 GB.
  workers: isCI ? 1 : 2,
  fullyParallel: true,
  retries: isCI ? 1 : 0,
  reporter: isCI ? [['list'], ['github']] : [['list']],
  use: {
    baseURL: `http://${HOST}:${PORT}/chordsketch/`,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    // The playground's wasm bootstrap fetches the .wasm via the
    // page origin. A short navigation timeout makes a flaked CDN
    // fetch fail fast rather than burn the whole job's budget.
    navigationTimeout: 30_000,
    actionTimeout: 10_000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    // `vite preview` serves the same static dist that
    // `actions/upload-pages-artifact` ships in deploy-playground.yml,
    // so a green run here proves the deployed bundle would mount
    // identically.
    command: `npx vite preview --port ${PORT} --host ${HOST} --strictPort`,
    url: `http://${HOST}:${PORT}/chordsketch/`,
    timeout: 60_000,
    reuseExistingServer: !isCI,
  },
});
