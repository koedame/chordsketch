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
   * Optional render prop that takes over the default inline
   * `role="alert"` error rendering when the most recent
   * `exportPdf` call rejected. Receives the `Error` instance;
   * return any `ReactNode`. Pass `null` to suppress the inline
   * error entirely (useful when the host surfaces the error via
   * `onError` + a toast). Defaults to a minimal `role="alert"`
   * div containing `error.message`.
   *
   * The inline error addresses a silent-failure surface: prior
   * to this prop, a `<PdfExport>` button whose render rejected
   * would re-enable itself with no user-visible indication that
   * the click had failed — only the `onError` callback fired, and
   * consumers that did not wire one (e.g. `<RendererPreview
   * format="pdf">`) swallowed the error silently.
   */
  errorFallback?: ((error: Error) => ReactNode) | null;
  /**
   * Test-only WASM loader override. Consumers never need to
   * supply this — the production default lazy-loads
   * `@chordsketch/wasm-export` (the heavy bundle that owns the
   * PDF / PNG renderer surface; see use-pdf-export.ts). Hidden
   * behind `@internal` so it does not surface in the public API
   * docs.
   *
   * @internal
   */
  wasmLoader?: WasmLoader;
}

function defaultPdfErrorFallback(error: Error): ReactNode {
  return (
    <div role="alert" className="chordsketch-pdf-export__error">
      {error.message}
    </div>
  );
}

/**
 * Button that renders `source` to PDF via `@chordsketch/wasm-export` and
 * triggers a browser download on click. While the render is in
 * flight the button is set `disabled` and `aria-busy="true"` so
 * assistive tech surfaces the loading state. If the render rejects,
 * a `role="alert"` inline error renders below the button — see the
 * {@link PdfExportProps.errorFallback} prop to customise or suppress.
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
  errorFallback = defaultPdfErrorFallback,
  wasmLoader,
  disabled,
  ...buttonProps
}: PdfExportProps): JSX.Element {
  const { exportPdf, loading, error } = usePdfExport(wasmLoader);

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

  const button = (
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

  // When there is no error to render AND the consumer hasn't opted
  // out of the inline error rendering, return just the button so the
  // common no-error path matches the pre-#2534 DOM shape exactly —
  // wrapping every export in a `<span>` would force consumers to
  // re-target CSS selectors. The error branch wraps in a fragment so
  // the `role="alert"` region renders as a sibling without altering
  // the button's position in the layout.
  if (error === null || errorFallback === null) {
    return button;
  }

  return (
    <>
      {button}
      {errorFallback(error)}
    </>
  );
}
