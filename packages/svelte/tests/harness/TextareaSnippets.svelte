<!--
Test harness: the `loading` / `error` snippets `<ChordTextarea>`
forwards to its preview pane.
-->
<script lang="ts">
  import ChordTextarea from '../../src/ChordTextarea.svelte';
  import type { ChordWasmLoader } from '../../src/use-chord-render.svelte';

  let {
    value = '',
    wasmLoader,
  }: {
    value?: string;
    wasmLoader?: ChordWasmLoader;
  } = $props();
</script>

<ChordTextarea {value} debounceMs={0} {wasmLoader}>
  {#snippet loading()}
    <p>Rendering…</p>
  {/snippet}
  {#snippet error(failure)}
    <p>failed: {failure.message}</p>
  {/snippet}
</ChordTextarea>
