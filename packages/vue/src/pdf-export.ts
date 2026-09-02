import { defineComponent, h, type PropType, type VNode } from 'vue';

import {
  usePdfExport,
  type PdfExportOptions,
  type WasmLoader,
} from './use-pdf-export';

/**
 * Default label rendered when a {@link PdfExport} consumer passes no
 * default slot. Exported so sister sites that compose their own
 * export button render the same string without restating the
 * literal.
 */
export const PDF_EXPORT_DEFAULT_LABEL = 'Export PDF';

/**
 * Button that renders `source` to PDF via `@chordsketch/wasm-export`
 * and triggers a browser download on click. While the render is in
 * flight the button is `disabled` and `aria-busy="true"` so
 * assistive tech surfaces the loading state. If the render rejects,
 * a `role="alert"` inline error renders below the button.
 *
 * ```vue
 * <PdfExport :source="chordpro" filename="song.pdf" @exported="toast" />
 * ```
 *
 * For a bespoke UI (e.g. a dropdown menu that exports PDF as one
 * option), use {@link usePdfExport} directly instead.
 *
 * ### Slots
 *
 * - default — button label. Defaults to
 *   {@link PDF_EXPORT_DEFAULT_LABEL}.
 * - `error` — scoped slot receiving `{ error }`, replacing the inline
 *   `role="alert"`. Pass an empty `<template #error />` to suppress
 *   it entirely (useful when the host surfaces the failure through
 *   the `error` event plus a toast).
 */
export const PdfExport = defineComponent({
  name: 'PdfExport',
  // The error branch renders a fragment (button + alert), which has
  // no single root for Vue to apply fallthrough attributes to. Bind
  // them to the button explicitly so `class` / `id` / `data-*` land
  // on the control in both branches.
  inheritAttrs: false,
  props: {
    /** ChordPro source to render. */
    source: { type: String, required: true },
    /**
     * Filename suggested to the browser when the download anchor is
     * clicked. Defaults to `chordsketch-output.pdf`.
     */
    filename: { type: String, default: 'chordsketch-output.pdf' },
    /** Semitone transposition / config preset forwarded to the renderer. */
    options: { type: Object as PropType<PdfExportOptions>, default: undefined },
    /** Disables the button independently of the loading state. */
    disabled: { type: Boolean, default: false },
    /**
     * Test-only WASM loader override. Consumers never need to supply
     * this — the production default lazy-loads
     * `@chordsketch/wasm-export` (the heavy bundle that owns the PDF
     * renderer surface).
     *
     * @internal
     */
    wasmLoader: { type: Function as PropType<WasmLoader>, default: undefined },
  },
  emits: {
    /** Fired after the download has been initiated. */
    exported: (filename: string) => typeof filename === 'string',
    /** Fired when the render rejects. */
    error: (error: Error) => error instanceof Error,
  },
  setup(props, { attrs, emit, slots }) {
    const { exportPdf, loading, error } = usePdfExport(props.wasmLoader);

    const onClick = (): void => {
      exportPdf(props.source, props.filename, props.options).then(
        () => emit('exported', props.filename),
        // `exportPdf` rejects after updating its own `error` ref, so
        // the event is a convenience for imperative handlers;
        // swallow the rejection here to avoid an unhandled promise
        // rejection for consumers that render from state instead.
        (err: Error) => emit('error', err),
      );
    };

    return () => {
      const button = h(
        'button',
        {
          type: 'button',
          ...attrs,
          onClick,
          disabled: props.disabled || loading.value,
          'aria-busy': loading.value ? 'true' : undefined,
        },
        slots.default ? slots.default() : PDF_EXPORT_DEFAULT_LABEL,
      );

      if (error.value === null) return button;

      const alert: VNode[] = slots.error
        ? slots.error({ error: error.value })
        : [
            h(
              'div',
              { role: 'alert', class: 'chordsketch-pdf-export__error' },
              error.value.message,
            ),
          ];
      // Fragment so the alert renders as a sibling without altering
      // the button's position in the host layout.
      return [button, ...alert];
    };
  },
});
