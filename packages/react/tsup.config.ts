import { defineConfig } from 'tsup';

// Build config for the @chordsketch/react package.
//
// Produces ESM + CJS outputs under `./dist/`, both with type
// declarations and neither bundling `react` / `react-dom` / the
// `@chordsketch/wasm` runtime (peer / runtime deps are resolved by
// the consumer's bundler). The component CSS that upcoming
// component PRs (#2041–#2045) add lands at `dist/styles.css` via
// the package's `./styles.css` export.
export default defineConfig({
  entry: ['src/index.ts'],
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
