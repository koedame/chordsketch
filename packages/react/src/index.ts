// @chordsketch/react — React component library for ChordPro rendering
// backed by @chordsketch/wasm.
//
// Components land incrementally. Remaining surface:
//   - #2045: <ChordDiagram>

import packageJson from '../package.json' with { type: 'json' };

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

/**
 * The running version of `@chordsketch/react`. Returns the string
 * declared in this package's `package.json` so consumers can verify
 * at runtime which release they are executing against.
 */
export function version(): string {
  return packageJson.version;
}
