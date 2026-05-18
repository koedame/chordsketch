import { useEffect, useRef, useState } from 'react';

// Narrow subset of the `@chordsketch/wasm` module surface this hook
// touches. The actual module is dynamically imported at runtime.
interface IrealRenderer {
  default: () => Promise<unknown>;
  renderIrealSvg: (input: string) => string;
}

/** Result returned by {@link useIrealRender}. */
export interface UseIrealRenderResult {
  /** Rendered SVG markup, or `null` while wasm initialises / a
   * render is in flight / the most recent attempt failed. */
  svg: string | null;
  /** `true` while wasm is loading or a render is in flight. */
  loading: boolean;
  /** Most recent render / wasm-init error, or `null`. */
  error: Error | null;
}

/**
 * Injected wasm loader. Tests pass a structurally-compatible stub;
 * production callers take the default.
 * @internal
 */
export type IrealRenderLoader = () => Promise<IrealRenderer>;

const defaultLoader: IrealRenderLoader = () =>
  import('@chordsketch/wasm') as Promise<IrealRenderer>;

/**
 * Render an `irealb://` URL to SVG via `@chordsketch/wasm`'s
 * `renderIrealSvg`. The wasm module is loaded once per hook instance
 * and reused across re-renders; the render is memoised against
 * `source` so an unchanged input is not re-rendered.
 *
 * Errors surface via the returned `error` state, not thrown.
 */
export function useIrealRender(
  source: string,
  loader: IrealRenderLoader = defaultLoader,
): UseIrealRenderResult {
  const [svg, setSvg] = useState<string | null>(null);
  // Start `loading: false` for an empty source — no wasm work
  // happens in that path, so consumers see a stable `false` rather
  // than a brief flicker of `true` on first render.
  const [loading, setLoading] = useState<boolean>(source.length > 0);
  const [error, setError] = useState<Error | null>(null);

  const rendererRef = useRef<IrealRenderer | null>(null);
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
      const shouldRender = source.length > 0;
      if (shouldRender) setLoading(true);
      try {
        if (rendererRef.current === null) {
          const mod = await loaderRef.current();
          await mod.default();
          rendererRef.current = mod;
          if (cancelled) return;
        }
        const renderer = rendererRef.current;
        if (!shouldRender) {
          if (cancelled) return;
          setSvg(null);
          setError(null);
          return;
        }
        const rendered = renderer.renderIrealSvg(source);
        if (cancelled) return;
        setSvg(rendered);
        setError(null);
      } catch (e) {
        if (cancelled) return;
        const err = e instanceof Error ? e : new Error(String(e));
        setError(err);
        // Deliberately keep the previous `svg` so a transient
        // invalid edit does not blank the preview.
      } finally {
        if (!cancelled && shouldRender) {
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

  return { svg, loading, error };
}
