<!--
@component
Accessible transposition control: a native `<select>` listing every
semitone offset between `min` and `max`, styled as the design-system
select (white surface, hairline border, inline chevrons-up-down
caret). Keyboard and screen-reader support come from the native
select.

Bind the value, and pair it with `useTranspose` when you want the
clamping state helper — `const transpose = useTranspose()`, then:

```svelte
<Transpose bind:value={transpose.value} />
```
-->
<script lang="ts" module>
  /**
   * Default minimum the `<Transpose>` select exposes when the host
   * does not pass `min` explicitly. The absolute feature limits are
   * `±11` (a full octave is the identity, so `±12` renders the same
   * chords); the select's default option range is the narrower `±6`,
   * since wider transposition is rarely useful in practice.
   */
  export const TRANSPOSE_DEFAULT_MIN = -6;
  /** Default maximum the `<Transpose>` select exposes. See {@link TRANSPOSE_DEFAULT_MIN}. */
  export const TRANSPOSE_DEFAULT_MAX = 6;

  function defaultFormat(offset: number): string {
    if (offset === 0) return '0';
    return offset > 0 ? `+${offset}` : `${offset}`;
  }
</script>

<script lang="ts">
  import type { HTMLAttributes } from 'svelte/elements';

  import { clamp } from './clamp';

  interface Props extends HTMLAttributes<HTMLDivElement> {
    /** Current semitone offset. Bindable. */
    value?: number;
    /**
     * Minimum offset the select will emit. Defaults to
     * {@link TRANSPOSE_DEFAULT_MIN} (`-6`). Pass an explicit value
     * (down to the `-11` floor) to widen the range.
     */
    min?: number;
    /**
     * Maximum offset the select will emit. Defaults to
     * {@link TRANSPOSE_DEFAULT_MAX} (`+6`).
     */
    max?: number;
    /**
     * Step between adjacent options. Defaults to `1`. A `value`
     * that does not land on the option grid snaps to the nearest
     * rendered option, so a non-dividing `step` never leaves the
     * select showing an unselectable value. A non-positive `step`
     * (or `max < min`) produces an empty, inert select.
     */
    step?: number;
    /**
     * Optional label shown inline before the select. Defaults to
     * `"Transpose"`. Pass `null` to omit the visible label; the
     * select still carries an `aria-label`.
     */
    label?: string | null;
    /**
     * Format an option's semitone value. Defaults to a signed
     * integer. The result is the `<option>`'s text content.
     */
    formatValue?: (value: number) => string | number;
  }

  let {
    value = $bindable(0),
    min = TRANSPOSE_DEFAULT_MIN,
    max = TRANSPOSE_DEFAULT_MAX,
    step = 1,
    label = 'Transpose',
    formatValue = defaultFormat,
    ...rest
  }: Props = $props();


  // Highest offset first so the dropdown reads top-down as
  // `+6 … 0 … -6` (pitch up at the top, matching the ↕ caret).
  const options = $derived.by(() => {
    if (step <= 0 || max < min) return [];
    const out: number[] = [];
    for (let p = max; p >= min; p -= step) out.push(p);
    return out;
  });

  // Resolve the host value to the nearest rendered option. A native
  // <select> cannot display a value that has no matching <option>,
  // so an out-of-range value (clamped here) or an off-grid value
  // (when `step` does not divide the range) would otherwise leave
  // the control showing the wrong offset.
  const displayValue = $derived.by(() => {
    const bounded = clamp(value, min, max);
    if (options.length === 0) return bounded;
    return options.reduce(
      (best, opt) => (Math.abs(opt - bounded) < Math.abs(best - bounded) ? opt : best),
      options[0],
    );
  });

  const ariaLabel = $derived(
    typeof rest['aria-label'] === 'string'
      ? rest['aria-label']
      : typeof label === 'string'
        ? label
        : 'Transpose',
  );

  function onchange(event: Event & { currentTarget: HTMLSelectElement }): void {
    const parsed = Number.parseInt(event.currentTarget.value, 10);
    if (Number.isNaN(parsed)) return;
    value = clamp(parsed, min, max);
  }
</script>

<div
  {...rest}
  role="group"
  aria-label={ariaLabel}
  class={['chordsketch-transpose', rest.class]}
>
  {#if label !== null}
    <span class="chordsketch-transpose__label" aria-hidden="true">{label}</span>
  {/if}
  <select
    class="chordsketch-transpose__select"
    value={displayValue}
    {onchange}
    aria-label={ariaLabel}
  >
    {#each options as offset (offset)}
      <option value={offset}>{formatValue(offset)}</option>
    {/each}
  </select>
</div>
