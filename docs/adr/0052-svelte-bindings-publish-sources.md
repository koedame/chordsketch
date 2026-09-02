# 0052. The Svelte bindings publish sources, not a bundle

- **Status**: Accepted
- **Date**: 2026-09-03

## Context

`@chordsketch/react` and `@chordsketch/vue` are built with `tsup`: each
emits a bundled `dist/index.js` (ESM) and `dist/index.cjs` (CJS) with
`dist/index.d.ts` / `dist/index.d.cts` beside them, and its `exports` map
routes `import` and `require` to the matching half.

`@chordsketch/svelte` (#2829) does not. Its build is
`svelte-package --input src --output dist`, and what lands in `dist/` is
one `.svelte` file per component — the component source, not a compiled
artefact — plus a generated `.d.ts` for each, the `.svelte.js` rune
modules behind the `use*` helpers, and `styles.css`. There is no CJS
half; the entry is resolved through the `svelte` export condition, with
`default` pointing at the same ESM file.

That makes one package in this repository build and publish differently
from its two siblings, for a reason that is not visible from the
`package.json` diff. "Fold the odd one back into the shared tsup
convention" is exactly the kind of consistency argument a future
contributor would reach for, so the reason it cannot work needs to be
durable rather than living in a commit message.

The constraint is that a `.svelte` file is not JavaScript any runtime
executes, and neither is a `.svelte.js` module: both need the Svelte
compiler, which lives in the *consuming* application's build (Vite's
`@sveltejs/vite-plugin-svelte`, or SvelteKit on top of it). Svelte's
package tooling is built around that fact — `svelte-package` exists to
produce a distributable source tree, and the `svelte` export condition
exists so that a consumer's toolchain resolves the uncompiled entry
rather than a pre-compiled one.

## Decision

`@chordsketch/svelte` publishes **preprocessed `.svelte` sources plus
generated `.d.ts` files**, produced by `svelte-package`. It is not
bundled: no `tsup`, no CJS output, no pre-compiled component JavaScript.
Consumers resolve it through the `svelte` (and `default`) export
conditions and compile the components with their own Svelte compiler.

Preprocessing is limited to `vitePreprocess({ script: true })`, which
strips TypeScript from `<script lang="ts">` blocks and leaves markup,
runes, and the `lang="ts"` attribute itself untouched. Nothing else is
transformed.

`@chordsketch/react` and `@chordsketch/vue` keep their `tsup` dual
ESM + CJS builds. The divergence is deliberate and confined to the
build-and-publish layer: prop names, defaults, DOM shape, and class
vocabulary stay aligned across the three packages.

## Rationale

- **Compiling is the host's job, and only the host can do it correctly.**
  A Svelte component is compiled differently for SSR and for the client,
  for development and for production, and by whichever compiler version
  the application pins. Shipping one pre-compiled output picks one point
  in that space for every consumer and freezes the compiler version into
  our published artefact. Shipping the source lets each application's own
  compiler make those choices, which is what every Svelte library does.
- **A CJS half would have no consumer.** `require()`-ing a Svelte
  component is not a path anyone takes: the compiler, the Vite plugin,
  and SvelteKit are ESM, and the component still has to pass through the
  compiler before it is loadable at all. Producing a CJS build would mean
  pre-compiling first — inheriting the problem above — to serve a caller
  that does not exist.
- **`svelte-package` produces the layout consumer tooling expects.** It
  is the ecosystem's own packaging tool: the `svelte` export condition,
  the per-component `.d.ts` generated from the source, and the
  `.svelte.js` rune modules kept as modules are all what an IDE's Svelte
  language service and a bundler's Svelte plugin look for. Hand-rolling
  an equivalent buys nothing.
- **Preprocessing to plain JS keeps the published surface independent of
  TypeScript.** `vitePreprocess({ script: true })` is not the default,
  because in an *application* build Vite compiles `<script lang="ts">`
  itself and the preprocessor is only asked for styles. Without it,
  `svelte-package` copies the TypeScript through verbatim. Such a package
  still compiles today — Svelte 5's compiler strips plain type
  annotations — but it makes every consumer's toolchain re-strip types,
  and any TS construct the compiler does not handle natively would break
  it. Emitting plain JS removes that dependency.
- **The `.d.ts` files carry the types instead.** Nothing is lost by
  stripping TypeScript from the shipped components: `svelte-package`
  generates the declarations from the same sources, so editor
  completion and `svelte-check` in a consuming app see the full API.

## Consequences

- Consumers need a Svelte-aware build (vite-plugin-svelte, SvelteKit, or
  equivalent). There is no `require()` path, no plain `<script>` / CDN
  drop-in, and no way to use the package from a toolchain with no Svelte
  compiler. This is the normal contract for a Svelte library and matches
  what the package README states.
- **The `script: true` preprocessing would degrade silently if it stopped
  applying** — the package would still build and still compile in
  consumers, only with TypeScript in the published components.
  `.github/workflows/svelte.yml` therefore inspects the built `dist/`
  and fails when a `dist/*.svelte` file still contains `interface Props`.
  The `lang="ts"` attribute cannot be the signal: `svelte-package` keeps
  it on purpose for Svelte 5, so its presence says nothing about whether
  the script was preprocessed.
- **Dev-only code cannot be gated on `process.env.NODE_ENV`.** The React
  and Vue packages can use that idiom because the consumer's bundler
  substitutes the value while bundling their pre-built output; an
  unbundled package has no such guarantee that `process` exists.
  `@chordsketch/svelte` depends on `esm-env` and reads `DEV`, which is
  resolved through export conditions instead — this is why the package
  carries a runtime dependency its siblings do not.
- The repository now has two publishing shapes for JavaScript packages,
  so anything that reasons about npm package layout in bulk has to handle
  both. Publishing itself is unaffected: it stays a maintainer-local
  manual `npm publish` per [ADR-0008](0008-npm-publishing-is-local.md),
  the same as every other ChordSketch npm package.
- Typechecking runs through `svelte-check` rather than `tsc --noEmit`,
  because the sources being checked are components rather than TypeScript
  modules.

## Alternatives considered

- **Bundle with `tsup` to ESM + CJS, like `@chordsketch/react` and
  `@chordsketch/vue`.** Rejected. `tsup` cannot read `.svelte` at all
  without a Svelte plugin, and adding one means pre-compiling the
  components: the output would be pinned to one compiler version and to
  one of the SSR / client and dev / production variants a host chooses
  per build. The CJS half this buys is unreachable for Svelte consumers.
  Consistency with the sibling packages is real but sits at the layer
  where the frameworks genuinely differ.
- **Pre-compile the components ourselves (`svelte/compiler`) and publish
  the resulting JavaScript.** Rejected for the same version-freezing and
  variant-freezing reasons as bundling, with the added cost of
  hand-rolling an output layout that `svelte-package` deliberately does
  not produce.
- **Run `svelte-package` with no preprocessing, publishing the raw
  TypeScript sources.** Rejected. It works only for as long as the
  Svelte compiler's built-in annotation stripping covers everything the
  sources use, it makes every consumer's toolchain re-strip types, and
  the failure mode when it stops working lands in consumer builds rather
  than in ours.

## References

- #2829 — the PR that added `@chordsketch/svelte`; #2047 — the issue it
  closed
- [ADR-0008](0008-npm-publishing-is-local.md) — npm publishing stays a
  maintainer-local manual operation, unchanged by this decision
- `packages/svelte/svelte.config.js` — the `vitePreprocess({ script: true })`
  configuration and its inline explanation
- `packages/svelte/package.json` — the `svelte` export condition and the
  `svelte-package` build script
- `.github/workflows/svelte.yml` — the `dist/` verification that guards
  the preprocessing step
- Watch signal: revisit if Svelte gains a stable compiled-library
  distribution format, or if a target consumer toolchain without a Svelte
  compiler appears.
- `docs/adr/README.md` — ADR index
