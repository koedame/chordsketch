// Ambient declaration for the OPTIONAL peer `@chordsketch/wasm-export`.
//
// The peer carries `peerDependenciesMeta.optional: true` in
// `package.json`: consumers who use `<PdfExport>` install it
// themselves; consumers who only use `<ChordSheet>` don't pay the
// heavy WebAssembly download. The module may therefore be unresolved
// at type-check time, which is what this declaration covers — see the
// sibling `wasm-shim.d.ts` for the same reasoning applied to the
// non-optional `@chordsketch/wasm` dependency.
declare module '@chordsketch/wasm-export';
