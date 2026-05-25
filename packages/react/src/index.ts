// @chordsketch/react — React component library for ChordPro rendering
// backed by @chordsketch/wasm.

import packageJson from '../package.json' with { type: 'json' };

export { ChordDiagram, type ChordDiagramProps } from './chord-diagram';
export {
  useChordDiagram,
  type ChordDiagramInstrument,
  type ChordDiagramResult,
} from './use-chord-diagram';
export { ChordTextarea, type ChordTextareaProps } from './chord-textarea';
export { ChordSheet, type ChordSheetProps } from './chord-sheet';
export {
  useChordRender,
  type ChordRenderFormat,
  type ChordRenderOptions,
  type ChordRenderResult,
} from './use-chord-render';
export {
  PdfExport,
  type PdfExportProps,
  PDF_EXPORT_DEFAULT_LABEL,
} from './pdf-export';
export {
  usePdfExport,
  type PdfExportOptions,
  type UsePdfExportResult,
} from './use-pdf-export';
export { Transpose, type TransposeProps } from './transpose';
export { Capo, type CapoProps } from './capo';
export {
  computeBestCapoPositions,
  BEST_CAPO_MAX,
  type BestCapoResult,
} from './best-capo';
export {
  PreviewToolbar,
  type PreviewToolbarProps,
} from './preview-toolbar';
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

// Editor + layout primitives (#2454 / #2527). The CodeMirror-backed
// `<ChordSourceArea>` is heavier than the dependency-free
// `<ChordTextarea>` (textarea-with-preview) and adds its own
// dependency tree under `@codemirror/*`; tree-shaking drops it
// from bundles that do not import it.
export {
  ChordSourceArea,
  type ChordSourceAreaHandle,
  type ChordSourceAreaProps,
} from './chord-source-area';
export { chordProLanguage, chordProTagTable } from './chordpro-language';
export { SplitLayout, type SplitLayoutProps } from './split-layout';
export {
  RendererPreview,
  type PreviewFormat,
  type RendererPreviewProps,
} from './renderer-preview';
export {
  ChordProPreview,
  type ChordProPreviewProps,
} from './chord-pro-preview';
export {
  ChordProEditor,
  type ChordProEditorProps,
} from './chord-pro-editor';

// Source-side edit helpers. The drag-to-reposition contract
// (`applyChordReposition` + `<ChordSheet>` / `renderChordproAst`'s
// `onChordReposition` callback) and the performance-toolbar capo
// contract (`readCapo` / `setCapoInSource`) both live in
// `chord-source-edit.ts`. External hosts that own the ChordPro
// document (VS Code extension, custom editor shells) can read
// + write the `{capo: N}` directive directly via the helpers
// when applying a `<Capo>` change through their own document
// edit pipeline.
export {
  CAPO_MAX,
  CAPO_MIN,
  TRANSPOSE_MAX,
  TRANSPOSE_MIN,
  applyChordReposition,
  lyricsOffsetToSourceColumn,
  readCapo,
  setCapoInSource,
  type ChordRepositionEvent,
  type ChordRepositionResult,
} from './chord-source-edit';

// iReal Pro surface (#2473 / #2505 / #2527 / ADR-0020). Mirrors the
// ChordPro surface in shape: Tier 1 atom (`<IrealBarGrid>`) +
// Tier 1 preview (`<IrealPreview>`) + Tier 3 composed editor
// (`<IrealProEditor>`), plus parse / serialise hooks.
export { IrealBarGrid, type IrealBarGridProps } from './ireal-bar-grid';
export { IrealPreview, type IrealPreviewProps } from './ireal-preview';
export {
  IrealProEditor,
  type IrealProEditorProps,
} from './ireal-pro-editor';
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
