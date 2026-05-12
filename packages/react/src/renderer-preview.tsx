import type { HTMLAttributes, ReactNode } from 'react';

import { ChordSheet } from './chord-sheet';
import { PdfExport } from './pdf-export';
import type { ChordDiagramInstrument } from './use-chord-diagram';
import { type ChordRenderFormat, type ChordWasmLoader } from './use-chord-render';

/** Preview format selectable in {@link RendererPreview}. */
export type PreviewFormat = ChordRenderFormat | 'pdf';

/** Props accepted by {@link RendererPreview}. */
export interface RendererPreviewProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  /** ChordPro source to render. */
  source: string;
  /** Semitone transposition offset forwarded to the renderer. */
  transpose?: number;
  /**
   * Configuration preset name (e.g. `"guitar"`, `"ukulele"`) or an
   * inline RRJSON configuration string.
   */
  config?: string;
  /**
   * Output format. `"html"` renders the song as design-system styled
   * HTML; `"text"` renders the chords-above-lyrics text format;
   * `"pdf"` shows a download button that produces a PDF on demand.
   */
  format: PreviewFormat;
  /** Filename used for the PDF download. Defaults to `"chordsketch-output.pdf"`. */
  pdfFilename?: string;
  /**
   * Opt-in: render the auto-injected chord-diagrams grid at the end
   * of the song for the given instrument. The grid is then gated by
   * the song's `{diagrams: on/off}` / `{no_diagrams}` directives.
   * Omit (the default) to suppress the grid regardless of the
   * directive — the React surface intentionally keeps this
   * consumer-driven rather than auto-emitting like the Rust HTML
   * renderer does.
   */
  chordDiagramsInstrument?: ChordDiagramInstrument;
  /**
   * 1-indexed source line that should be highlighted in the
   * rendered preview. Forwarded to {@link ChordSheet}'s
   * `activeSourceLine` prop. Pair with `<SourceEditor>`'s
   * `onCaretLineChange` callback for editor↔preview caret sync.
   * Only consumed by `format="html"`.
   */
  activeSourceLine?: number;
  /** Optional content rendered while the wasm runtime is initialising. */
  loadingFallback?: ReactNode;
  /**
   * Optional render prop that takes over when a parse or render
   * error occurs. Receives the `Error` instance; return any
   * `ReactNode`. Defaults to a minimal `role="alert"` div showing
   * the error message.
   */
  errorFallback?: ((error: Error) => ReactNode) | null;
  /**
   * Test-only WASM loader override for the inline (`html` / `text`)
   * formats. The PDF branch uses its own default loader via
   * {@link PdfExport}; production callers never need to supply
   * this.
   *
   * @internal
   */
  wasmLoader?: ChordWasmLoader;
}

/**
 * Format-aware preview surface. Both `html` and `text` delegate
 * to {@link ChordSheet}, which renders the AST directly via the
 * chordpro-jsx walker (`html`) or via a `<pre>` block (`text`)
 * — see ADR-0017 for the architectural split between the React
 * surface (AST → JSX) and the Rust surface (`chordsketch-render-html`,
 * which still backs the CLI / FFI / GitHub Action). PDF stays a
 * download action via {@link PdfExport} because PDF generation is
 * binary and remains owned by `chordsketch-render-pdf`.
 *
 * The previous iframe-sandbox HTML branch was retired in #2475 —
 * with React owning the DOM, body-style isolation is provided by
 * the consumer's stylesheet rather than by an embedded
 * `<iframe srcdoc>`.
 *
 * ```tsx
 * <RendererPreview source={chordpro} format={format} transpose={offset} />
 * ```
 */
export function RendererPreview({
  source,
  transpose,
  config,
  format,
  pdfFilename = 'chordsketch-output.pdf',
  chordDiagramsInstrument,
  activeSourceLine,
  loadingFallback,
  errorFallback,
  wasmLoader,
  className,
  ...divProps
}: RendererPreviewProps): JSX.Element {
  const wrapperClass = ['chordsketch-preview', className].filter(Boolean).join(' ');

  if (format === 'pdf') {
    return (
      <div {...divProps} className={`${wrapperClass} chordsketch-preview--pdf`}>
        <p className="chordsketch-preview__hint">
          Click the button to generate and download a PDF.
        </p>
        <PdfExport
          source={source}
          options={{ transpose, config }}
          filename={pdfFilename}
          className="chordsketch-pdf-export"
        >
          Download PDF
        </PdfExport>
      </div>
    );
  }

  return (
    <ChordSheet
      {...divProps}
      className={`${wrapperClass} chordsketch-preview--${format}`}
      source={source}
      format={format}
      transpose={transpose}
      config={config}
      chordDiagramsInstrument={chordDiagramsInstrument}
      activeSourceLine={activeSourceLine}
      loadingFallback={loadingFallback}
      errorFallback={errorFallback}
      wasmLoader={wasmLoader}
    />
  );
}
