import type { HTMLAttributes, ReactNode } from 'react';

import { renderChordproAst } from './chordpro-jsx';
import type { ChordDiagramInstrument } from './use-chord-diagram';
import {
  type ChordRenderFormat,
  type ChordRenderOptions,
  type ChordWasmLoader,
  useChordRender,
} from './use-chord-render';
import {
  type ChordproWasmLoader,
  useChordproAst,
} from './use-chordpro-ast';

/** Props accepted by {@link ChordSheet}. */
export interface ChordSheetProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  /** ChordPro source to render. */
  source: string;
  /** Semitone transposition offset forwarded to the renderer. */
  transpose?: number;
  /**
   * Append a chord-diagrams grid at the end of the rendered
   * song. When set, every unique chord in the lyrics + every
   * chord declared via `{define}` gets a fretboard / keyboard
   * diagram via the in-built voicing database. Honours
   * `{diagrams: off}` / `{no_diagrams}` directives in the
   * source. Pass `'guitar'` / `'ukulele'` / `'piano'` etc.;
   * defaults to `'guitar'` when the option is set without a
   * specific instrument. Only consumed by `format="html"`.
   */
  chordDiagramsInstrument?: ChordDiagramInstrument;
  /**
   * 1-indexed source line that should be highlighted in the
   * rendered preview. Forwarded to the AST walker
   * (`renderChordproAst`'s `activeSourceLine` option), which tags
   * every body element with `data-source-line` and applies a
   * `line--active` modifier to the matching element. Pair with
   * `<SourceEditor>`'s `onCaretLineChange` callback to keep the
   * preview's highlighted line in sync with the editor caret.
   * Only consumed by `format="html"` — the text branch passes
   * through unchanged.
   */
  activeSourceLine?: number;
  /**
   * 0-indexed caret column inside the active source line. Paired
   * with `caretLineLength`, drives the preview-side
   * `<span class="caret-marker">` overlay positioned by
   * `column / lineLength`. Omit either to fall back to plain
   * line-level highlighting.
   */
  caretColumn?: number;
  /** Total character length of the active source line. */
  caretLineLength?: number;
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
   * Test-only WASM loader override applied to the
   * `format="text"` branch (which still uses the wasm
   * `render_text` string surface). Production callers never
   * need to supply this — the default lazy-loads
   * `@chordsketch/wasm`.
   *
   * @internal
   */
  wasmLoader?: ChordWasmLoader;
  /**
   * Test-only WASM loader override applied to the
   * `format="html"` branch (which now drives `parseChordpro`
   * via the AST → JSX walker per ADR-0017). Distinct from
   * {@link wasmLoader} because the two branches consume
   * different parts of the wasm surface — a stub for one is
   * not generally usable for the other.
   *
   * Production callers never need to supply this.
   *
   * @internal
   */
  astWasmLoader?: ChordproWasmLoader;
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
 * Render path (per ADR-0017):
 * - `format="html"` parses with `parseChordpro` and renders the
 *   AST directly via the chordpro-jsx walker — pure React DOM,
 *   no HTML-string injection, no `<style>` block on the React
 *   surface.
 * - `format="text"` retains the wasm `render_text` path because
 *   ChordPro's text rendering is column-aligned plain output the
 *   AST walker would have to re-derive.
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
  astWasmLoader,
  chordDiagramsInstrument,
  activeSourceLine,
  caretColumn,
  caretLineLength,
  className,
  ...divProps
}: ChordSheetProps): JSX.Element {
  const wrapperClass = ['chordsketch-sheet', className].filter(Boolean).join(' ');

  if (format === 'text') {
    return (
      <ChordSheetTextBranch
        source={source}
        transpose={transpose}
        config={config}
        loadingFallback={loadingFallback}
        errorFallback={errorFallback}
        wasmLoader={wasmLoader}
        wrapperClass={wrapperClass}
        divProps={divProps}
      />
    );
  }

  return (
    <ChordSheetAstBranch
      source={source}
      transpose={transpose}
      config={config}
      loadingFallback={loadingFallback}
      errorFallback={errorFallback}
      wasmLoader={astWasmLoader}
      chordDiagramsInstrument={chordDiagramsInstrument}
      activeSourceLine={activeSourceLine}
      caretColumn={caretColumn}
      caretLineLength={caretLineLength}
      wrapperClass={wrapperClass}
      divProps={divProps}
    />
  );
}

interface BranchProps {
  source: string;
  transpose: number | undefined;
  config: string | undefined;
  loadingFallback: ReactNode | undefined;
  errorFallback: ((error: Error) => ReactNode) | null;
  wrapperClass: string;
  divProps: Omit<HTMLAttributes<HTMLDivElement>, 'children' | 'className'>;
}

function ChordSheetTextBranch({
  source,
  transpose,
  config,
  loadingFallback,
  errorFallback,
  wasmLoader,
  wrapperClass,
  divProps,
}: BranchProps & { wasmLoader: ChordWasmLoader | undefined }): JSX.Element {
  const renderOptions: ChordRenderOptions = { transpose, config };
  const { output, loading, error } = useChordRender(source, 'text', renderOptions, wasmLoader);
  const errorNode = error !== null && errorFallback !== null ? errorFallback(error) : null;

  if (output === null) {
    return (
      <div {...divProps} className={wrapperClass} aria-busy={loading || undefined}>
        {errorNode}
        {loading && loadingFallback !== undefined ? loadingFallback : null}
      </div>
    );
  }

  return (
    <div {...divProps} className={wrapperClass} aria-busy={loading || undefined}>
      {errorNode}
      <pre className="chordsketch-sheet__text">{output}</pre>
    </div>
  );
}

function ChordSheetAstBranch({
  source,
  transpose,
  config,
  loadingFallback,
  errorFallback,
  wasmLoader,
  chordDiagramsInstrument,
  activeSourceLine,
  caretColumn,
  caretLineLength,
  wrapperClass,
  divProps,
}: BranchProps & {
  wasmLoader: ChordproWasmLoader | undefined;
  chordDiagramsInstrument: ChordDiagramInstrument | undefined;
  activeSourceLine: number | undefined;
  caretColumn: number | undefined;
  caretLineLength: number | undefined;
}): JSX.Element {
  const { ast, loading, error, transposedKey } = useChordproAst(
    source,
    { transpose, config },
    wasmLoader,
  );
  const errorNode = error !== null && errorFallback !== null ? errorFallback(error) : null;

  if (ast === null) {
    return (
      <div {...divProps} className={wrapperClass} aria-busy={loading || undefined}>
        {errorNode}
        {loading && loadingFallback !== undefined ? loadingFallback : null}
      </div>
    );
  }

  // AST walker emits a `<div class="song">` root matching the
  // `chordsketch-render-html` DOM contract so existing CSS keeps
  // working unchanged. Pure React reconciliation owns the tree
  // — no innerHTML escape hatch on this surface. The
  // `transposedKey` plumbed through from `parseChordproWithWarnings*`
  // drives the "Original Key X · Play Key Y" header path.
  return (
    <div {...divProps} className={wrapperClass} aria-busy={loading || undefined}>
      {errorNode}
      <div className="chordsketch-sheet__content">
        {renderChordproAst(ast, {
          transposedKey,
          chordDiagrams: chordDiagramsInstrument
            ? { instrument: chordDiagramsInstrument }
            : null,
          activeSourceLine,
          caretColumn,
          caretLineLength,
        })}
      </div>
    </div>
  );
}
