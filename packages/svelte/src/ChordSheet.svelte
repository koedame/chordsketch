<!--
@component
Flagship render component for the library. Renders ChordPro source
via `@chordsketch/wasm` and re-renders only when `source`,
`transpose`, `config` or `format` changes.

```svelte
<ChordSheet source={chordpro} transpose={2} />
```

Render path:
- `format="html"` injects the renderer's body-only fragment
  (`render_html_body`) into a `.chordsketch-sheet__content` wrapper,
  and injects the renderer's own stylesheet once — rewritten so
  every rule only matches inside that wrapper (see
  `renderer-css.ts`). The fragment is produced by our own Rust
  renderer from a fixed template, so injecting it as HTML is safe.
- `format="text"` renders the column-aligned plain output inside a
  `<pre>` with no HTML parsing.

Error handling: parse or render errors render through the `error`
snippet (default: an inline `role="alert"`); the component does not
throw. The previous successful output stays visible while a
transient error shows alongside, so a half-typed edit does not blank
the preview.

### Snippets

- `loading` — shown while WASM initialises and no output exists yet.
  Omit to render nothing.
- `error` — receives the `Error`. Pass an empty snippet to suppress
  the inline error entirely (e.g. when the host surfaces it through
  a toast).
-->
<script lang="ts">
  import { untrack, type Snippet } from 'svelte';
  import type { HTMLAttributes } from 'svelte/elements';

  import { SHEET_CONTENT_CLASS, ensureRendererCss } from './renderer-css';
  import {
    useChordRender,
    type ChordRenderFormat,
    type ChordWasmLoader,
  } from './use-chord-render.svelte';

  interface Props extends HTMLAttributes<HTMLDivElement> {
    /** ChordPro source to render. */
    source: string;
    /** Semitone transposition offset forwarded to the renderer. */
    transpose?: number;
    /**
     * Configuration preset name (e.g. `"guitar"`, `"ukulele"`) or
     * an inline RRJSON configuration string.
     */
    config?: string;
    /** Render target. Defaults to `"html"`. */
    format?: ChordRenderFormat;
    /** Shown while the WASM module loads and no output exists yet. */
    loading?: Snippet;
    /** Renders a render / init failure. Receives the `Error`. */
    error?: Snippet<[Error]>;
    /**
     * Test-only WASM loader override. Production callers never need
     * to supply this — the default lazy-loads `@chordsketch/wasm`.
     *
     * @internal
     */
    wasmLoader?: ChordWasmLoader;
  }

  let {
    source,
    transpose = undefined,
    config = undefined,
    format = 'html',
    loading: loadingSnippet = undefined,
    error: errorSnippet = undefined,
    wasmLoader = undefined,
    ...rest
  }: Props = $props();

  // Read once, deliberately: the loader identity keys the module
  // cache in `wasm-loader.ts`, so swapping it mid-life would
  // instantiate a second WASM module rather than re-render. Same
  // snapshot semantics as the React / Vue bindings.
  const loader = untrack(() => wasmLoader);

  const render = useChordRender(
    () => source,
    () => ({ format, transpose, config }),
    loader,
  );

  // The HTML fragment carries no styling of its own; pair it with
  // the renderer's stylesheet, scoped to this component's wrapper.
  // Runs once per (transpose, config) pair — `ensureRendererCss`
  // dedupes against what is already in the document.
  $effect(() => {
    if (format !== 'html') return;
    void ensureRendererCss({ transpose, config }, loader);
  });
</script>

<div
  {...rest}
  class={['chordsketch-sheet', rest.class]}
  aria-busy={render.loading ? 'true' : undefined}
>
  {#if render.error !== null}
    {#if errorSnippet}
      {@render errorSnippet(render.error)}
    {:else}
      <div role="alert" class="chordsketch-sheet__error">{render.error.message}</div>
    {/if}
  {/if}

  {#if render.output === null}
    {#if render.loading && loadingSnippet}
      {@render loadingSnippet()}
    {/if}
  {:else if format === 'text'}
    <pre class="chordsketch-sheet__text">{render.output}</pre>
  {:else}
    <div class={SHEET_CONTENT_CLASS}>
      {@html render.output}
    </div>
  {/if}
</div>
