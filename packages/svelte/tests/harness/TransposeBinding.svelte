<!--
Test harness: binds `<Transpose>`'s value the way a consumer does
(`bind:value`) and mirrors it into the DOM so a test can observe
what the component wrote back.
-->
<script lang="ts">
  import Transpose from '../../src/Transpose.svelte';

  let {
    value = $bindable(0),
    min = undefined,
    max = undefined,
    step = undefined,
    label = undefined,
    formatValue = undefined,
    'aria-label': ariaLabel = undefined,
  }: {
    value?: number;
    min?: number;
    max?: number;
    step?: number;
    label?: string | null;
    formatValue?: (value: number) => string | number;
    'aria-label'?: string;
  } = $props();
</script>

<Transpose bind:value {min} {max} {step} {label} {formatValue} aria-label={ariaLabel} />
<output data-testid="bound-value">{value}</output>
