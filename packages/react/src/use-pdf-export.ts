import { useCallback, useRef, useState } from 'react';

// The `@chordsketch/wasm` surface is loaded lazily (browser build
// requires `await init()` before the first render call). Importing
// via a dynamic `import()` keeps the React bundle free of the WASM
// glue code until a consumer actually triggers an export.
//
// The narrow type declared here is deliberately structural rather
// than a direct re-export from `@chordsketch/wasm` — typing it with
// the real module shape would pull the WASM package into the
// library's build graph, which defeats the lazy-loading point. The
// shape is pinned to the subset that `exportPdf` actually touches
// (`default`, `render_pdf`, `render_pdf_with_options`) so the
// contract with the WASM API is still explicit at the boundary.
interface PdfRenderer {
  default: () => Promise<unknown>;
  render_pdf: (input: string) => Uint8Array;
  render_pdf_with_options: (
    input: string,
    options: { transpose?: number; config?: string },
  ) => Uint8Array;
}

/** Extra options forwarded to the underlying WASM PDF renderer. */
export interface PdfExportOptions {
  /**
   * Semitone transposition offset, reduced modulo 12 by the
   * renderer. Omitted or zero → no transposition is applied.
   */
  transpose?: number;
  /**
   * Configuration preset name (e.g. `"guitar"`, `"ukulele"`) or an
   * inline RRJSON configuration string.
   */
  config?: string;
}

/** Value returned by {@link usePdfExport}. */
export interface UsePdfExportResult {
  /**
   * Render the given ChordPro `source` to PDF and trigger a browser
   * download using `filename` as the suggested name. Resolves when
   * the download has been initiated (the anchor element clicked);
   * **rejects** if the WASM init or render call throws. The same
   * error is written to the `error` state before the promise
   * settles, so UIs that prefer state-driven rendering can ignore
   * the rejection (e.g. `exportPdf(...).catch(() => {})`) and
   * render from `error` instead.
   */
  exportPdf: (
    source: string,
    filename: string,
    options?: PdfExportOptions,
  ) => Promise<void>;
  /**
   * `true` between the moment `exportPdf` starts and the moment it
   * settles (resolve or reject). Use for spinners / disabled button
   * states; the state resets on every call, so UIs do not need to
   * debounce.
   */
  loading: boolean;
  /**
   * The error thrown by the most recent `exportPdf` call, or `null`
   * if the last call succeeded or no call has been made yet. Set
   * before the returned promise rejects so error-rendering UIs
   * observe the value synchronously via React's state update.
   */
  error: Error | null;
}

/**
 * Injected renderer factory, for tests. Production callers never
 * need to supply this — the default points at
 * `@chordsketch/wasm`. Tests pass a hand-rolled stub that returns
 * a deterministic byte string without loading a real WASM binary.
 *
 * @internal
 */
export type WasmLoader = () => Promise<PdfRenderer>;

const defaultLoader: WasmLoader = () =>
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  import('@chordsketch/wasm') as Promise<PdfRenderer>;

/**
 * React hook that produces a `Promise<void>`-returning `exportPdf`
 * function together with `loading` / `error` state. The WASM module
 * is loaded at most once per hook instance and reused across calls.
 *
 * ```ts
 * const { exportPdf, loading, error } = usePdfExport();
 * // later:
 * await exportPdf(chordproSource, 'song.pdf');
 * ```
 *
 * @param loader Optional WASM loader — pass a stub in tests. Do not
 *   supply one in production; the default loads `@chordsketch/wasm`
 *   lazily.
 */
export function usePdfExport(loader: WasmLoader = defaultLoader): UsePdfExportResult {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  // Cache the initialised renderer across invocations so repeated
  // exports do not re-run WASM init. `useRef` is appropriate (not
  // `useState`) because the value is plain cache that does not need
  // to drive re-renders — writing to `.current` is a side effect,
  // not a state transition.
  const rendererRef = useRef<PdfRenderer | null>(null);

  const exportPdf = useCallback(
    async (
      source: string,
      filename: string,
      options?: PdfExportOptions,
    ): Promise<void> => {
      setLoading(true);
      setError(null);
      try {
        if (rendererRef.current === null) {
          const mod = await loader();
          // `init()` is a no-op on the Node.js build of
          // `@chordsketch/wasm` (the module auto-loads in Node) and
          // required on the browser build. Calling it
          // unconditionally keeps the hook runtime-agnostic.
          await mod.default();
          rendererRef.current = mod;
        }
        const renderer = rendererRef.current;
        const bytes =
          options !== undefined && (options.transpose !== undefined || options.config !== undefined)
            ? renderer.render_pdf_with_options(source, options)
            : renderer.render_pdf(source);
        triggerDownload(bytes, filename);
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        setError(err);
        throw err;
      } finally {
        setLoading(false);
      }
    },
    [loader],
  );

  return { exportPdf, loading, error };
}

/**
 * Turn a PDF byte array into a downloaded file. Exported for tests
 * that want to assert on the download side of the flow without
 * going through the WASM renderer.
 *
 * @internal
 */
export function triggerDownload(bytes: Uint8Array, filename: string): void {
  const blob = new Blob([bytes as BlobPart], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    // Appending to the document is required in some browsers (notably
    // Firefox) for `click()` to actually dispatch the download event.
    // Removing the element after the click keeps the DOM clean.
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}
