import { computed, defineComponent, h, watchEffect, type PropType, type VNode } from 'vue';

import { SHEET_CONTENT_CLASS, ensureRendererCss } from './renderer-css';
import {
  useChordRender,
  type ChordRenderFormat,
  type ChordWasmLoader,
} from './use-chord-render';

/**
 * Flagship render component for the library. Renders ChordPro
 * source via `@chordsketch/wasm` and re-renders only when `source`,
 * `transpose`, `config` or `format` changes.
 *
 * ```vue
 * <ChordSheet :source="chordpro" :transpose="2" />
 * ```
 *
 * Render path:
 * - `format="html"` injects the renderer's body-only fragment
 *   (`render_html_body`) into a `.chordsketch-sheet__content`
 *   wrapper, and injects the renderer's own stylesheet once —
 *   rewritten so every rule only matches inside that wrapper (see
 *   `renderer-css.ts`). The fragment is produced by our own Rust
 *   renderer from a fixed template, so injecting it as HTML is
 *   safe.
 * - `format="text"` renders the column-aligned plain output inside
 *   a `<pre>` with no HTML parsing.
 *
 * Error handling: parse or render errors render through the `error`
 * slot (default: an inline `role="alert"`); the component does not
 * throw. The previous successful output stays visible while a
 * transient error shows alongside, so a half-typed edit does not
 * blank the preview.
 *
 * ### Slots
 *
 * - `loading` — shown while WASM initialises and no output exists
 *   yet. Omit to render nothing.
 * - `error` — scoped slot receiving `{ error }`. Pass an empty
 *   `<template #error />` to suppress the inline error entirely
 *   (e.g. when the host surfaces it through a toast).
 */
export const ChordSheet = defineComponent({
  name: 'ChordSheet',
  props: {
    /** ChordPro source to render. */
    source: { type: String, required: true },
    /** Semitone transposition offset forwarded to the renderer. */
    transpose: { type: Number, default: undefined },
    /**
     * Configuration preset name (e.g. `"guitar"`, `"ukulele"`) or
     * an inline RRJSON configuration string.
     */
    config: { type: String, default: undefined },
    /** Render target. Defaults to `"html"`. */
    format: { type: String as PropType<ChordRenderFormat>, default: 'html' },
    /**
     * Test-only WASM loader override. Production callers never need
     * to supply this — the default lazy-loads `@chordsketch/wasm`.
     *
     * @internal
     */
    wasmLoader: { type: Function as PropType<ChordWasmLoader>, default: undefined },
  },
  setup(props, { slots }) {
    const renderOptions = computed(() => ({
      format: props.format,
      transpose: props.transpose,
      config: props.config,
    }));
    const { output, loading, error } = useChordRender(
      () => props.source,
      renderOptions,
      props.wasmLoader,
    );

    // The HTML fragment carries no styling of its own; pair it with
    // the renderer's stylesheet, scoped to this component's wrapper.
    // Runs once per (config) value — `ensureRendererCss` dedupes
    // against what is already in the document.
    watchEffect(() => {
      if (props.format !== 'html') return;
      void ensureRendererCss(
        { transpose: props.transpose, config: props.config },
        props.wasmLoader,
      );
    });

    return () => {
      const children: VNode[] = [];

      if (error.value !== null) {
        children.push(
          ...(slots.error
            ? slots.error({ error: error.value })
            : [
                h(
                  'div',
                  { role: 'alert', class: 'chordsketch-sheet__error' },
                  error.value.message,
                ),
              ]),
        );
      }

      if (output.value === null) {
        if (loading.value && slots.loading) children.push(...slots.loading());
      } else if (props.format === 'text') {
        children.push(h('pre', { class: 'chordsketch-sheet__text' }, output.value));
      } else {
        children.push(
          h('div', { class: SHEET_CONTENT_CLASS, innerHTML: output.value }),
        );
      }

      return h(
        'div',
        {
          class: 'chordsketch-sheet',
          'aria-busy': loading.value ? 'true' : undefined,
        },
        children,
      );
    };
  },
});
