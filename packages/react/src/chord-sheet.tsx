import type { HTMLAttributes, ReactNode } from 'react';

import {
  type ChordRenderFormat,
  type ChordRenderOptions,
  type ChordWasmLoader,
  useChordRender,
} from './use-chord-render';

/** Props accepted by {@link ChordSheet}. */
export interface ChordSheetProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
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
   * Render target. `"html"` (default) produces ChordPro's HTML
   * output and renders via `dangerouslySetInnerHTML`; `"text"`
   * produces plain chords-above-lyrics text which renders inside a
   * `<pre>` with no HTML parsing. Both outputs come from the
   * `@chordsketch/wasm` renderer, which the host trusts — no user
   * HTML is ever injected.
   */
  format?: ChordRenderFormat;
  /**
   * Optional content shown while WASM is initialising or a render
   * is in flight. Defaults to the last successful output so the
   * preview does not blank during edits; pass `null` to hide.
   */
  loadingFallback?: ReactNode;
  /**
   * Optional render prop that takes over when a parse or render
   * error occurs. Receives the `Error` instance; return any
   * `ReactNode`. Defaults to a minimal `role="alert"` div showing
   * the error message. Pass `null` to hide errors entirely (useful
   * when the host surfaces them via a toast or inline banner
   * alongside the stale output).
   */
  errorFallback?: ((error: Error) => ReactNode) | null;
  /**
   * Test-only WASM loader override. Production callers never need
   * to supply this — the default lazy-loads `@chordsketch/wasm`.
   *
   * @internal
   */
  wasmLoader?: ChordWasmLoader;
}

function defaultErrorFallback(error: Error): ReactNode {
  return (
    <div role="alert" className="chordsketch-sheet__error">
      {error.message}
    </div>
  );
}

/**
 * Flagship render component for the library. Renders ChordPro
 * source via `@chordsketch/wasm` and memoises the result against
 * `(source, format, transpose, config)` so re-renders without
 * input changes do not re-parse.
 *
 * ```tsx
 * <ChordSheet source={chordproSource} transpose={0} />
 * ```
 *
 * Error handling: parse or render errors surface via the
 * `errorFallback` prop (default: inline `role="alert"`); the
 * component does not throw. The previous successful output stays
 * visible while a transient error shows alongside, so a
 * half-typed edit does not blank the preview.
 */
export function ChordSheet({
  source,
  transpose,
  config,
  format = 'html',
  loadingFallback,
  errorFallback = defaultErrorFallback,
  wasmLoader,
  className,
  ...divProps
}: ChordSheetProps): JSX.Element {
  const renderOptions: ChordRenderOptions = { transpose, config };
  const { output, loading, error } = useChordRender(source, format, renderOptions, wasmLoader);

  const wrapperClass = ['chordsketch-sheet', className].filter(Boolean).join(' ');
  const errorNode = error !== null && errorFallback !== null ? errorFallback(error) : null;

  // Nothing rendered yet AND still loading — show the loading
  // fallback if one was supplied. `loadingFallback === undefined`
  // (the default) falls through to an empty wrapper so consumers
  // that pass no fallback do not see a layout shift when loading
  // eventually resolves.
  if (output === null) {
    return (
      <div {...divProps} className={wrapperClass} aria-busy={loading || undefined}>
        {errorNode}
        {loading && loadingFallback !== undefined ? loadingFallback : null}
      </div>
    );
  }

  if (format === 'text') {
    // Plain text lands inside a `<pre>` — no HTML parsing, no
    // sanitiser needed, preserves the renderer's column alignment.
    return (
      <div {...divProps} className={wrapperClass} aria-busy={loading || undefined}>
        {errorNode}
        <pre className="chordsketch-sheet__text">{output}</pre>
      </div>
    );
  }

  // HTML output is produced by `chordsketch-render-html`, which is
  // part of this project's SDK layer — the output is trusted the
  // same way the CLI's HTML output is. ChordPro source is never
  // interpreted as HTML at the input boundary; any HTML tokens in
  // the input are escaped by the renderer before they reach this
  // point. Injecting via `dangerouslySetInnerHTML` is therefore
  // safe here. If you are worried about rendering untrusted
  // renderer output, use `format="text"` (plain-text, no HTML).
  return (
    <div
      {...divProps}
      className={wrapperClass}
      aria-busy={loading || undefined}
      // eslint-disable-next-line react/no-danger
      dangerouslySetInnerHTML={{ __html: maybePrependError(errorNode, output) }}
    />
  );
}

// Inline error prepending for the HTML branch: React does not let
// us mix children and `dangerouslySetInnerHTML`, so we render the
// error to a raw string when it is present. The errorFallback
// return value is a ReactNode — if the consumer passes a complex
// fallback they should move to the `format="text"` branch (or
// stop passing a custom errorFallback and surface the error via
// the `error` state from useChordRender directly).
//
// Default path: no customisation ⇒ errorNode is the built-in
// `role=alert` div; serialise it to the minimal markup
// equivalent. Consumers that supply a custom `errorFallback` for
// the HTML branch get the raw HTML of its output if it's a string
// or an empty prefix otherwise.
function maybePrependError(errorNode: ReactNode, html: string): string {
  if (errorNode === null || errorNode === undefined || errorNode === false) {
    return html;
  }
  if (typeof errorNode === 'string') {
    return escapeHtml(errorNode) + html;
  }
  // For the default `defaultErrorFallback` output we render a
  // minimal `role="alert"` div with the message plain-text.
  // Consumers that supply richer ReactNode fallbacks should use
  // `format="text"` instead — this branch keeps them working but
  // falls back to no prefix.
  if (typeof errorNode === 'object' && errorNode !== null && 'props' in errorNode) {
    const props = (errorNode as { props?: { children?: unknown } }).props ?? {};
    if (typeof props.children === 'string') {
      return `<div role="alert" class="chordsketch-sheet__error">${escapeHtml(
        props.children,
      )}</div>${html}`;
    }
  }
  return html;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
