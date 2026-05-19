// @chordsketch/react — React component library for ChordPro rendering
// backed by @chordsketch/wasm.

import packageJson from '../package.json' with { type: 'json' };

export { ChordDiagram, type ChordDiagramProps } from './chord-diagram';
export {
  useChordDiagram,
  type ChordDiagramInstrument,
  type ChordDiagramResult,
} from './use-chord-diagram';
export { ChordEditor, type ChordEditorProps } from './chord-editor';
export { ChordSheet, type ChordSheetProps } from './chord-sheet';
export {
  useChordRender,
  type ChordRenderFormat,
  type ChordRenderOptions,
  type ChordRenderResult,
} from './use-chord-render';
export { PdfExport, type PdfExportProps } from './pdf-export';
export {
  usePdfExport,
  type PdfExportOptions,
  type UsePdfExportResult,
} from './use-pdf-export';
export { Transpose, type TransposeProps } from './transpose';
export {
  useTranspose,
  type UseTransposeOptions,
  type UseTransposeResult,
} from './use-transpose';
export { useDebounced } from './use-debounced';

// AST → JSX walker (#2475 / ADR-0017). Powers `<ChordSheet>`'s
// `format="html"` branch — exposed at the package boundary so
// custom consumers can drive their own React tree off the same
// AST without the `<ChordSheet>` shell.
export { renderChordproAst } from './chordpro-jsx';
export {
  useChordproAst,
  type ChordproAstResult,
  type ChordproParseOptions,
} from './use-chordpro-ast';
export type {
  ChordproAccidental,
  ChordproChord,
  ChordproChordDefinition,
  ChordproChordDetail,
  ChordproChordQuality,
  ChordproCommentStyle,
  ChordproDirective,
  ChordproDirectiveKind,
  ChordproImageAttributes,
  ChordproLine,
  ChordproLyricsLine,
  ChordproLyricsSegment,
  ChordproMetadata,
  ChordproNote,
  ChordproSong,
  ChordproSpanAttributes,
  ChordproTextSpan,
} from './chordpro-ast';

// Editor + layout primitives (#2454). The CodeMirror-backed
// `<SourceEditor>` is heavier than the existing `<ChordEditor>`
// (textarea) and adds its own dependency tree under
// `@codemirror/*`; tree-shaking drops it from bundles that do not
// import it.
export { SourceEditor, type SourceEditorHandle, type SourceEditorProps } from './source-editor';
export { chordProLanguage, chordProTagTable } from './chordpro-language';
export { SplitLayout, type SplitLayoutProps } from './split-layout';
export {
  RendererPreview,
  type PreviewFormat,
  type RendererPreviewProps,
} from './renderer-preview';
export { Playground, type PlaygroundProps } from './playground';

// Drag-to-reposition chord helpers. `<ChordSheet>` /
// `renderChordproAst`'s `onChordReposition` callback emits
// `ChordRepositionEvent` values; consumers feed them through
// `applyChordReposition` together with the current ChordPro
// source to compute the updated source text.
export {
  applyChordReposition,
  lyricsOffsetToSourceColumn,
  type ChordRepositionEvent,
  type ChordRepositionResult,
} from './chord-source-edit';

// iReal Pro surface (#2473 / #2505 / ADR-0020). Mirrors the
// ChordPro surface in shape: editor + preview + playground
// component plus parse / serialise hooks. v0.2.0 reaches parity
// with `@chordsketch/ui-irealb-editor`: interactive bar grid
// (ARIA `role="grid"` + roving tabindex + keyboard navigation),
// structural editing (section / bar add / rename / delete /
// move), and popover-based per-bar chord editing via
// `<IrealBarPopover>` (focus trap, chord-row editor, N-th
// ending input, symbol picker).
export { IrealEditor, type IrealEditorProps } from './ireal-editor';
export { IrealPreview, type IrealPreviewProps } from './ireal-preview';
export { IrealPlayground, type IrealPlaygroundProps } from './ireal-playground';
export {
  useIrealParse,
  type UseIrealParseResult,
} from './use-ireal-parse';
export {
  useIrealSerialize,
  type UseIrealSerializeResult,
} from './use-ireal-serialize';
export {
  useIrealRender,
  type UseIrealRenderResult,
} from './use-ireal-render';
export {
  irealChordRootToString,
  irealChordQualityToString,
  irealChordToString,
  irealSectionLabelToString,
  irealCanonicalSymbolText,
  irealIsDaCapo,
  irealIsDalSegno,
} from './ireal-ast';
export type {
  IrealAccidental,
  IrealBar,
  IrealBarChord,
  IrealBarChordKind,
  IrealBarLine,
  IrealBeatPosition,
  IrealChord,
  IrealChordQuality,
  IrealChordRoot,
  IrealChordSize,
  IrealKeyMode,
  IrealKeySignature,
  IrealMusicalSymbol,
  IrealSection,
  IrealSectionLabel,
  IrealSong,
  IrealTimeSignature,
} from './ireal-ast';

/**
 * The running version of `@chordsketch/react`. Returns the string
 * declared in this package's `package.json` so consumers can verify
 * at runtime which release they are executing against.
 */
export function version(): string {
  return packageJson.version;
}
