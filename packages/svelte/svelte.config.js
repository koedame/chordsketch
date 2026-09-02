import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

// Consumed by `svelte-package` (build), `svelte-check` (typecheck)
// and the editor tooling.
//
// `script: true` is required, and is NOT the default: during an app
// build Vite compiles `<script lang="ts">` itself, so the
// preprocessor only handles styles unless asked. Without it,
// `svelte-package` copies the TypeScript through verbatim. Svelte 5's
// own compiler strips plain type annotations, so such a package still
// compiles — the components would just ship types every consumer's
// toolchain has to re-strip, and any future TS construct the compiler
// does not handle natively would break them. Emitting plain JS keeps
// the published surface independent of that. `.d.ts` files are
// generated separately from the sources, so nothing is lost.
//
// The `dist/` check in `.github/workflows/svelte.yml` fails the build
// if this option silently stops applying.
export default {
  preprocess: vitePreprocess({ script: true }),
};
