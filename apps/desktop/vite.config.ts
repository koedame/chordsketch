import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));

// Mirrors `packages/playground/vite.config.ts`. The shared aliases pin
// `@chordsketch/wasm` to the dual-package npm build output and resolve
// `@chordsketch/ui-web` straight from TypeScript sources — no separate
// build step for ui-web, so edits in `packages/ui-web/src/` appear in
// the desktop WebView on the next reload.
export default defineConfig({
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
      // root by default. Opting in the two sibling workspace packages
      // (`packages/npm` for the wasm bundle, `packages/ui-web` for the
      // shared UI) lets the aliases below resolve.
      allow: [
        resolve(here, '../../packages/npm'),
        resolve(here, '../../packages/ui-web'),
      ],
    },
  },
  resolve: {
    alias: {
      // Match-longer-first ordering: the `/style.css` alias must be listed
      // before the bare `@chordsketch/ui-web` alias so Vite matches the
      // specific path first.
      '@chordsketch/ui-web/style.css': resolve(
        here,
        '../../packages/ui-web/src/style.css',
      ),
      '@chordsketch/ui-web': resolve(here, '../../packages/ui-web/src/index.ts'),
      '@chordsketch/wasm': resolve(
        here,
        '../../packages/npm/web/chordsketch_wasm.js',
      ),
    },
  },
});
