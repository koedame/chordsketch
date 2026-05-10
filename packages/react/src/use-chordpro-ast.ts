import { useCallback, useEffect, useRef, useState } from 'react';

import type { ChordproSong } from './chordpro-ast';

// Narrow subset of `@chordsketch/wasm` this hook touches —
// declared structurally so the React bundle does not pull the
// WASM glue into its type graph. The runtime surface is the
// `parseChordpro` / `parseChordproWithOptions` exports added in
// #2475 alongside the AST → JSX cut-over (ADR-0017).
interface ChordproParser {
  default: () => Promise<unknown>;
  parseChordproWithWarnings: (input: string) => { ast: string; warnings: string[] };
  parseChordproWithWarningsAndOptions: (
    input: string,
    options: { transpose?: number; config?: string },
  ) => { ast: string; warnings: string[] };
}

/** Options accepted by the parse call. */
export interface ChordproParseOptions {
  /** Semitone transposition offset (reduced modulo 12 by the parser). */
  transpose?: number;
  /**
   * Configuration preset name (e.g. `"guitar"`, `"ukulele"`) or
   * inline RRJSON configuration string. Forwarded to the parser
   * even though the AST itself does not embed render-time
   * configuration — the option is reserved so future hosts can
   * resolve config-derived AST transforms (define-aliases,
   * `+config.*` overrides) without a separate hook.
   */
  config?: string;
}

/** Result state returned by {@link useChordproAst}. */
export interface ChordproAstResult {
  /**
   * Parsed AST. `null` while WASM is initialising or while the
   * parse is in flight.
   */
  ast: ChordproSong | null;
  /** `true` while WASM is loading or the parse is in flight. */
  loading: boolean;
  /**
   * The most recent parse error (WASM init failure, JSON shape
   * mismatch, etc.), or `null` if the last parse succeeded.
   *
   * Only fatal failures land here (WASM module load, JSON.parse
   * of corrupt wasm output, network drop on lazy import).
   * Recoverable parse defects are surfaced via {@link warnings}
   * — see `parseChordproWithWarnings` in `@chordsketch/wasm`.
   */
  error: Error | null;
  /**
   * Recoverable parse warnings collected from the lenient
   * parser's error channel — e.g. "unrecognised directive at
   * line 12" or "unbalanced `{` on chord token". Empty when the
   * source parsed cleanly. Pre-existing warnings are preserved
   * across re-renders that fail; consumers can render them
   * alongside `error` or in a separate `role="status"` block.
   */
  warnings: string[];
  /**
   * Re-run the parse against the most recent (`source`,
   * `transpose`, `config`) tuple. Mainly useful when {@link error}
   * carries a transient WASM-init failure — calling `retry()`
   * re-imports the module instead of waiting for the next prop
   * change.
   */
  retry: () => void;
}

/**
 * Injected WASM loader. Tests pass a structurally-compatible stub;
 * production callers take the default, which lazy-loads
 * `@chordsketch/wasm`.
 *
 * @internal
 */
export type ChordproWasmLoader = () => Promise<ChordproParser>;

const defaultLoader: ChordproWasmLoader = () =>
  import('@chordsketch/wasm') as Promise<ChordproParser>;

/**
 * Parse ChordPro source into the AST shape declared in
 * `chordpro-ast.ts` via `@chordsketch/wasm::parseChordpro`. The
 * WASM module is loaded once per hook instance (lazy) and reused
 * across re-renders; the parsed AST is memoised against
 * `(source, transpose, config)` so a parse that does not change
 * inputs is not repeated.
 *
 * Parse errors surface via the returned `error` state, not
 * thrown — the hook keeps the previous `ast` visible so a
 * transient invalid edit does not blank the preview. Consumers
 * decide whether to display the error inline, toast it, or ignore.
 */
export function useChordproAst(
  source: string,
  options: ChordproParseOptions = {},
  loader: ChordproWasmLoader = defaultLoader,
): ChordproAstResult {
  const [ast, setAst] = useState<ChordproSong | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  // Bumping `retryNonce` forces the effect to re-fire even when
  // (`source`, `transpose`, `config`) are unchanged — the hook
  // surface for consumers that hit a transient WASM-init failure
  // and want to recover without an input change.
  const [retryNonce, setRetryNonce] = useState(0);

  const parserRef = useRef<ChordproParser | null>(null);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  const { transpose, config } = options;

  useEffect(() => {
    let cancelled = false;

    const run = async (): Promise<void> => {
      setLoading(true);
      try {
        if (parserRef.current === null) {
          let mod: ChordproParser;
          try {
            mod = await loaderRef.current();
            await mod.default();
          } catch (initErr) {
            // WASM init failures (network drop, MIME mismatch,
            // integrity check) are a different defect class
            // than parse errors — they can recover on retry,
            // and they should NOT poison `parserRef`. Log so
            // the failure is visible in devtools regardless of
            // whether the consumer renders `error`, then
            // surface it through the same `error` channel.
            if (typeof console !== 'undefined') {
              console.error(
                '[@chordsketch/react] useChordproAst: failed to load @chordsketch/wasm',
                initErr,
              );
            }
            throw initErr;
          }
          parserRef.current = mod;
          if (cancelled) return;
        }
        const parser = parserRef.current;
        const hasOptions = transpose !== undefined || config !== undefined;
        const result = hasOptions
          ? parser.parseChordproWithWarningsAndOptions(source, { transpose, config })
          : parser.parseChordproWithWarnings(source);
        const parsed = JSON.parse(result.ast) as ChordproSong;
        if (cancelled) return;
        setAst(parsed);
        setWarnings(result.warnings);
        setError(null);
      } catch (e) {
        if (cancelled) return;
        const err = e instanceof Error ? e : new Error(String(e));
        setError(err);
        // Keep the previous `ast` and `warnings` so half-typed
        // edits do not blank the preview — consumers render
        // `error` alongside the stale tree if they want to
        // surface the issue. Init failures keep `parserRef`
        // null so the next `run()` re-imports the module
        // (manual retry via `retry()` or an input change).
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
    // `loader` intentionally excluded — see `use-chord-render.ts`
    // for the identical pattern + rationale (inline loaders would
    // invalidate the effect every render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, transpose, config, retryNonce]);

  const retry = useCallback(() => {
    setRetryNonce((n) => n + 1);
  }, []);

  return { ast, loading, error, warnings, retry };
}
