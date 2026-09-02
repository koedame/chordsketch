<!--
@component
Button that renders `source` to PDF via `@chordsketch/wasm-export`
and triggers a browser download on click. While the render is in
flight the button is `disabled` and `aria-busy="true"` so assistive
tech surfaces the loading state. If the render rejects, a
`role="alert"` inline error renders below the button.

```svelte
<PdfExport source={chordpro} filename="song.pdf" onExported={toast} />
```

For a bespoke UI (e.g. a dropdown menu that exports PDF as one
option), use `usePdfExport` directly instead.

### Snippets

- `children` — button label. Defaults to `PDF_EXPORT_DEFAULT_LABEL`.
- `error` — receives the `Error`, replacing the inline
  `role="alert"`. Pass an empty snippet to suppress it entirely
  (useful when the host surfaces the failure through `onError` plus
  a toast).
-->
<script lang="ts" module>
  /**
   * Default label rendered when a `<PdfExport>` consumer passes no
   * `children` snippet. Exported so sister sites that compose their
   * own export button render the same string without restating the
   * literal.
   */
  export const PDF_EXPORT_DEFAULT_LABEL = 'Export PDF';
</script>

<script lang="ts">
  import { untrack, type Snippet } from 'svelte';
  import type { HTMLButtonAttributes } from 'svelte/elements';

  import {
    usePdfExport,
    type PdfExportOptions,
    type WasmLoader,
  } from './use-pdf-export.svelte';

  interface Props extends Omit<HTMLButtonAttributes, 'children'> {
    /** ChordPro source to render. */
    source: string;
    /**
     * Filename suggested to the browser when the download anchor is
     * clicked. Defaults to `chordsketch-output.pdf`.
     */
    filename?: string;
    /** Semitone transposition / config preset forwarded to the renderer. */
    options?: PdfExportOptions;
    /** Disables the button independently of the loading state. */
    disabled?: boolean;
    /** Called after the download has been initiated. */
    onExported?: (filename: string) => void;
    /** Called when the render rejects. */
    onError?: (error: Error) => void;
    /** Button label. Defaults to {@link PDF_EXPORT_DEFAULT_LABEL}. */
    children?: Snippet;
    /** Replaces the inline error. Receives the `Error`. */
    error?: Snippet<[Error]>;
    /**
     * Test-only WASM loader override. Consumers never need to supply
     * this — the production default lazy-loads
     * `@chordsketch/wasm-export` (the heavy bundle that owns the PDF
     * renderer surface).
     *
     * @internal
     */
    wasmLoader?: WasmLoader;
  }

  let {
    source,
    filename = 'chordsketch-output.pdf',
    options = undefined,
    disabled = false,
    onExported = undefined,
    onError = undefined,
    children = undefined,
    error: errorSnippet = undefined,
    wasmLoader = undefined,
    ...rest
  }: Props = $props();

  // Snapshot — see the same note in `ChordSheet.svelte`.
  const pdf = usePdfExport(untrack(() => wasmLoader));

  function onclick(): void {
    pdf.exportPdf(source, filename, options).then(
      () => onExported?.(filename),
      // `exportPdf` rejects after updating its own `error` state, so
      // the callback is a convenience for imperative handlers;
      // swallow the rejection here to avoid an unhandled promise
      // rejection for consumers that render from state instead.
      (err: Error) => onError?.(err),
    );
  }
</script>

<button
  type="button"
  {...rest}
  {onclick}
  disabled={disabled || pdf.loading}
  aria-busy={pdf.loading ? 'true' : undefined}
>
  {#if children}
    {@render children()}
  {:else}
    {PDF_EXPORT_DEFAULT_LABEL}
  {/if}
</button>

{#if pdf.error !== null}
  {#if errorSnippet}
    {@render errorSnippet(pdf.error)}
  {:else}
    <div role="alert" class="chordsketch-pdf-export__error">{pdf.error.message}</div>
  {/if}
{/if}
