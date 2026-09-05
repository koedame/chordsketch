import { defineConfig } from 'vitest/config';

// The package touches no DOM API, so the tests run in plain Node —
// unlike the React packages there is no jsdom environment to set up.
export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
  },
});
