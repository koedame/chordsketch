// Docs-only Vite config used by the SSG verification path. The
// production deploy uses `vite.config.ts` (which builds all four
// entries — landing / chordpro / irealpro / docs); this sibling
// config skips the wasm-backed siblings so the docs SSG can be
// exercised end-to-end on a workstation without a built
// `@chordsketch/wasm` artefact (the wasm build is expensive and is
// only required by the chordpro / irealpro entries).
//
// Not consumed by deploy-playground.yml or the production build —
// only by `scripts/build-docs-static.mjs` indirectly when developing
// or running the docs Playwright suite in isolation.

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
