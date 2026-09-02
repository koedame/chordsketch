<!--
Test harness: `<PdfExport>` with a custom label and, optionally, an
empty `error` snippet — the way a consumer suppresses the inline
alert when a toast surfaces the failure instead.
-->
<script lang="ts">
  import PdfExport from '../../src/PdfExport.svelte';
  import type { WasmLoader } from '../../src/use-pdf-export.svelte';

  let {
    source,
    wasmLoader,
    suppressError = false,
  }: {
    source: string;
    wasmLoader?: WasmLoader;
    suppressError?: boolean;
  } = $props();
</script>

{#if suppressError}
  <PdfExport {source} {wasmLoader}>
    {#snippet error(_failure)}{/snippet}
  </PdfExport>
{:else}
  <PdfExport {source} {wasmLoader}>Save as PDF</PdfExport>
{/if}
