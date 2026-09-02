// @chordsketch/svelte — Svelte 5 component library for ChordPro
// rendering backed by @chordsketch/wasm.

import packageJson from '../package.json' with { type: 'json' };

export { default as ChordSheet } from './ChordSheet.svelte';
export { default as ChordTextarea } from './ChordTextarea.svelte';
export { default as ChordDiagram } from './ChordDiagram.svelte';
export {
  default as Transpose,
  TRANSPOSE_DEFAULT_MAX,
  TRANSPOSE_DEFAULT_MIN,
} from './Transpose.svelte';
export { default as PdfExport, PDF_EXPORT_DEFAULT_LABEL } from './PdfExport.svelte';

export {
  useChordRender,
  type ChordRenderFormat,
  type ChordRenderOptions,
  type ChordRenderResult,
  type UseChordRenderOptions,
} from './use-chord-render.svelte';
export {
  useChordDiagram,
  type ChordDiagramInstrument,
  type ChordDiagramOrientation,
  type ChordDiagramResult,
  type UseChordDiagramOptions,
} from './use-chord-diagram.svelte';
export {
  usePdfExport,
  type PdfExportOptions,
  type UsePdfExportResult,
} from './use-pdf-export.svelte';
export {
  useTranspose,
  type UseTransposeOptions,
  type UseTransposeResult,
} from './use-transpose.svelte';
export { useDebounced, type DebouncedResult } from './use-debounced.svelte';
export { toValue, type MaybeGetter } from './reactive';

/**
 * The running version of `@chordsketch/svelte`. Returns the string
 * declared in this package's `package.json` so consumers can verify
 * at runtime which release they are executing against.
 */
export function version(): string {
  return packageJson.version;
}
