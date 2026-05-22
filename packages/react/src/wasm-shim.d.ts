// Ambient declaration for `@chordsketch/wasm`.
//
// `@chordsketch/wasm` exposes its public surface through wasm-pack-
// generated declaration files at `web/chordsketch_wasm.d.ts` and
// `node/chordsketch_wasm.d.ts`. Those files are build artefacts: a
// fresh source checkout does not have them until `wasm-pack build`
// runs against the `chordsketch-wasm` crate. Workspace consumers
// (pnpm workspace, git submodule, workspace protocol) therefore
// see a missing-types diagnostic at `pnpm install` time because
// `@chordsketch/react`'s `prepare` script runs the DTS build before
// the wasm-pack artefacts can be produced — the build that would
// produce them is itself downstream of the failing install (#2540).
//
// Declaring the module here lets resolution succeed without any
// suppression directive at the seven dynamic-import sites in `src/`.
// The shorthand form (no body) yields `any`; the real `.d.ts` shipped
// by wasm-pack supersedes it when present in the consumer's
// `node_modules`. Each call site casts to its own narrow interface
// (`ChordRenderer`, `IrealParser`, etc.), so the per-site surface
// contract remains explicit.
//
// Sibling: `wasm-export-shim.d.ts` applies the same pattern to the
// optional `@chordsketch/wasm-export` peer (#2539).
declare module '@chordsketch/wasm';
