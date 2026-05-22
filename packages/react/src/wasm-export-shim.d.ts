// Ambient declaration for the OPTIONAL peer `@chordsketch/wasm-export`.
//
// `@chordsketch/wasm-export` is declared in `package.json` as an
// optional peer dependency (`peerDependenciesMeta`): consumers who use
// `<PdfExport>` install it themselves; consumers who only use
// `<ChordSheet>` don't pay the heavy WebAssembly download. As a result
// the module may or may not be resolvable when this package is
// type-checked — `tsc` (and `tsup`'s DTS build, which the package's
// `prepare` hook runs on `pnpm install`) sees a `TS2307 Cannot find
// module` error in the unresolved case but a clean import in the
// resolved case.
//
// Suppressing the diagnostic with `@ts-expect-error` flips the failure
// mode in the resolved case to `TS2578 Unused '@ts-expect-error'
// directive` (#2539). Suppressing it with `@ts-ignore` silences not
// only the resolution error but every future diagnostic on the same
// line, including unrelated typos and cast mismatches.
//
// Declaring the module here makes resolution succeed in both states
// without any suppression directive at the call site. When the
// optional peer is installed alongside the consumer's build, that
// package's own `.d.ts` (shipped by wasm-pack) is the source of truth
// for the module's surface; this ambient declaration only takes over
// when the resolver finds nothing else. The structural
// `Promise<PdfRenderer>` cast at the lazy-load site (see
// `use-pdf-export.ts`) is what pins the subset this package actually
// touches — the ambient does not need to repeat that contract.
declare module '@chordsketch/wasm-export';
