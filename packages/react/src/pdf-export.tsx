import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { useCallback } from 'react';

import {
  type PdfExportOptions,
  type WasmLoader,
  usePdfExport,
} from './use-pdf-export';

/** Props accepted by the {@link PdfExport} button. */
export interface PdfExportProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick' | 'onError'> {
  /** ChordPro source to render. */
  source: string;
  /**
   * Filename suggested to the browser when the download anchor is
   * clicked. Defaults to `chordsketch-output.pdf` to match the
   * playground (`packages/ui-web/src/index.ts`) default.
   */
  filename?: string;
  /** Semitone transposition / config preset forwarded to the renderer. */
  options?: PdfExportOptions;
  /**
   * Button label. Defaults to `"Export PDF"`. Pass a component tree
   * (e.g. an icon + label) for richer styling.
   */
  children?: ReactNode;
  /**
   * Optional success callback, fired after the download is
   * initiated. Useful for analytics / toasts.
   */
  onExported?: (filename: string) => void;
  /**
   * Optional error callback, fired when `exportPdf` rejects. The
   * error is also surfaced via the internal `useState` so consumers
   * can render it from their own state if they prefer; this
   * callback is a convenience for imperative handlers
   * (e.g. `toast.error(...)`).
   */
  onError?: (error: Error) => void;
  /**
   * Test-only WASM loader override. Consumers never need to
   * supply this — the production default lazy-loads
   * `@chordsketch/wasm`. Hidden behind `@internal` so it does not
   * surface in the public API docs.
   *
   * @internal
   */
  wasmLoader?: WasmLoader;
}

/**
 * Button that renders `source` to PDF via `@chordsketch/wasm` and
 * triggers a browser download on click. While the render is in
 * flight the button is set `disabled` and `aria-busy="true"` so
 * assistive tech surfaces the loading state.
 *
 * ```tsx
 * <PdfExport source={chordpro} filename="song.pdf">
 *   Download PDF
 * </PdfExport>
 * ```
 *
 * For a bespoke UI (e.g. a dropdown menu that exports PDF as one
 * option), use {@link usePdfExport} directly instead.
 */
export function PdfExport({
  source,
  filename = 'chordsketch-output.pdf',
  options,
  children = 'Export PDF',
  onExported,
  onError,
  wasmLoader,
  disabled,
  ...buttonProps
}: PdfExportProps): JSX.Element {
  const { exportPdf, loading } = usePdfExport(wasmLoader);

  const handleClick = useCallback(() => {
    exportPdf(source, filename, options).then(
      () => onExported?.(filename),
      // `exportPdf` rejects after updating its internal `error`
      // state, so onError is purely a convenience hook; swallow
      // the rejection here to avoid the React "unhandled promise
      // rejection" warning for consumers that rely on the state
      // rather than a callback.
      (err: Error) => onError?.(err),
    );
  }, [exportPdf, source, filename, options, onExported, onError]);

  return (
    <button
      type="button"
      {...buttonProps}
      onClick={handleClick}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
    >
      {children}
    </button>
  );
}
