import { useEffect, useRef } from 'react';
import type { MutableRefObject } from 'react';

/**
 * Minimal shape every lazily-loaded `@chordsketch/wasm` pitch module
 * shares: a wasm-bindgen `default` initialiser that must resolve before
 * any export is callable.
 */
export interface WasmInitModule {
  /** wasm-bindgen init — resolves once the module is ready to call. */
  default: () => Promise<unknown>;
}

/**
 * Lazily import and initialise a wasm module exposing pitch-lookup
 * functions, returning a ref to the loaded module — `null` until the load
 * resolves, on load failure, or while `supported` / `enabled` are `false`.
 *
 * Shared by {@link useChordAudio} and {@link useKeyAudio} so the
 * import / init / cancel logic lives in one place rather than being
 * duplicated across both hooks. The module is preloaded (rather than
 * imported inside `play`) so the consuming `play` can resolve pitches
 * synchronously inside the click / keydown gesture browser autoplay
 * policies require.
 *
 * `enabled` gates the import so a consumer that never turns the feature
 * on does not pay the wasm download; the load fires the first time
 * `enabled` becomes `true` while `supported`. If the load fails, the ref
 * stays `null` and the consumer degrades to a no-op rather than throwing.
 *
 * @internal
 */
export function usePitchModule<T extends WasmInitModule>(
  loader: () => Promise<T>,
  enabled: boolean,
  supported: boolean,
): MutableRefObject<T | null> {
  const moduleRef = useRef<T | null>(null);
  // Hold the loader in a ref so a caller passing an inline arrow does not
  // re-run the import effect on every render (the effect deps are the
  // booleans, not the loader identity).
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  useEffect(() => {
    if (!supported || !enabled) return undefined;
    let cancelled = false;
    void (async () => {
      try {
        const mod = await loaderRef.current();
        await mod.default();
        if (!cancelled) moduleRef.current = mod;
      } catch {
        // Leave moduleRef null; the consumer's play() degrades to a no-op.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [supported, enabled]);

  return moduleRef;
}
