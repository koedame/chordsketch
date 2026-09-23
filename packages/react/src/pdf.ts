// @chordsketch/react/pdf — PDF export surface, split from the main
// entry point so that bundlers which resolve dynamic `import()`
// calls at build time (webpack, Turbopack — notably Next.js) do not
// force every consumer of `@chordsketch/react` to install the heavy
// `@chordsketch/wasm-export` peer just to render `<ChordSheet>` or
// `<ChordProEditor>`. Import from here only if you use `<PdfExport>`
// / `usePdfExport`, and install `@chordsketch/wasm-export` alongside
// this package.
//
// `<RendererPreview>` and `<PreviewToolbar>` no longer render PDF
// export UI on their own; pass the `PdfExport` component exported
// here as their `pdfExportComponent` prop to opt in.
export {
  PdfExport,
  type PdfExportProps,
  PDF_EXPORT_DEFAULT_LABEL,
} from './pdf-export';
export {
  usePdfExport,
  type PdfExportOptions,
  type UsePdfExportResult,
  type WasmLoader,
} from './use-pdf-export';
