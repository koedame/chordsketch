import { ref, type Ref } from 'vue';

import { defaultWasmExportLoader, loadWasm } from './wasm-loader';

// The PDF / PNG renderer surface lives in the SEPARATE
// `@chordsketch/wasm-export` package (~10 MB raw / ~6.4 MB
// gzipped), not the lean `@chordsketch/wasm` (~400 KB raw / ~175 KB
// gzipped) used by `<ChordSheet>` for the parser + text/html
// surface. The split exists because the resvg / tiny-skia /
// svg2pdf / fontdb / harfrust transitive deps required for PDF /
// PNG output dominate the wasm binary weight. Loading via a dynamic
// `import()` keeps the Vue bundle free of the heavy WASM glue until
// a consumer actually triggers an export.
interface PdfRenderer {
  /**
   * Browser-build init function. Optional because the Node build
   * has none — see `wasm-loader.ts`, which owns the call.
   */
  default?: unknown;
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
   * error is written to the `error` ref before the promise settles,
   * so UIs that prefer state-driven rendering can ignore the
   * rejection (e.g. `exportPdf(...).catch(() => {})`) and render
   * from `error` instead.
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
  loading: Ref<boolean>;
  /**
   * The error thrown by the most recent `exportPdf` call, or `null`
   * if the last call succeeded or no call has been made yet. Set
   * before the returned promise rejects so error-rendering UIs
   * observe the value synchronously.
   */
  error: Ref<Error | null>;
}

/**
 * Injected renderer factory, for tests. Production callers never
 * need to supply this — the default points at
 * `@chordsketch/wasm-export`. Tests pass a hand-rolled stub that
 * returns a deterministic byte string without loading a real WASM
 * binary.
 *
 * @internal
 */
export type WasmLoader = () => Promise<PdfRenderer>;

/**
 * Composable that produces a `Promise<void>`-returning `exportPdf`
 * function together with `loading` / `error` refs. The WASM module
 * is loaded at most once per composable instance and reused across
 * calls.
 *
 * ```ts
 * const { exportPdf, loading, error } = usePdfExport();
 * // later:
 * await exportPdf(chordproSource, 'song.pdf');
 * ```
 *
 * ### Cache scope
 *
 * The initialised renderer is cached per loader (see
 * `wasm-loader.ts`), so every consumer taking the default loader
 * shares one instantiation of the ~10 MB export bundle, however many
 * `usePdfExport()` call sites the app has.
 *
 * @param loader Optional WASM loader — pass a stub in tests. Do not
 *   supply one in production; the default loads
 *   `@chordsketch/wasm-export` lazily.
 */
export function usePdfExport(loader: WasmLoader = defaultWasmExportLoader): UsePdfExportResult {
  const loading = ref(false);
  const error = ref<Error | null>(null);

  const exportPdf = async (
    source: string,
    filename: string,
    options?: PdfExportOptions,
  ): Promise<void> => {
    loading.value = true;
    error.value = null;
    try {
      const renderer = await loadWasm(loader);
      const bytes =
        options !== undefined &&
        (options.transpose !== undefined || options.config !== undefined)
          ? renderer.render_pdf_with_options(source, options)
          : renderer.render_pdf(source);
      triggerDownload(bytes, filename);
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      error.value = err;
      throw err;
    } finally {
      loading.value = false;
    }
  };

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
  // The `as BlobPart` cast works around TypeScript's narrower
  // `BlobPart` definition: `Uint8Array<ArrayBufferLike>` technically
  // includes `SharedArrayBuffer`, which is not a `BlobPart` in the
  // lib.dom.d.ts shipped with TS >= 5.7. The narrowing is a
  // type-system artefact — the runtime accepts any `ArrayBufferView`,
  // which `Uint8Array` always is.
  const blob = new Blob([bytes as BlobPart], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    // Appending to the document is required in some browsers
    // (notably Firefox) for `click()` to actually dispatch the
    // download event. Removing the element after the click keeps
    // the DOM clean.
    document.body.appendChild(a);
    try {
      a.click();
    } finally {
      // Inner `finally` — remove the anchor even if `click()`
      // throws, so an unusual browser state does not leak the DOM
      // node. The outer `finally` still revokes the object URL
      // after removal.
      a.remove();
    }
  } finally {
    URL.revokeObjectURL(url);
  }
}
