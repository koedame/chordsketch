<!--
@component
Split-pane `<textarea>` editor with a built-in live preview pane.
Pair it with `<ChordSheet>` alone if you only need the preview.

The editor is a plain `<textarea>` deliberately — richer surfaces
(syntax highlighting, CodeMirror) can be layered on top without
changing this component's contract, because the public API only
promises a bindable string.

The preview re-renders a debounced copy of the source through
`<ChordSheet>`, so typing does not stall the UI.

`Ctrl`/`Cmd` + `ArrowUp` / `ArrowDown` moves `transpose` one semitone
within `[transposeMin, transposeMax]`. The offset always drives the
preview, whether or not the host binds it:

```svelte
<ChordTextarea bind:value={source} bind:transpose />
```
-->
<script lang="ts">
  import { DEV } from 'esm-env';
  import type { Snippet } from 'svelte';
  import type { HTMLAttributes } from 'svelte/elements';

  import ChordSheet from './ChordSheet.svelte';
  import type { ChordRenderFormat, ChordWasmLoader } from './use-chord-render.svelte';
  import { useDebounced } from './use-debounced.svelte';

  interface Props extends HTMLAttributes<HTMLDivElement> {
    /** ChordPro source. Bindable; defaults to the empty string. */
    value?: string;
    /**
     * Semitone transposition offset forwarded to the preview pane,
     * and the value the keyboard shortcuts move. Bindable. The
     * editor text itself is never transposed — this affects only how
     * the preview renders the source.
     */
    transpose?: number;
    /** Configuration preset name or inline RRJSON forwarded to the preview. */
    config?: string;
    /** Preview render format. Defaults to `"html"`. See `<ChordSheet>`. */
    previewFormat?: ChordRenderFormat;
    /** Disables editing and focuses the preview as the primary surface. */
    readOnly?: boolean;
    /**
     * Debounce window in milliseconds for the preview re-render.
     * Defaults to `250` ms. Set to `0` to re-render on the next tick
     * after every keystroke (useful for tests).
     */
    debounceMs?: number;
    /** Placeholder shown when the editor is empty. */
    placeholder?: string;
    /**
     * Accessible name forwarded to the editor textarea as
     * `aria-label`. Defaults to `"ChordPro editor"`. Placeholders are
     * not accessible names per WAI-ARIA 1.2 §5.2.8, so the default is
     * applied even when {@link Props.placeholder} is supplied.
     */
    textareaAriaLabel?: string;
    /** Minimum transpose offset the keyboard shortcuts will emit. Defaults to `-11`. */
    transposeMin?: number;
    /** Maximum transpose offset the keyboard shortcuts will emit. Defaults to `11`. */
    transposeMax?: number;
    /** Forwarded to the preview `<ChordSheet>`. */
    loading?: Snippet;
    /** Forwarded to the preview `<ChordSheet>`. Receives the `Error`. */
    error?: Snippet<[Error]>;
    /**
     * Test-only WASM loader override forwarded to `<ChordSheet>`.
     * Production callers never need to supply this.
     *
     * @internal
     */
    wasmLoader?: ChordWasmLoader;
  }

  let {
    value = $bindable(''),
    transpose = $bindable(0),
    config = undefined,
    previewFormat = 'html',
    readOnly = false,
    debounceMs = 250,
    placeholder = 'Enter ChordPro source here…',
    textareaAriaLabel = 'ChordPro editor',
    transposeMin = -11,
    transposeMax = 11,
    loading: loadingSnippet = undefined,
    error: errorSnippet = undefined,
    wasmLoader = undefined,
    ...rest
  }: Props = $props();

  const debounced = useDebounced(
    () => value,
    () => debounceMs,
  );

  // Dev-only warning + defensive swap: callers occasionally pass an
  // inverted bound pair (`transposeMin > transposeMax`) which would
  // otherwise propagate to `Math.min` / `Math.max` and silently
  // disable the shortcuts.
  $effect(() => {
    if (!DEV) return;
    if (transposeMin > transposeMax) {
      // eslint-disable-next-line no-console
      console.error(
        `Warning: <ChordTextarea> received transposeMin (${transposeMin}) > transposeMax ` +
          `(${transposeMax}). The bounds will be swapped to keep the control usable, but the ` +
          'caller should pass min ≤ max.',
      );
    }
  });

  const effectiveMin = $derived(Math.min(transposeMin, transposeMax));
  const effectiveMax = $derived(Math.max(transposeMin, transposeMax));
  const clampedTranspose = $derived(
    transpose < effectiveMin ? effectiveMin : transpose > effectiveMax ? effectiveMax : transpose,
  );

  function onkeydown(event: KeyboardEvent): void {
    if (!(event.ctrlKey || event.metaKey)) return;
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      transpose = Math.min(effectiveMax, clampedTranspose + 1);
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      transpose = Math.max(effectiveMin, clampedTranspose - 1);
    }
  }
</script>

<div {...rest} class={['chordsketch-textarea', rest.class]}>
  <!-- The form-assist attributes are disabled so browser UI
       (spell-check underlines, auto-capitalise, autocorrect prompts)
       does not interfere with ChordPro source — almost every token in
       a ChordPro file is either a chord shorthand or a directive name
       that fails every English dictionary check. -->
  <textarea
    class="chordsketch-textarea__textarea"
    bind:value
    {onkeydown}
    readonly={readOnly}
    {placeholder}
    aria-label={textareaAriaLabel}
    spellcheck="false"
    autocorrect="off"
    autocapitalize="off"
    autocomplete="off"
  ></textarea>
  <div class="chordsketch-textarea__preview">
    <ChordSheet
      source={debounced.current}
      transpose={clampedTranspose}
      {config}
      format={previewFormat}
      {wasmLoader}
      loading={loadingSnippet}
      error={errorSnippet}
    />
  </div>
</div>
