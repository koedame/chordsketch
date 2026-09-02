<!--
Test harness: `<ChordDiagram>` with the `notFound` snippet a consumer
would write.
-->
<script lang="ts">
  import ChordDiagram from '../../src/ChordDiagram.svelte';
  import type { ChordDiagramWasmLoader } from '../../src/use-chord-diagram.svelte';

  let {
    chord,
    wasmLoader,
  }: {
    chord: string;
    wasmLoader?: ChordDiagramWasmLoader;
  } = $props();
</script>

<ChordDiagram {chord} {wasmLoader}>
  {#snippet notFound(missing)}
    <p>{missing.chord}/{missing.instrument}</p>
  {/snippet}
</ChordDiagram>
