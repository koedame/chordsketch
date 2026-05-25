import { useCallback, useEffect, useRef, useState } from 'react';

import type { ChordproSong } from './chordpro-ast';

// Narrow subset of `@chordsketch/wasm` this hook touches —
// declared structurally so the React bundle does not pull the
// WASM glue into its type graph. The runtime surface is the
// `parseChordpro` / `parseChordproWithOptions` exports added in
// #2475 alongside the AST → JSX cut-over (ADR-0017).
interface ChordproParser {
  default: () => Promise<unknown>;
  parseChordproWithWarnings: (input: string) => {
    ast: string;
    warnings: string[];
    transposedKey?: string;
    transposedKeyDirectives?: Record<string, string>;
  };
  parseChordproWithWarningsAndOptions: (
    input: string,
    options: { transpose?: number; config?: string },
  ) => {
    ast: string;
    warnings: string[];
    transposedKey?: string;
    transposedKeyDirectives?: Record<string, string>;
  };
}

/** Options accepted by the parse call. */
export interface ChordproParseOptions {
  /**
   * Semitone transposition offset (reduced modulo 12 by the
   * parser). The wasm parser deserialises this into an `i8`
   * (`-128..=127`); values outside that range are rejected at
   * deserialisation time and surface as a parse error on the
   * hook's `error` state. Callers driving the value through the
   * `<Transpose>` slider stay well inside the range because the
   * slider clamps via its `min` / `max` props.
   */
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
  /**
   * When `true`, the hook holds `ast` at `null` and never
   * triggers the wasm load. Use this in components that
   * conditionally need a parsed AST (e.g. `<Capo>` in
   * controlled mode does not parse `source`) so the wasm
   * module is not fetched eagerly when its output would be
   * discarded.
   */
  skip?: boolean;
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
  /**
   * Transposed `{key}` directive value when `transpose !== 0`
   * AND the source carried a `{key}` directive whose value
   * parses as a chord. `null` otherwise — the walker falls back
   * to showing only the AST's original `metadata.key` in that
   * case. Mirrors the `transposedKey` field on the wasm
   * `ParseChordproResult` shape.
   */
  transposedKey: string | null;
  /**
   * Map of `original {key:} directive value → transposed value`
   * covering every `{key:}` directive in the song (primary +
   * mid-song). Empty when `transpose === 0` or no `{key:}`
   * directive parsed as a chord. Mirrors the
   * `transposedKeyDirectives` field on the wasm
   * `ParseChordproResult` shape (#2525) — the walker uses it to
   * render mid-song key chips with the canonical transposed
   * spelling matching the Rust text / HTML / PDF surfaces.
   */
  transposedKeyDirectives: Record<string, string>;
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
  const [transposedKey, setTransposedKey] = useState<string | null>(null);
  const [transposedKeyDirectives, setTransposedKeyDirectives] = useState<
    Record<string, string>
  >({});
  // Bumping `retryNonce` forces the effect to re-fire even when
  // (`source`, `transpose`, `config`) are unchanged — the hook
  // surface for consumers that hit a transient WASM-init failure
  // and want to recover without an input change.
  const [retryNonce, setRetryNonce] = useState(0);

  const parserRef = useRef<ChordproParser | null>(null);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  const { transpose, config, skip = false } = options;

  useEffect(() => {
    if (skip) {
      // Caller is signalling the AST will not be consumed — keep
      // the hook idle so the wasm module is not fetched. Reset
      // `loading` to `false` so consumers can still inspect the
      // (`null`) `ast` state without thinking work is in flight.
      setLoading(false);
      return;
    }
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
        setTransposedKey(result.transposedKey ?? null);
        setTransposedKeyDirectives(result.transposedKeyDirectives ?? {});
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
  }, [source, transpose, config, retryNonce, skip]);

  const retry = useCallback(() => {
    setRetryNonce((n) => n + 1);
  }, []);

  return {
    ast,
    loading,
    error,
    warnings,
    retry,
    transposedKey,
    transposedKeyDirectives,
  };
}
