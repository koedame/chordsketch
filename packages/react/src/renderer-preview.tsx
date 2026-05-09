import type { HTMLAttributes, ReactNode } from 'react';
import { useEffect, useRef } from 'react';

import { ChordSheet } from './chord-sheet';
import { PdfExport } from './pdf-export';
import {
  type ChordRenderFormat,
  type ChordWasmLoader,
  useChordRender,
} from './use-chord-render';

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
 * Format-aware preview surface. Renders the `html` format inside
 * a sandboxed iframe (so the renderer's `<style>` block does not
 * leak its body-level styling — `body { max-width: 720px; … }` —
 * to the host document); renders `text` via {@link ChordSheet}
 * (zero-HTML, no isolation needed); renders `pdf` as a download
 * action via {@link PdfExport}. The renderer escapes
 * user-supplied tokens before emitting markup, so iframe
 * isolation is defence-in-depth rather than the primary
 * sanitisation boundary. See `<ChordSheet>` for the full security
 * note covering the `text` branch.
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
  loadingFallback,
  errorFallback,
  wasmLoader,
  className,
  ...divProps
}: RendererPreviewProps): JSX.Element {
  const wrapperClass = ['chordsketch-preview', className]
    .filter(Boolean)
    .join(' ');

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

  if (format === 'html') {
    return (
      <HtmlPreview
        {...divProps}
        className={`${wrapperClass} chordsketch-preview--html`}
        source={source}
        transpose={transpose}
        config={config}
        loadingFallback={loadingFallback}
        errorFallback={errorFallback}
        wasmLoader={wasmLoader}
      />
    );
  }

  return (
    <ChordSheet
      {...divProps}
      className={`${wrapperClass} chordsketch-preview--text`}
      source={source}
      format="text"
      transpose={transpose}
      config={config}
      loadingFallback={loadingFallback}
      errorFallback={errorFallback}
      wasmLoader={wasmLoader}
    />
  );
}

interface HtmlPreviewProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  source: string;
  transpose?: number;
  config?: string;
  loadingFallback?: ReactNode;
  errorFallback?: ((error: Error) => ReactNode) | null;
  wasmLoader?: ChordWasmLoader;
}

function defaultErrorFallback(error: Error): ReactNode {
  return (
    <div role="alert" className="chordsketch-preview__error">
      {error.message}
    </div>
  );
}

/**
 * Sandboxed iframe preview for the HTML format. The renderer's
 * full document (with its embedded `<style>` block) becomes the
 * iframe's `srcdoc`, so its body-level styling never reaches the
 * parent document. The iframe `sandbox` is restrictive: only
 * `allow-popups` (for chord-link clicks) and
 * `allow-popups-to-escape-sandbox` are permitted; scripts,
 * forms, and storage stay disabled.
 *
 * `cacheBust` is a render-counter HTML comment that guarantees
 * `srcdoc` is byte-different across renders so the iframe's
 * navigation hook does not elide the assignment as a no-op when
 * the produced document would otherwise be byte-equal to the
 * previous render. Mirrors the cache-bust strategy in
 * `@chordsketch/ui-web`'s `HTML_FRAME_TEMPLATE`.
 */
function HtmlPreview({
  source,
  transpose,
  config,
  loadingFallback,
  errorFallback = defaultErrorFallback,
  wasmLoader,
  className,
  ...divProps
}: HtmlPreviewProps): JSX.Element {
  const { output, loading, error } = useChordRender(
    source,
    'html',
    { transpose, config },
    wasmLoader,
  );
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const cacheBustRef = useRef<number>(0);

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    if (output === null) return;
    cacheBustRef.current += 1;
    // Inject a cache-bust comment so two consecutive renders that
    // would otherwise produce the same `srcdoc` string still
    // trigger an iframe navigation. The comment lives INSIDE the
    // renderer's `<head>` (between `</title>` and `</head>`) so
    // the document still starts with `<!DOCTYPE html>` — placing
    // a comment before the doctype puts the browser in quirks
    // mode, which broke iframe rendering for SVG body content
    // (#2454 sister-site verification).
    const marker = `<!-- r:${cacheBustRef.current} -->`;
    const headEnd = output.indexOf('</head>');
    const next =
      headEnd === -1 ? output : output.slice(0, headEnd) + marker + output.slice(headEnd);
    iframe.srcdoc = next;
  }, [output]);

  const errorNode = error !== null && errorFallback !== null ? errorFallback(error) : null;

  return (
    <div {...divProps} className={className} aria-busy={loading || undefined}>
      {errorNode}
      {output === null && loading && loadingFallback !== undefined ? loadingFallback : null}
      <iframe
        ref={iframeRef}
        className="chordsketch-preview__frame"
        title="Rendered chord sheet"
        sandbox="allow-popups allow-popups-to-escape-sandbox"
      />
    </div>
  );
}
