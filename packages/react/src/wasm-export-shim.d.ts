// Ambient declaration for the OPTIONAL peer `@chordsketch/wasm-export`.
//
// The peer carries `peerDependenciesMeta.optional: true` in
// `package.json`: consumers who use `<PdfExport>` install it
// themselves; consumers who only use `<ChordSheet>` don't pay the
// heavy WebAssembly download. The module may therefore be unresolved
// at type-check time.
//
// Without this declaration the lazy-load call site would need a
// suppression directive (#2539). Either choice misfires under one of
// the two consumer resolution states: `@ts-expect-error` becomes dead
// once the peer auto-resolves; `@ts-ignore` silently swallows every
// other diagnostic on the same line. Declaring the module here lets
// the call site stay directive-free and subject to all future TS
// checks. The narrow `Promise<PdfRenderer>` cast at the call site
// (see `use-pdf-export.ts`) keeps the surface contract explicit.
//
// Body-less form yields `any`; the real `.d.ts` shipped by the
// optional peer supersedes it when installed.
declare module '@chordsketch/wasm-export';
