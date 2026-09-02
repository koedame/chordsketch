import {
  computed,
  defineComponent,
  getCurrentInstance,
  h,
  ref,
  watch,
  type PropType,
  type Slot,
} from 'vue';

import { ChordSheet } from './chord-sheet';
import type { ChordRenderFormat, ChordWasmLoader } from './use-chord-render';
import { useDebounced } from './use-debounced';

// Minimal `process.env.NODE_ENV` typing so the package does not pull
// in `@types/node` for a single dev-only reference. The exact
// `process.env.NODE_ENV` token is required — bundlers (esbuild,
// Rollup, Vite, webpack DefinePlugin) replace it at build time and a
// helper that accessed it via `globalThis.process` would not match
// the substitution pattern, so production builds would still carry
// the warning code path.
declare const process: { env: { NODE_ENV?: string } };

/**
 * Split-pane `<textarea>` editor with a built-in live preview pane.
 * Pair it with `<ChordSheet>` alone if you only need the preview.
 *
 * The editor is a plain `<textarea>` deliberately — richer surfaces
 * (syntax highlighting, CodeMirror) can be layered on top without
 * changing this component's contract, because the public API only
 * promises a string value and its `update:modelValue` event. The
 * preview re-renders a debounced copy of the source through
 * `<ChordSheet>`, so typing does not stall the UI.
 *
 * Supports `v-model` (controlled) and an uncontrolled mode: omit
 * `modelValue` and pass `defaultValue`, and the component keeps the
 * text in its own state while still emitting `update:modelValue` on
 * every keystroke.
 *
 * `Ctrl`/`Cmd` + `ArrowUp` / `ArrowDown` emit `update:transpose`
 * with the next value clamped into `[transposeMin, transposeMax]`,
 * so the component binds directly to `v-model:transpose`. The
 * shortcut only intercepts the keystroke when a listener is bound —
 * otherwise the browser's own text navigation is left alone.
 *
 * ```vue
 * <ChordTextarea v-model="source" v-model:transpose="transpose" />
 * ```
 */
export const ChordTextarea = defineComponent({
  name: 'ChordTextarea',
  props: {
    /**
     * Controlled value (`v-model`). When set, the component does not
     * manage its own state — update it from the parent on every
     * `update:modelValue`.
     */
    modelValue: { type: String, default: undefined },
    /**
     * Initial value for uncontrolled usage. Ignored when
     * `modelValue` is supplied. Defaults to the empty string.
     */
    defaultValue: { type: String, default: '' },
    /**
     * Semitone transposition offset forwarded to the preview pane.
     * The editor text itself is never transposed — this affects only
     * how the preview renders the source.
     */
    transpose: { type: Number, default: 0 },
    /** Configuration preset name or inline RRJSON forwarded to the preview. */
    config: { type: String, default: undefined },
    /** Preview render format. Defaults to `"html"`. See `<ChordSheet>`. */
    previewFormat: { type: String as PropType<ChordRenderFormat>, default: 'html' },
    /** Disables editing and focuses the preview as the primary surface. */
    readOnly: { type: Boolean, default: false },
    /**
     * Debounce window in milliseconds for the preview re-render.
     * Defaults to `250` ms. Set to `0` to re-render synchronously on
     * every keystroke (useful for tests).
     */
    debounceMs: { type: Number, default: 250 },
    /** Placeholder shown when the editor is empty. */
    placeholder: { type: String, default: 'Enter ChordPro source here…' },
    /**
     * Accessible name forwarded to the editor textarea as
     * `aria-label`. Defaults to `"ChordPro editor"`. Placeholders are
     * not accessible names per WAI-ARIA 1.2 §5.2.8, so the default is
     * applied even when {@link placeholder} is supplied.
     */
    textareaAriaLabel: { type: String, default: 'ChordPro editor' },
    /** Minimum transpose offset the keyboard shortcuts will emit. Defaults to `-11`. */
    transposeMin: { type: Number, default: -11 },
    /** Maximum transpose offset the keyboard shortcuts will emit. Defaults to `11`. */
    transposeMax: { type: Number, default: 11 },
    /**
     * Test-only WASM loader override forwarded to `<ChordSheet>`.
     * Production callers never need to supply this.
     *
     * @internal
     */
    wasmLoader: { type: Function as PropType<ChordWasmLoader>, default: undefined },
  },
  emits: {
    'update:modelValue': (value: string) => typeof value === 'string',
    'update:transpose': (value: number) => typeof value === 'number',
  },
  setup(props, { emit, slots }) {
    const isControlled = computed(() => props.modelValue !== undefined);
    const internal = ref<string>(props.modelValue ?? props.defaultValue);
    const current = computed(() => (isControlled.value ? props.modelValue! : internal.value));
    const debounced = useDebounced(current, () => props.debounceMs);

    // Dev-only warning if a caller flips the component between
    // controlled and uncontrolled mid-lifetime, mirroring the
    // warning React's own form controls emit — the two modes own the
    // value in different places, so switching silently drops edits.
    watch(isControlled, (now, before) => {
      if (process.env.NODE_ENV === 'production') return;
      // eslint-disable-next-line no-console
      console.error(
        `Warning: A component is changing ${before ? 'a controlled' : 'an uncontrolled'} ` +
          `<ChordTextarea> to be ${now ? 'controlled' : 'uncontrolled'}. <ChordTextarea> should ` +
          'not switch between controlled and uncontrolled (or vice versa) during its lifetime. ' +
          'Decide between using a controlled or uncontrolled <ChordTextarea> for the lifetime ' +
          'of the component.',
      );
    });

    // Dev-only warning + defensive swap: callers occasionally pass an
    // inverted bound pair (`transposeMin > transposeMax`) which would
    // otherwise propagate to `Math.min` / `Math.max` and silently
    // disable the shortcuts.
    watch(
      () => [props.transposeMin, props.transposeMax] as const,
      ([min, max]) => {
        if (process.env.NODE_ENV === 'production') return;
        if (min > max) {
          // eslint-disable-next-line no-console
          console.error(
            `Warning: <ChordTextarea> received transposeMin (${min}) > transposeMax (${max}). ` +
              'The bounds will be swapped to keep the control usable, but the caller should ' +
              'pass min ≤ max.',
          );
        }
      },
      { immediate: true },
    );

    const effectiveMin = computed(() => Math.min(props.transposeMin, props.transposeMax));
    const effectiveMax = computed(() => Math.max(props.transposeMin, props.transposeMax));
    const clampedTranspose = computed(() => {
      if (props.transpose < effectiveMin.value) return effectiveMin.value;
      if (props.transpose > effectiveMax.value) return effectiveMax.value;
      return props.transpose;
    });

    // Whether the host bound `v-model:transpose` / `@update:transpose`.
    // Declared emits are stripped from `attrs`, so the raw vnode props
    // are the only place the listener is visible — and the shortcut
    // must not swallow `Ctrl+ArrowUp/Down` (paragraph navigation in
    // Firefox) for hosts that never asked for it.
    const instance = getCurrentInstance();
    const hasTransposeListener = (): boolean =>
      instance?.vnode.props?.['onUpdate:transpose'] !== undefined;

    const onInput = (event: Event): void => {
      const next = (event.target as HTMLTextAreaElement).value;
      if (!isControlled.value) internal.value = next;
      emit('update:modelValue', next);
    };

    const onKeydown = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey)) return;
      if (!hasTransposeListener()) return;
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        const next = Math.min(effectiveMax.value, clampedTranspose.value + 1);
        if (next !== clampedTranspose.value) emit('update:transpose', next);
      } else if (event.key === 'ArrowDown') {
        event.preventDefault();
        const next = Math.max(effectiveMin.value, clampedTranspose.value - 1);
        if (next !== clampedTranspose.value) emit('update:transpose', next);
      }
    };

    // Forward only the slots the host actually supplied, so
    // `<ChordSheet>` still falls back to its own defaults otherwise.
    const previewSlots = (): Record<string, Slot> => {
      const forwarded: Record<string, Slot> = {};
      if (slots.loading) forwarded.loading = slots.loading;
      if (slots.error) forwarded.error = slots.error;
      return forwarded;
    };

    return () =>
      h('div', { class: 'chordsketch-textarea' }, [
        h('textarea', {
          class: 'chordsketch-textarea__textarea',
          value: current.value,
          onInput,
          onKeydown,
          readonly: props.readOnly,
          placeholder: props.placeholder,
          'aria-label': props.textareaAriaLabel,
          spellcheck: 'false',
          // Disabling the form-assist attributes stops browser UI
          // (spell-check underlines, auto-capitalise, autocorrect
          // prompts) from interfering with ChordPro source — almost
          // every token in a ChordPro file is either a chord
          // shorthand or a directive name that fails every English
          // dictionary check.
          autocorrect: 'off',
          autocapitalize: 'off',
          autocomplete: 'off',
        }),
        h('div', { class: 'chordsketch-textarea__preview' }, [
          h(
            ChordSheet,
            {
              source: debounced.value,
              transpose: clampedTranspose.value,
              config: props.config,
              format: props.previewFormat,
              wasmLoader: props.wasmLoader,
            },
            previewSlots(),
          ),
        ]),
      ]);
  },
});
