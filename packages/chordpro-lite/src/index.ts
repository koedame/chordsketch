// @chordsketch/chordpro-lite — dependency-free ChordPro text helpers.
//
// The ChordPro knowledge in this package is the part that is pure string
// work: which format a blob is in, which words in it are lyrics, and what
// its opening lines look like. None of it needs the parser, so none of it
// pulls the WebAssembly engine in — a server, an edge runtime, a build
// script or a CLI wrapper can answer those three questions with a plain
// dependency-free module and load `@chordsketch/wasm` (or
// `@chordsketch/node`) only once it has decided to actually parse.
//
// Everything beyond that — parsing, transposing, rendering, chord
// diagrams, iReal Pro charts — is the engine's job. This package
// deliberately does not reimplement any of it.
//
// The directive knowledge behind `detectFormat` is generated from the
// Rust directive catalog (`./bare-directives`), so it cannot drift from
// what the parser recognises.

import packageJson from '../package.json' with { type: 'json' };

export { type ChartFormat, detectFormat } from './detect-format';
export { extractLyrics } from './extract-lyrics';
export {
  extractPreview,
  type PreviewLine,
  type PreviewOptions,
} from './extract-preview';

/** The package version, read from `package.json`. */
export const version: string = packageJson.version;
