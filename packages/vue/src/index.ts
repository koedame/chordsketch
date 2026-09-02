// @chordsketch/vue — Vue 3 component library for ChordPro rendering
// backed by @chordsketch/wasm.

import packageJson from '../package.json' with { type: 'json' };

export { ChordSheet } from './chord-sheet';
export { ChordTextarea } from './chord-textarea';
export { ChordDiagram } from './chord-diagram';
export {
  Transpose,
  TRANSPOSE_DEFAULT_MAX,
  TRANSPOSE_DEFAULT_MIN,
} from './transpose';
export { PdfExport, PDF_EXPORT_DEFAULT_LABEL } from './pdf-export';

export {
  useChordRender,
  type ChordRenderFormat,
  type ChordRenderOptions,
  type ChordRenderResult,
  type UseChordRenderOptions,
} from './use-chord-render';
export {
  useChordDiagram,
  type ChordDiagramInstrument,
  type ChordDiagramOrientation,
  type ChordDiagramResult,
  type UseChordDiagramOptions,
} from './use-chord-diagram';
export {
  usePdfExport,
  type PdfExportOptions,
  type UsePdfExportResult,
} from './use-pdf-export';
export {
  useTranspose,
  type UseTransposeOptions,
  type UseTransposeResult,
} from './use-transpose';
export { useDebounced } from './use-debounced';

/**
 * The running version of `@chordsketch/vue`. Returns the string
 * declared in this package's `package.json` so consumers can verify
 * at runtime which release they are executing against.
 */
export function version(): string {
  return packageJson.version;
}
