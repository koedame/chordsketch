import { useEffect, useRef, useState } from 'react';

import type { IrealSong } from './ireal-ast';

// Narrow subset of the `@chordsketch/wasm` module surface this hook
// touches. Mirrors `IrealParser` in `use-ireal-parse.ts`; merge if
// the surface ever needs additional methods. Kept in sync with
// `tests/helpers/wasm-stub.ts`.
interface IrealSerializer {
  default: () => Promise<unknown>;
  serializeIrealb: (json: string) => string;
}

/** Result returned by {@link useIrealSerialize}. */
export interface UseIrealSerializeResult {
  /** Serialised `irealb://` URL. `null` while wasm initialises,
   * while a serialise is in flight, or after the most recent
   * attempt failed. */
  url: string | null;
  /** `true` while wasm is loading or a serialise is in flight. */
  loading: boolean;
  /** Most recent serialise / wasm-init error, or `null`. */
  error: Error | null;
}

/**
 * Injected wasm loader. Tests pass a structurally-compatible stub;
 * production callers take the default which lazy-loads `@chordsketch/wasm`.
 * @internal
 */
export type IrealSerializeLoader = () => Promise<IrealSerializer>;

const defaultLoader: IrealSerializeLoader = () =>
  import('@chordsketch/wasm') as Promise<IrealSerializer>;

/**
 * Serialise an {@link IrealSong} into an `irealb://` URL via
 * `@chordsketch/wasm`'s `serializeIrealb`. The wasm module is loaded
 * once per hook instance and reused across re-renders.
 *
 * Errors are surfaced via the returned `error` state, not thrown.
 */
export function useIrealSerialize(
  song: IrealSong | null,
  loader: IrealSerializeLoader = defaultLoader,
): UseIrealSerializeResult {
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const serializerRef = useRef<IrealSerializer | null>(null);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  useEffect(() => {
    let cancelled = false;

    const run = async (): Promise<void> => {
      if (song === null) {
        setUrl(null);
        setError(null);
        setLoading(false);
        return;
      }
      setLoading(true);
      try {
        if (serializerRef.current === null) {
          const mod = await loaderRef.current();
          await mod.default();
          serializerRef.current = mod;
          if (cancelled) return;
        }
        const serializer = serializerRef.current;
        const serialised = serializer.serializeIrealb(JSON.stringify(song));
        if (cancelled) return;
        setUrl(serialised);
        setError(null);
      } catch (e) {
        if (cancelled) return;
        const err = e instanceof Error ? e : new Error(String(e));
        setError(err);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [song]);

  return { url, loading, error };
}
