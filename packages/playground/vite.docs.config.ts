// Docs-only Vite config — skips the wasm-backed chordpro / irealpro
// entries so the docs SSG can be exercised without a built
// `@chordsketch/wasm` artefact. Not consumed by
// `deploy-playground.yml`; the canonical CI build runs
// `vite.config.ts`. Wired into `npm run build:docs` / `npm run
// dev:docs` for local iteration on the docs route.

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  base: '/chordsketch/',
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        docs: resolve(here, 'docs/index.html'),
      },
    },
  },
  server: {
    fs: {
      allow: [here, resolve(here, '../../docs')],
    },
  },
});
