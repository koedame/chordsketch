import { useEffect, useRef, useState } from 'react';

import type { IrealSong } from './ireal-ast';

// Narrow subset of the `@chordsketch/wasm` module surface this hook
// touches. The actual module is dynamically imported at runtime so
// the wasm glue does not enter `@chordsketch/react`'s type graph.
// Keep in sync with the stub in `tests/helpers/wasm-stub.ts`.
interface IrealParser {
  default: () => Promise<unknown>;
  parseIrealb: (input: string) => string;
}

/** Result returned by {@link useIrealParse}. */
export interface UseIrealParseResult {
  /** Parsed song. `null` while wasm initialises, while a parse is in
   * flight, or after the most recent parse failed. */
  song: IrealSong | null;
  /** `true` while wasm is loading or a parse is in flight. */
  loading: boolean;
  /** Most recent parse / wasm-init error, or `null`. */
  error: Error | null;
}

/**
 * Injected wasm loader. Tests pass a structurally-compatible stub;
 * production callers take the default which lazy-loads `@chordsketch/wasm`.
 * @internal
 */
export type IrealWasmLoader = () => Promise<IrealParser>;

const defaultLoader: IrealWasmLoader = () =>
  import('@chordsketch/wasm') as Promise<IrealParser>;

/**
 * Parse an `irealb://` URL into an {@link IrealSong} via
 * `@chordsketch/wasm`'s `parseIrealb`. The wasm module is loaded once
 * per hook instance and reused across re-renders; the parse is
 * memoised against `source` so an unchanged input is not re-parsed.
 *
 * Errors are surfaced via the returned `error` state, not thrown —
 * the hook keeps the previous `song` visible so a transient invalid
 * URL does not blank the editor. Consumers decide whether to render
 * the error inline.
 */
export function useIrealParse(
  source: string,
  loader: IrealWasmLoader = defaultLoader,
): UseIrealParseResult {
  const [song, setSong] = useState<IrealSong | null>(null);
  // Start `loading: false` for an empty source — no wasm work
  // happens in that path, so consumers see a stable `false` rather
  // than a brief flicker of `true` on first render.
  const [loading, setLoading] = useState<boolean>(source.length > 0);
  const [error, setError] = useState<Error | null>(null);

  const parserRef = useRef<IrealParser | null>(null);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  useEffect(() => {
    let cancelled = false;

    const run = async (): Promise<void> => {
      // Skip the loading=true → loading=false flicker for empty
      // sources: no wasm work happens on this path, so consumers
      // should see a stable `false` from first render to settled
      // state. We still call the loader so the wasm module is
      // primed for a later non-empty source.
      const shouldParse = source.length > 0;
      if (shouldParse) setLoading(true);
      try {
        if (parserRef.current === null) {
          const mod = await loaderRef.current();
          await mod.default();
          parserRef.current = mod;
          if (cancelled) return;
        }
        const parser = parserRef.current;
        if (!shouldParse) {
          if (cancelled) return;
          setSong(null);
          setError(null);
          // Reset loading in case a prior run called setLoading(true)
          // and was then cancelled before it could call setLoading(false)
          // (e.g. source changed from non-empty to '' while wasm was
          // still initialising). Without this, loading is stuck at true.
          setLoading(false);
          return;
        }
        // Split the two failure modes so the surfaced error
        // distinguishes a user-input problem (`parseIrealb`
        // rejected the URL) from a wasm/JSON-contract bug
        // (`parseIrealb` returned a string `JSON.parse` cannot
        // load). The latter would never reach a consumer in
        // normal operation; surfacing it as a distinct
        // `Invalid AST JSON from wasm` message makes a real
        // contract bug noticeable in the field instead of
        // looking like ordinary user error.
        const json = parser.parseIrealb(source);
        let parsed: IrealSong;
        try {
          parsed = JSON.parse(json) as IrealSong;
        } catch (jsonError) {
          throw new Error(
            `Invalid AST JSON from @chordsketch/wasm.parseIrealb: ${
              jsonError instanceof Error ? jsonError.message : String(jsonError)
            }`,
          );
        }
        if (cancelled) return;
        setSong(parsed);
        setError(null);
      } catch (e) {
        if (cancelled) return;
        const err = e instanceof Error ? e : new Error(String(e));
        setError(err);
        // Deliberately keep the previous `song` so a transient
        // invalid edit does not blank the preview.
      } finally {
        if (!cancelled && shouldParse) {
          setLoading(false);
        }
      }
    };

    void run();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);

  return { song, loading, error };
}
