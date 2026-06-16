import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

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
   * `<Transpose>` select stay well inside the range because the
   * select only offers options bounded by its `min` / `max` props.
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
   * Parsed AST. `null` only while the wasm module is initialising
   * (or when `skip` is set). Once the module is loaded the AST is
   * derived synchronously from `source`, so it is never a render
   * behind the current input.
   */
  ast: ChordproSong | null;
  /** `true` only while the wasm module is loading. Parsing itself is
   * synchronous, so there is no per-parse in-flight window. */
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
  const { transpose, config, skip = false } = options;

  // The wasm module is loaded once (async); after that, parsing is a
  // synchronous call. The AST is therefore DERIVED synchronously from
  // `(parser, source, transpose, config)` in the `useMemo` below rather
  // than written into state from an async effect. This is what keeps
  // `source` and `ast` updating in the SAME render: a source change
  // (e.g. a chord nudge) never leaves the AST a tick behind, which used
  // to unmount/remount selection-dependent UI for one frame — the chord
  // inspector flicker (#2638).
  const [parser, setParser] = useState<ChordproParser | null>(null);
  const [initError, setInitError] = useState<Error | null>(null);
  // Bumping `retryNonce` re-fires the load effect after a transient
  // WASM-init failure even though `(source, transpose, config)` are
  // unchanged.
  const [retryNonce, setRetryNonce] = useState(0);

  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  useEffect(() => {
    if (skip || parser !== null) return;
    let cancelled = false;
    void (async () => {
      try {
        const mod = await loaderRef.current();
        await mod.default();
        if (cancelled) return;
        setParser(() => mod);
        setInitError(null);
      } catch (e) {
        // WASM init failures (network drop, MIME mismatch, integrity
        // check) recover on retry and must NOT poison `parser`. Log so
        // the failure is visible in devtools regardless of whether the
        // consumer renders `error`, then surface it through `error`.
        if (typeof console !== 'undefined') {
          console.error(
            '[@chordsketch/react] useChordproAst: failed to load @chordsketch/wasm',
            e,
          );
        }
        if (!cancelled) setInitError(e instanceof Error ? e : new Error(String(e)));
      }
    })();
    return () => {
      cancelled = true;
    };
    // `loader` intentionally excluded — see `use-chord-render.ts` for
    // the identical pattern + rationale (inline loaders would
    // invalidate the effect every render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skip, parser, retryNonce]);

  // Last successfully-committed parse, retained so a transient invalid
  // edit (or a parse throw) does not blank the preview — consumers
  // render `error` alongside the stale tree if they want to surface the
  // issue. It is written ONLY from a post-commit effect (below), never
  // during render: the `useMemo` factory stays pure so an abandoned
  // concurrent render (a transition React discards) can never pollute
  // the cache with an AST that was never committed.
  const lastGoodRef = useRef<{
    ast: ChordproSong;
    warnings: string[];
    transposedKey: string | null;
    transposedKeyDirectives: Record<string, string>;
  } | null>(null);

  const { ast, warnings, transposedKey, transposedKeyDirectives, parseError } = useMemo(() => {
    if (skip || parser === null) {
      return {
        ast: null as ChordproSong | null,
        warnings: [] as string[],
        transposedKey: null as string | null,
        transposedKeyDirectives: {} as Record<string, string>,
        parseError: null as Error | null,
      };
    }
    try {
      const hasOptions = transpose !== undefined || config !== undefined;
      const result = hasOptions
        ? parser.parseChordproWithWarningsAndOptions(source, { transpose, config })
        : parser.parseChordproWithWarnings(source);
      return {
        ast: JSON.parse(result.ast) as ChordproSong,
        warnings: result.warnings,
        transposedKey: result.transposedKey ?? null,
        transposedKeyDirectives: result.transposedKeyDirectives ?? {},
        parseError: null as Error | null,
      };
    } catch (e) {
      // Fall back to the last committed good parse so the preview does
      // not blank on a half-typed edit.
      const prev = lastGoodRef.current;
      return {
        ast: prev?.ast ?? null,
        warnings: prev?.warnings ?? [],
        transposedKey: prev?.transposedKey ?? null,
        transposedKeyDirectives: prev?.transposedKeyDirectives ?? {},
        parseError: e instanceof Error ? e : new Error(String(e)),
      };
    }
  }, [parser, source, transpose, config, skip]);

  // Remember the last good parse AFTER commit. Running this in an effect
  // (not in the memo) keeps the cache consistent with what was actually
  // committed, even if React renders-then-abandons a memo for a source
  // that never paints.
  useEffect(() => {
    if (parseError === null && ast !== null) {
      lastGoodRef.current = { ast, warnings, transposedKey, transposedKeyDirectives };
    }
  }, [ast, warnings, transposedKey, transposedKeyDirectives, parseError]);

  const retry = useCallback(() => {
    // Drop the parser so the load effect re-imports the module, and
    // bump the nonce so the effect re-fires even when `parser` is
    // already null (a load that failed before ever setting it).
    setParser(null);
    setInitError(null);
    setRetryNonce((n) => n + 1);
  }, []);

  // `loading` is true only while the wasm module itself is loading;
  // parsing is synchronous, so there is no per-parse in-flight window.
  const loading = !skip && parser === null && initError === null;
  const error = initError ?? parseError;

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
