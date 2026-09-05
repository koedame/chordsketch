import { defineConfig } from 'tsup';

// Build config for the @chordsketch/chordpro-lite package.
//
// Produces ESM + CJS outputs under `./dist/`, both with type
// declarations. There are no `external` entries because the package has
// no dependencies at all — in particular no `@chordsketch/wasm`, which
// is the point of the package (ADR-0060) and is asserted by
// `tests/no-wasm-dep.test.ts`.
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  splitting: false,
  outExtension({ format }) {
    return {
      js: format === 'esm' ? '.js' : '.cjs',
    };
  },
});
