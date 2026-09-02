// Ambient declaration for `@chordsketch/wasm`.
//
// The package exposes its public surface through wasm-pack-generated
// declaration files. Those files are build artefacts and do not exist
// in a fresh source checkout, so a consumer whose resolution state for
// the dependency is "absent" cannot type-check any of the dynamic
// `import('@chordsketch/wasm')` sites in `src/`.
//
// Declaring the module here lets resolution succeed without any
// suppression directive at the call sites. The shorthand form (no
// body) yields `any`; the real wasm-pack declarations supersede this
// ambient when present in the consumer's `node_modules`. Every call
// site casts the import to its own narrow structural interface, so
// the contract with the wasm API stays explicit either way.
//
// Sibling: the optional `@chordsketch/wasm-export` peer carries an
// analogous ambient shim.
declare module '@chordsketch/wasm';
