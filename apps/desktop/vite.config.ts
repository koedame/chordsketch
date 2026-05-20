import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const here = dirname(fileURLToPath(import.meta.url));

// Mirrors `packages/playground/vite.config.ts`. The shared aliases pin
// `@chordsketch/wasm` to the dual-package npm build output and resolve
// `@chordsketch/react` / `@chordsketch/ui-irealb-editor` straight from
// TypeScript sources — no separate build step, so edits in their
// `src/` directories appear in the desktop WebView on the next reload.
export default defineConfig({
  plugins: [react()],
  // Tauri's dev-loop log stream interleaves with Vite's output; clearing
  // the screen on restart hides Rust compile errors mid-session.
  clearScreen: false,
  build: {
    outDir: 'dist',
    // The Tauri WebView on every supported OS is recent enough to run
    // native ES2020; no transpile step needed.
    target: 'esnext',
    emptyOutDir: true,
  },
  server: {
    // Must match `devUrl` in `src-tauri/tauri.conf.json`. `strictPort`
    // forces failure instead of silently falling through to 1421 if
    // another process already holds 1420 — Tauri would otherwise load
    // a blank WebView while Vite happily serves on a stale port.
    port: 1420,
    strictPort: true,
    fs: {
      // Vite's fs allowlist blocks imports that climb above the package
      // root by default. Opting in the sibling workspace packages
      // (`packages/npm` for the wasm bundle, `packages/react` for the
      // React component library, `packages/ui-irealb-editor` for the
      // bar-grid GUI editor) lets the aliases below resolve.
      allow: [
        resolve(here, '../../packages/npm'),
        resolve(here, '../../packages/npm-export'),
        resolve(here, '../../packages/react'),
        resolve(here, '../../packages/ui-irealb-editor'),
        // The desktop seed (SAMPLE_CHORDPRO) is imported from the
        // playground so the two surfaces share one source of truth;
        // see the `@chordsketch/playground-sample` alias below.
        resolve(here, '../../packages/playground'),
      ],
    },
  },
  resolve: {
    // `dedupe` collapses every `import 'react'` / `import 'react-dom'`
    // resolution to the workspace copy declared in `package.json` so
    // hooks survive the boundary between the desktop entry and
    // `@chordsketch/react`. Without this, Vite's dev server can
    // resolve a transitive `react` from `@codemirror/view`'s nested
    // node_modules and ship two React copies into the WebView — the
    // classic "Invalid hook call" symptom.
    dedupe: ['react', 'react-dom'],
    alias: {
      // Match-longer-first ordering: the `/styles.css` alias must be
      // listed before the bare package alias so Vite matches the
      // specific path first.
      '@chordsketch/react/styles.css': resolve(
        here,
        '../../packages/react/src/styles.css',
      ),
      '@chordsketch/react': resolve(
        here,
        '../../packages/react/src/index.ts',
      ),
      // iRealb bar-grid GUI editor (#2367). Same alias pattern.
      '@chordsketch/ui-irealb-editor/style.css': resolve(
        here,
        '../../packages/ui-irealb-editor/src/style.css',
      ),
      '@chordsketch/ui-irealb-editor': resolve(
        here,
        '../../packages/ui-irealb-editor/src/index.ts',
      ),
      // The desktop shell imports `render_pdf` / `render_pdf_with_options`
      // synchronously from the wasm bundle (the "Save as PDF" command
      // wires them up). The `@chordsketch/wasm` npm package was split
      // in #2466 — the lean variant no longer ships those exports;
      // they live in `@chordsketch/wasm-export`. For the desktop app
      // the size trade-off is reversed vs the playground (the bundle
      // is downloaded once at install time, not per session), so we
      // alias the bare `@chordsketch/wasm` import specifier directly
      // to the heavy build and keep the desktop source unchanged. If
      // the desktop later refactors PDF emission behind a lazy
      // boundary, drop this alias and import explicitly from
      // `@chordsketch/wasm-export` there.
      '@chordsketch/wasm': resolve(
        here,
        '../../packages/npm-export/web/chordsketch_wasm.js',
      ),
      // Share the `SAMPLE_CHORDPRO` seed with the browser playground
      // so the two hosts read from one source of truth — eliminates
      // the byte-for-byte duplicate that previously lived inline in
      // `apps/desktop/src/App.tsx`.
      '@chordsketch/playground-sample': resolve(
        here,
        '../../packages/playground/src/sample.ts',
      ),
    },
  },
});
