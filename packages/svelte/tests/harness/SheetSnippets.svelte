<!--
Test harness: `<ChordSheet>` with the `loading` and `error` snippets
a consumer would write.
-->
<script lang="ts">
  import ChordSheet from '../../src/ChordSheet.svelte';
  import type { ChordRenderFormat, ChordWasmLoader } from '../../src/use-chord-render.svelte';

  let {
    source,
    format = 'html',
    wasmLoader,
  }: {
    source: string;
    format?: ChordRenderFormat;
    wasmLoader?: ChordWasmLoader;
  } = $props();
</script>

<ChordSheet {source} {format} {wasmLoader}>
  {#snippet loading()}
    <p>Rendering…</p>
  {/snippet}
  {#snippet error(failure)}
    <p>failed: {failure.message}</p>
  {/snippet}
</ChordSheet>
