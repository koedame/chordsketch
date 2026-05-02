import { defineConfig } from 'vitest/config';

// jsdom because the editor builds real DOM elements (form inputs,
// section grids) and dispatches `input`/`change` events. Mirrors
// the configuration shipped by @chordsketch/ui-web.
export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: false,
    include: ['tests/**/*.test.ts'],
  },
});
