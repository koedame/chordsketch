// Narrow TypeScript interfaces mirroring the JSON shape produced by
// `@chordsketch/wasm`'s `parseIrealb` (and consumed by `serializeIrealb`).
// The Rust source of truth lives in `crates/ireal/src/ast.rs` and the
// JSON encoder in `crates/ireal/src/json.rs`. Field order and naming
// here MUST match the encoder output verbatim — `serializeIrealb` is
// strict about field shape.
//
// The AST follows a stability promise: new optional fields may appear
// in minor releases of `@chordsketch/wasm`; renames or removals
// require a major bump. Keeping these interfaces narrow (rather than
// re-exporting from the wasm package) avoids dragging the wasm
// glue into this package's type graph.

/** Diatonic accidental on a chord root. */
export type Accidental = 'natural' | 'flat' | 'sharp';

/** Mode of a key signature. */
export type KeyMode = 'major' | 'minor';

/** Barline shape at a bar boundary. */
export type BarLine = 'single' | 'double' | 'final' | 'open_repeat' | 'close_repeat';

/** Repeat / navigation symbol attached to a bar. */
export type MusicalSymbol = 'segno' | 'coda' | 'da_capo' | 'dal_segno' | 'fine';

/** Root or bass note. `note` is an uppercase ASCII letter `A`–`G`. */
export interface ChordRoot {
  note: string;
  accidental: Accidental;
}

/** Chord quality. `Custom` carries the post-root token verbatim
 * (e.g. `"7♯9"`). Mirrors the Rust `ChordQuality` enum tagged JSON. */
export type ChordQuality =
  | { kind: 'major' }
  | { kind: 'minor' }
  | { kind: 'diminished' }
  | { kind: 'augmented' }
  | { kind: 'major7' }
  | { kind: 'minor7' }
  | { kind: 'dominant7' }
  | { kind: 'half_diminished' }
  | { kind: 'diminished7' }
  | { kind: 'suspended2' }
  | { kind: 'suspended4' }
  | { kind: 'custom'; value: string };

/** A chord: root + quality + optional slash-bass. */
export interface Chord {
  root: ChordRoot;
  quality: ChordQuality;
  bass: ChordRoot | null;
}

/** Position inside a bar: 1-indexed beat + 2^subdivision sub-beat. */
export interface BeatPosition {
  beat: number;
  subdivision: number;
}

/** A chord placed at a beat inside a bar. */
export interface BarChord {
  chord: Chord;
  position: BeatPosition;
}

/** One measure inside a section. `ending` is the N-th-ending number
 * (1, 2, 3, …) or `null`; `symbol` is `null` if no glyph attaches. */
export interface Bar {
  start: BarLine;
  end: BarLine;
  chords: BarChord[];
  ending: number | null;
  symbol: MusicalSymbol | null;
}

/** Section label. The named variants (`verse`, `chorus`, …) carry no
 * payload; `letter` carries the single-letter label and `custom`
 * carries an arbitrary string. */
export type SectionLabel =
  | { kind: 'letter'; value: string }
  | { kind: 'verse' }
  | { kind: 'chorus' }
  | { kind: 'intro' }
  | { kind: 'outro' }
  | { kind: 'bridge' }
  | { kind: 'custom'; value: string };

/** A labelled block of bars. */
export interface Section {
  label: SectionLabel;
  bars: Bar[];
}

/** Concert-pitch key signature. */
export interface KeySignature {
  root: ChordRoot;
  mode: KeyMode;
}

/** Time signature. `numerator` is in `1..=12`; `denominator` is one of
 * 2 / 4 / 8. */
export interface TimeSignature {
  numerator: number;
  denominator: number;
}

/** A single iReal Pro chart. Mirrors the Rust `IrealSong` struct
 * field-for-field. `key_signature` / `time_signature` are
 * snake_cased to match the wasm JSON output verbatim. */
export interface IrealSong {
  title: string;
  composer: string | null;
  style: string | null;
  key_signature: KeySignature;
  time_signature: TimeSignature;
  tempo: number | null;
  transpose: number;
  sections: Section[];
}
