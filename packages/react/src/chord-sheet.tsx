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

  // HTML output is produced by `chordsketch-render-html`, which
  // escapes all user-supplied ChordPro tokens (titles, lyrics,
  // chord names, attributes, inline markup, custom section labels)
  // via `escape_xml` before emitting markup. For typical
  // first-party ChordPro content the output is therefore safe to
  // inject via `dangerouslySetInnerHTML`. Delegate sections
  // (`{start_of_abc}`, `{start_of_ly}`, `{start_of_musicxml}`,
  // `{start_of_textblock}`) are the documented exception — their
  // bodies are passed through raw per `chordsketch-render-html`'s
  // module-level security note. Hosts that accept untrusted
  // ChordPro SHOULD combine this component with a Content Security
  // Policy that restricts inline scripts and external resource
  // loads, or switch to `format="text"` (zero-HTML preview).
  //
  // The error node (if any) lives in a sibling element rather than
  // being stringified into the HTML branch, so a consumer-supplied
  // JSX `errorFallback` renders identically under both `format`
  // values.
  return (
    <div {...divProps} className={wrapperClass} aria-busy={loading || undefined}>
      {errorNode}
      <div
        className="chordsketch-sheet__content"
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{ __html: output }}
      />
    </div>
  );
}
