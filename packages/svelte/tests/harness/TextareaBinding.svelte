<!--
Test harness: binds `<ChordTextarea>`'s value and transpose the way a
consumer does, and mirrors both into the DOM so a test can observe
what the component wrote back.
-->
<script lang="ts">
  import ChordTextarea from '../../src/ChordTextarea.svelte';
  import type { ChordRenderFormat, ChordWasmLoader } from '../../src/use-chord-render.svelte';

  let {
    value = $bindable(''),
    transpose = $bindable(0),
    debounceMs = 0,
    previewFormat = 'text' as ChordRenderFormat,
    transposeMin = undefined,
    transposeMax = undefined,
    wasmLoader,
  }: {
    value?: string;
    transpose?: number;
    debounceMs?: number;
    previewFormat?: ChordRenderFormat;
    transposeMin?: number;
    transposeMax?: number;
    wasmLoader?: ChordWasmLoader;
  } = $props();
</script>

<ChordTextarea
  bind:value
  bind:transpose
  {debounceMs}
  {previewFormat}
  {transposeMin}
  {transposeMax}
  {wasmLoader}
/>
<output data-testid="bound-value">{value}</output>
<output data-testid="bound-transpose">{transpose}</output>
