import { defineConfig } from 'tsup';

// Build config for the @chordsketch/react-ui package.
//
// Produces ESM + CJS outputs under `./dist/`, both with type
// declarations. `react` / `react-dom` are externalised (peer deps
// resolved by the consumer's bundler). There is deliberately NO
// `@chordsketch/wasm` external here: the primitives are pure
// class-composition over design-system tokens and carry no wasm
// dependency (ADR-0029). The component CSS lands at `dist/styles.css`
// via the package's `./styles.css` export.
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  splitting: false,
  external: ['react', 'react-dom'],
  outExtension({ format }) {
    return {
      js: format === 'esm' ? '.js' : '.cjs',
    };
  },
});
