// Narrow TypeScript interfaces mirroring the JSON shape produced by
// `@chordsketch/wasm`'s `parseIrealb` and consumed by `serializeIrealb`.
// The Rust source of truth lives in `crates/ireal/src/ast.rs` and the
// JSON encoder in `crates/ireal/src/json.rs`. Field order and naming
// here MUST match the encoder output verbatim — `serializeIrealb` is
// strict about field shape.
//
// Sister-site: `packages/ui-irealb-editor/src/ast.ts` carries the same
// shapes for the framework-agnostic editor used by the playground and
// the desktop app. The two declarations were carved out independently
// per [ADR-0020](../../../docs/adr/0020-ireal-pro-react-surface.md);
// they describe the same wasm output, so changes to one *shape* MUST
// land in the other in the same PR. The fix-propagation rule
// (`.claude/rules/fix-propagation.md`) applies here as it would to any
// renderer sister-site pair.
//
// **Helper-function divergence (intentional).** The two files share
// AST shapes but diverge in convenience helpers:
//   - This file exports stringifiers (`irealChordRootToString`,
//     `irealChordQualityToString`, `irealChordToString`,
//     `irealSectionLabelToString`) used by the read-only bar grid in
//     `<IrealEditor>`.
//   - `ui-irealb-editor/src/ast.ts` exports navigation-symbol
//     canonicalisers (`canonicalSymbolText`, `isDaCapo`,
//     `isDalSegno`) used by its popover-driven bar editor.
// Each surface adds the helpers it actually uses; adding a helper
// here that the other file already has (or vice versa) is a
// fix-propagation defect, but the current asymmetry is by design.

/** Diatonic accidental on a chord root. */
export type IrealAccidental = 'natural' | 'flat' | 'sharp';

/** Mode of a key signature. */
export type IrealKeyMode = 'major' | 'minor';

/** Barline shape at a bar boundary. */
export type IrealBarLine =
  | 'single'
  | 'double'
  | 'final'
  | 'open_repeat'
  | 'close_repeat';

/** Repeat / navigation symbol attached to a bar.
 *
 * Mirrors `MusicalSymbol` in `packages/ui-irealb-editor/src/ast.ts`
 * and `crates/ireal/src/ast.rs`. The D.C. / D.S. families branch into
 * a destination suffix (`_al_coda`, `_al_fine`, `_al_<n>th_end`). */
export type IrealMusicalSymbol =
  | 'segno'
  | 'coda'
  | 'fine'
  | 'fermata'
  | 'break'
  // D.C. family: bare + four destination shapes.
  | 'da_capo'
  | 'da_capo_al_coda'
  | 'da_capo_al_fine'
  | `da_capo_al_${number}st_end`
  | `da_capo_al_${number}nd_end`
  | `da_capo_al_${number}rd_end`
  | `da_capo_al_${number}th_end`
  // D.S. family: bare + four destination shapes.
  | 'dal_segno'
  | 'dal_segno_al_coda'
  | 'dal_segno_al_fine'
  | `dal_segno_al_${number}st_end`
  | `dal_segno_al_${number}nd_end`
  | `dal_segno_al_${number}rd_end`
  | `dal_segno_al_${number}th_end`;

/** Root or bass note. `note` is an uppercase ASCII letter `A`–`G`. */
export interface IrealChordRoot {
  note: string;
  accidental: IrealAccidental;
}

/** Chord quality. `custom` carries the post-root token verbatim
 * (e.g. `"7♯9"`). Mirrors the Rust `ChordQuality` tagged JSON. */
export type IrealChordQuality =
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
export interface IrealChord {
  root: IrealChordRoot;
  quality: IrealChordQuality;
  bass: IrealChordRoot | null;
}

/** Position inside a bar: 1-indexed beat + 2^subdivision sub-beat. */
export interface IrealBeatPosition {
  beat: number;
  subdivision: number;
}

/** Per-chord display size. Omitted by the JSON encoder when default. */
export type IrealChordSize = 'default' | 'small';

/** Per-chord paint kind. `'slash_repeat'` paints a single `/` glyph
 * in place of chord text (the iReal Pro pause-slash). */
export type IrealBarChordKind = 'played' | 'slash_repeat';

/** A chord placed at a beat inside a bar. */
export interface IrealBarChord {
  chord: IrealChord;
  position: IrealBeatPosition;
  size?: IrealChordSize;
  kind?: IrealBarChordKind;
}

/** One measure inside a section. `ending`: `null` = no bracket, `0`
 * = untitled `N0` bracket, `1..` = numbered. `symbol` is the optional
 * navigation glyph attached to the bar. */
export interface IrealBar {
  start: IrealBarLine;
  end: IrealBarLine;
  chords: IrealBarChord[];
  ending: number | null;
  symbol: IrealMusicalSymbol | null;
}

/** Section label. Named variants carry no payload; `letter` and
 * `custom` carry their text. */
export type IrealSectionLabel =
  | { kind: 'letter'; value: string }
  | { kind: 'verse' }
  | { kind: 'chorus' }
  | { kind: 'intro' }
  | { kind: 'outro' }
  | { kind: 'bridge' }
  | { kind: 'custom'; value: string };

/** A labelled block of bars. */
export interface IrealSection {
  label: IrealSectionLabel;
  bars: IrealBar[];
}

/** Concert-pitch key signature. */
export interface IrealKeySignature {
  root: IrealChordRoot;
  mode: IrealKeyMode;
}

/** Time signature. `numerator` is in `1..=12`; `denominator` is one
 * of 2 / 4 / 8. */
export interface IrealTimeSignature {
  numerator: number;
  denominator: number;
}

/** A single iReal Pro chart. Mirrors the Rust `IrealSong` struct
 * field-for-field; the `*_signature` fields use snake_case to match
 * the wasm JSON output verbatim. */
export interface IrealSong {
  title: string;
  composer: string | null;
  style: string | null;
  key_signature: IrealKeySignature;
  time_signature: IrealTimeSignature;
  tempo: number | null;
  transpose: number;
  sections: IrealSection[];
}

/** Render a section label as a single display string. Mirrors the
 * label cells in the playground iReal grid editor. */
export function irealSectionLabelToString(label: IrealSectionLabel): string {
  switch (label.kind) {
    case 'letter':
      return label.value;
    case 'custom':
      return label.value;
    case 'verse':
      return 'Verse';
    case 'chorus':
      return 'Chorus';
    case 'intro':
      return 'Intro';
    case 'outro':
      return 'Outro';
    case 'bridge':
      return 'Bridge';
  }
}

/** Render a chord root as its display string (no Unicode translation
 * — the SVG / typography layer does that). */
export function irealChordRootToString(root: IrealChordRoot): string {
  const acc = root.accidental === 'natural' ? '' : root.accidental === 'flat' ? 'b' : '#';
  return `${root.note}${acc}`;
}

/** Render a chord quality's post-root token. Mirrors the URL
 * shorthand used by iReal Pro; not Unicode-translated. */
export function irealChordQualityToString(quality: IrealChordQuality): string {
  switch (quality.kind) {
    case 'major':
      return '';
    case 'minor':
      return '-';
    case 'diminished':
      return 'o';
    case 'augmented':
      return '+';
    case 'major7':
      return '^7';
    case 'minor7':
      return '-7';
    case 'dominant7':
      return '7';
    case 'half_diminished':
      return 'h7';
    case 'diminished7':
      return 'o7';
    case 'suspended2':
      return 'sus2';
    case 'suspended4':
      return 'sus4';
    case 'custom':
      return quality.value;
  }
}

/** Render a full chord as its iReal Pro URL display string
 * (no Unicode translation). Includes optional slash-bass. */
export function irealChordToString(chord: IrealChord): string {
  const root = irealChordRootToString(chord.root);
  const qual = irealChordQualityToString(chord.quality);
  const bass = chord.bass === null ? '' : `/${irealChordRootToString(chord.bass)}`;
  return `${root}${qual}${bass}`;
}
