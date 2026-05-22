// Ambient declaration for the OPTIONAL peer `@chordsketch/wasm-export`.
//
// The peer carries `peerDependenciesMeta.optional: true` in
// `package.json`: consumers who use `<PdfExport>` install it
// themselves; consumers who only use `<ChordSheet>` don't pay the
// heavy WebAssembly download. The module may therefore be unresolved
// at type-check time.
//
// Without this declaration the call site in `use-pdf-export.ts` would
// need a suppression directive (#2539). Either choice misfires under
// one of the two consumer states: `@ts-expect-error` becomes dead
// once the peer auto-resolves; `@ts-ignore` silently swallows every
// other diagnostic on the same line. Declaring the module here lets
// the call site stay directive-free and subject to all future TS
// checks.
//
// The shorthand form (no body) yields `any`, so the real `.d.ts`
// shipped by the optional peer — when installed in the consumer's
// `node_modules` — supersedes this ambient without merge conflict.
// The narrow `Promise<PdfRenderer>` cast at the lazy-load site pins
// the subset `exportPdf` actually touches.
declare module '@chordsketch/wasm-export';
