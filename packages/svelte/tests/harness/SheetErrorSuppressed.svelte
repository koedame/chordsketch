<!--
Test harness: an empty `error` snippet, which is how a consumer
suppresses the inline alert (e.g. when a toast surfaces the failure
instead).
-->
<script lang="ts">
  import ChordSheet from '../../src/ChordSheet.svelte';
  import type { ChordWasmLoader } from '../../src/use-chord-render.svelte';

  let { source, wasmLoader }: { source: string; wasmLoader?: ChordWasmLoader } = $props();
</script>

<ChordSheet {source} {wasmLoader}>
  {#snippet error(_failure)}{/snippet}
</ChordSheet>
