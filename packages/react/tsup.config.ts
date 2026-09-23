import { defineConfig } from 'tsup';

// Build config for the @chordsketch/react package.
//
// Produces ESM + CJS outputs under `./dist/`, both with type
// declarations and neither bundling `react` / `react-dom` / the
// `@chordsketch/wasm` runtime (peer / runtime deps are resolved by
// the consumer's bundler). The component CSS that upcoming
// component PRs (#2041–#2045) add lands at `dist/styles.css` via
// the package's `./styles.css` export.
//
// Two entry points: `index` is the main surface, `pdf` is the
// `./pdf` subpath that owns `<PdfExport>` / `usePdfExport` and their
// lazy `import('@chordsketch/wasm-export')`. Splitting them keeps
// that dynamic import out of `index`'s build graph entirely, so
// bundlers that resolve dynamic imports at build time (webpack,
// Turbopack) never need the heavy peer unless a consumer actually
// imports `./pdf`.
export default defineConfig({
  entry: { index: 'src/index.ts', pdf: 'src/pdf.ts' },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  splitting: false,
  external: ['react', 'react-dom', '@chordsketch/wasm'],
  outExtension({ format }) {
    return {
      js: format === 'esm' ? '.js' : '.cjs',
    };
  },
});
