/**
 * Default label rendered by {@link PdfExport} when a consumer passes
 * no `children`, and reused verbatim by `<PreviewToolbar>`'s Export
 * group so both call sites render the same string from a single
 * source of truth.
 *
 * Split into its own module (rather than living in `pdf-export.tsx`)
 * so that `preview-toolbar.tsx` can import the label without pulling
 * in `pdf-export.tsx` → `use-pdf-export.ts`, which lazy-loads the
 * heavy `@chordsketch/wasm-export` peer. Bundlers that statically
 * resolve dynamic `import()` calls at build time (webpack,
 * Turbopack) would otherwise force every consumer of
 * `<PreviewToolbar>` to install that peer even when the Export group
 * is disabled or its button is injected from elsewhere.
 */
export const PDF_EXPORT_DEFAULT_LABEL = 'Export PDF';
