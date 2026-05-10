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

/**
 * The running version of `@chordsketch/react`. Returns the string
 * declared in this package's `package.json` so consumers can verify
 * at runtime which release they are executing against.
 */
export function version(): string {
  return packageJson.version;
}
