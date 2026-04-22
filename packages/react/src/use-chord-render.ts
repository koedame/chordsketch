import { useEffect, useRef, useState } from 'react';

// Narrow subset of the `@chordsketch/wasm` module surface this hook
// touches. Defined structurally (rather than re-exported from the
// WASM package) so the React bundle does not pull the WASM glue
// into its type graph — the actual module is dynamically imported
// at runtime. Keep in sync with the paired stub in
// `tests/helpers/wasm-stub.ts`.
interface ChordRenderer {
  default: () => Promise<unknown>;
  render_html: (input: string) => string;
  render_text: (input: string) => string;
  render_html_with_options: (
    input: string,
    options: { transpose?: number; config?: string },
  ) => string;
  render_text_with_options: (
    input: string,
    options: { transpose?: number; config?: string },
  ) => string;
}

/** Options accepted by the render call. */
export interface ChordRenderOptions {
  /** Semitone transposition offset (reduced modulo 12 by the renderer). */
  transpose?: number;
  /**
   * Configuration preset name (e.g. `"guitar"`, `"ukulele"`) or
   * inline RRJSON configuration string.
   */
  config?: string;
}

/** Supported render targets. */
export type ChordRenderFormat = 'html' | 'text';

/** Result state returned by {@link useChordRender}. */
export interface ChordRenderResult {
  /**
   * Rendered output. `null` while WASM is initialising or while the
   * render is in flight.
   */
  output: string | null;
  /** `true` while the WASM module is loading or the render is in flight. */
  loading: boolean;
  /**
   * The most recent render error (parse error, WASM init failure,
   * etc.), or `null` if the last render succeeded. Consumers render
   * this rather than letting the component throw.
   */
  error: Error | null;
}

/**
 * Injected WASM loader. Tests pass a structurally-compatible stub;
 * production callers take the default, which lazy-loads
 * `@chordsketch/wasm`.
 *
 * @internal
 */
export type ChordWasmLoader = () => Promise<ChordRenderer>;

const defaultLoader: ChordWasmLoader = () =>
  import('@chordsketch/wasm') as Promise<ChordRenderer>;

/**
 * Render a ChordPro source to HTML or plain text via
 * `@chordsketch/wasm`. The WASM module is loaded once per hook
 * instance (lazy) and reused across re-renders; the render result is
 * memoised against `(source, format, transpose, config)` so a render
 * that does not change inputs is not repeated.
 *
 * Render errors are surfaced via the returned `error` state, not
 * thrown — the hook keeps the previous `output` visible so a
 * transient invalid edit does not blank the preview. Consumers
 * decide whether to display the error inline, toast it, or ignore.
 */
export function useChordRender(
  source: string,
  format: ChordRenderFormat = 'html',
  options: ChordRenderOptions = {},
  loader: ChordWasmLoader = defaultLoader,
): ChordRenderResult {
  const [output, setOutput] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const rendererRef = useRef<ChordRenderer | null>(null);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  const { transpose, config } = options;

  useEffect(() => {
    // Guard against a late-resolving render overwriting a more
    // recent one — if the inputs change while we are awaiting the
    // renderer, the outer effect reruns, this flag flips, and the
    // in-flight render becomes a no-op.
    let cancelled = false;

    const run = async (): Promise<void> => {
      setLoading(true);
      try {
        if (rendererRef.current === null) {
          const mod = await loaderRef.current();
          // `init()` is a no-op on the Node build of
          // `@chordsketch/wasm` and required on the browser build.
          await mod.default();
          if (cancelled) return;
          rendererRef.current = mod;
        }
        const renderer = rendererRef.current;
        const hasOptions = transpose !== undefined || config !== undefined;
        let rendered: string;
        if (format === 'html') {
          rendered = hasOptions
            ? renderer.render_html_with_options(source, { transpose, config })
            : renderer.render_html(source);
        } else {
          rendered = hasOptions
            ? renderer.render_text_with_options(source, { transpose, config })
            : renderer.render_text(source);
        }
        if (cancelled) return;
        setOutput(rendered);
        setError(null);
      } catch (e) {
        if (cancelled) return;
        const err = e instanceof Error ? e : new Error(String(e));
        setError(err);
        // Deliberately keep the previous `output` so a momentarily
        // invalid edit (e.g. half-typed directive) does not blank
        // the preview. Consumers can render `error` alongside the
        // stale output if they want to surface the issue.
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void run();

    return () => {
      cancelled = true;
    };
    // `loader` intentionally excluded from the dependency array —
    // see `use-pdf-export.ts` for the identical pattern and
    // rationale (inline loaders would invalidate the effect every
    // render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, format, transpose, config]);

  return { output, loading, error };
}
