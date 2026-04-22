import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  base: '/chordsketch/',
  build: {
    outDir: 'dist',
  },
  resolve: {
    alias: {
      // Decouple the playground source from the npm package's internal
      // layout. The deep relative path `../../npm/web/chordsketch_wasm.js`
      // had to move whenever the npm package's directory structure
      // changed (#1026 dual-package layout broke deploy-playground.yml
      // before #1061 was filed). Importing under the published name lets
      // future layout changes only touch the alias here. See #1057.
      '@chordsketch/wasm': resolve(here, '../npm/web/chordsketch_wasm.js'),
      // Shared editor + preview UI extracted in #2073. Same alias
      // pattern as the wasm package: ui-web is a sibling workspace
      // package that ships only TypeScript sources, so Vite consumes
      // it directly via the `./src/index.ts` main + `./src/style.css`
      // export. Match-longer-first ordering: the more specific
      // `/style.css` alias must be listed before the bare package
      // alias so Vite resolves it correctly.
      '@chordsketch/ui-web/style.css': resolve(here, '../ui-web/src/style.css'),
      '@chordsketch/ui-web': resolve(here, '../ui-web/src/index.ts'),
    },
  },
  server: {
    fs: {
      allow: ['../npm', '../ui-web'],
    },
  },
});
