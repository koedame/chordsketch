import { defineConfig } from 'vitest/config';

// jsdom is required because `mountChordSketchUi` builds the editor +
// preview panes by creating real DOM elements and dispatching DOM
// events. Mirrors the configuration shipped by `@chordsketch/react`.
export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: false,
    include: ['tests/**/*.test.ts'],
  },
});
