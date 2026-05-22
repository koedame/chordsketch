// Ambient declaration for `@chordsketch/wasm`.
//
// The package exposes its public surface through wasm-pack-generated
// declaration files. Those files are build artefacts and do not exist
// in a fresh source checkout, so a consumer whose resolution state for
// the peer is "absent" cannot type-check any of the dynamic
// `import('@chordsketch/wasm')` sites in `src/` (#2540).
//
// Declaring the module here lets resolution succeed without any
// suppression directive at the call sites. The shorthand form (no
// body) yields `any`; the real wasm-pack declarations supersede this
// ambient when present in the consumer's `node_modules` or in any
// equivalent workspace path.
//
// Sibling: the optional `@chordsketch/wasm-export` peer carries an
// analogous ambient shim (#2539).
declare module '@chordsketch/wasm';
