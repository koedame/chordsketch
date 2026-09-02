import { defineConfig } from 'tsup';

// Build config for the @chordsketch/vue package.
//
// Mirrors `packages/react/tsup.config.ts`: ESM + CJS outputs under
// `./dist/`, both with type declarations, with `vue` and the
// `@chordsketch/wasm` runtime left external so the consumer's
// bundler resolves them. The component CSS lands at
// `dist/styles.css` via the package's `./styles.css` export.
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  splitting: false,
  external: ['vue', '@chordsketch/wasm'],
  outExtension({ format }) {
    return {
      js: format === 'esm' ? '.js' : '.cjs',
    };
  },
});
