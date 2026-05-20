import { defineConfig } from 'vitest/config';

// jsdom because the editor builds real DOM elements (form inputs,
// section grids) and dispatches `input`/`change` events.
export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: false,
    include: ['tests/**/*.test.ts'],
  },
});
