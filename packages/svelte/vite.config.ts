import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';

// Vitest runs the components through the real Svelte compiler, so
// the tests exercise the same output a consumer's bundler produces.
// `resolve.conditions` adds the `browser` condition so
// `@testing-library/svelte` mounts against the client-side runtime
// rather than the SSR one.
export default defineConfig({
  plugins: [svelte()],
  resolve: {
    conditions: ['browser'],
  },
  test: {
    environment: 'jsdom',
    globals: false,
  },
});
