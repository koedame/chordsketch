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
    rollupOptions: {
      input: {
        // Multi-page setup so the deployed site has dedicated routes
        // per format. Each entry HTML imports its own React entry
        // module under `src/<route>/main.tsx` and shares the chrome
        // styles in `src/playground.css`.
        landing: resolve(here, 'index.html'),
        chordpro: resolve(here, 'chordpro/index.html'),
        irealpro: resolve(here, 'irealpro/index.html'),
        // /docs/ co-located per ADR-0021. CSS-only entry: the
        // deployed HTML is emitted by
        // `scripts/build-docs-static.mjs` after this build runs;
        // Vite owns only `docs.css` so the asset participates in
        // the production bundle and gets content-hashed.
        docs: resolve(here, 'docs/index.html'),
      },
    },
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
      // Heavy companion to `@chordsketch/wasm`: ships PDF / PNG
      // renderer surface (#2466). Aliased to the local
      // `packages/npm-export/` build so the playground can drive
      // `<PdfExport>` without depending on an npm-published copy.
      // The PDF / PNG bundle is only loaded when a user actually
      // clicks "Export PDF" — the dynamic `import('@chordsketch/
      // wasm-export')` inside `use-pdf-export.ts` produces a
      // separate chunk so the initial playground load stays light.
      '@chordsketch/wasm-export': resolve(here, '../npm-export/web/chordsketch_wasm.js'),
      // React component library (#2454). Same alias pattern as the
      // wasm package — Vite consumes the TS sources directly. Longer
      // specifier (`/styles.css`) is listed before the bare package
      // alias so Vite resolves it correctly.
      '@chordsketch/react/styles.css': resolve(here, '../react/src/styles.css'),
      '@chordsketch/react': resolve(here, '../react/src/index.ts'),
      // iReal Pro bar-grid editor — used by the /irealpro/ route as
      // the source pane's editor adapter. Longer specifier first
      // (Vite alias resolution is first-match).
      '@chordsketch/ui-irealb-editor/style.css': resolve(
        here,
        '../ui-irealb-editor/src/style.css',
      ),
      '@chordsketch/ui-irealb-editor': resolve(
        here,
        '../ui-irealb-editor/src/index.ts',
      ),
    },
  },
  server: {
    fs: {
      // The playground root must be listed explicitly. Vite would
      // implicitly include the project root, but supplying any
      // `fs.allow` entry overrides that default — without `here`
      // the dev server returns 403 for `index.html` itself when
      // started via `npx vite` from this directory. Caught while
      // reproducing #2397.
      allow: [
        here,
        resolve(here, '../npm'),
        resolve(here, '../npm-export'),
        resolve(here, '../react'),
        resolve(here, '../ui-irealb-editor'),
      ],
    },
  },
});
