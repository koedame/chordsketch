import { computed, defineComponent, h, type PropType } from 'vue';

import { clamp } from './clamp';

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

function defaultFormat(value: number): string {
  if (value === 0) return '0';
  return value > 0 ? `+${value}` : `${value}`;
}

/**
 * Accessible transposition control: a native `<select>` listing
 * every semitone offset between `min` and `max`, styled as the
 * design-system select (white surface, hairline border, inline
 * chevrons-up-down caret). Keyboard and screen-reader support come
 * from the native select.
 *
 * The component is bound with `v-model`; pair it with
 * {@link useTranspose} when you want the clamping state helper.
 *
 * ```vue
 * <script setup>
 * const { value } = useTranspose();
 * </script>
 *
 * <template>
 *   <Transpose v-model="value" />
 * </template>
 * ```
 */
export const Transpose = defineComponent({
  name: 'Transpose',
  props: {
    /** Current semitone offset. */
    modelValue: { type: Number, required: true },
    /**
     * Minimum offset the select will emit. Defaults to
     * {@link TRANSPOSE_DEFAULT_MIN} (`-6`). Pass an explicit value
     * (down to the `-11` floor) to widen the range.
     */
    min: { type: Number, default: TRANSPOSE_DEFAULT_MIN },
    /**
     * Maximum offset the select will emit. Defaults to
     * {@link TRANSPOSE_DEFAULT_MAX} (`+6`).
     */
    max: { type: Number, default: TRANSPOSE_DEFAULT_MAX },
    /**
     * Step between adjacent options. Defaults to `1`. A `modelValue`
     * that does not land on the option grid snaps to the nearest
     * rendered option, so a non-dividing `step` never leaves the
     * select showing an unselectable value. A non-positive `step`
     * (or `max < min`) produces an empty, inert select.
     */
    step: { type: Number, default: 1 },
    /**
     * Optional label shown inline before the select. Defaults to
     * `"Transpose"`. Pass `null` to omit the visible label; the
     * select still carries an `aria-label`.
     */
    label: { type: String as PropType<string | null>, default: 'Transpose' },
    /**
     * Format an option's semitone value. Defaults to a signed
     * integer. The result is the `<option>`'s text content.
     */
    formatValue: {
      type: Function as PropType<(value: number) => string | number>,
      default: defaultFormat,
    },
  },
  emits: {
    'update:modelValue': (value: number) => typeof value === 'number',
  },
  setup(props, { attrs, emit }) {
    // Highest offset first so the dropdown reads top-down as
    // `+6 … 0 … -6` (pitch up at the top, matching the ↕ caret).
    const options = computed<number[]>(() => {
      if (props.step <= 0 || props.max < props.min) return [];
      const out: number[] = [];
      for (let p = props.max; p >= props.min; p -= props.step) out.push(p);
      return out;
    });

    // Resolve the host value to the nearest rendered option. A
    // native <select> cannot display a value that has no matching
    // <option>, so an out-of-range value (clamped here) or an
    // off-grid value (when `step` does not divide the range) would
    // otherwise leave the control showing the wrong offset.
    const displayValue = computed(() => {
      const bounded = clamp(props.modelValue, props.min, props.max);
      const opts = options.value;
      if (opts.length === 0) return bounded;
      return opts.reduce(
        (best, opt) => (Math.abs(opt - bounded) < Math.abs(best - bounded) ? opt : best),
        opts[0],
      );
    });

    const ariaLabel = computed(() => {
      const attrLabel = attrs['aria-label'];
      if (typeof attrLabel === 'string') return attrLabel;
      return typeof props.label === 'string' ? props.label : 'Transpose';
    });

    const onChange = (event: Event): void => {
      const parsed = Number.parseInt((event.target as HTMLSelectElement).value, 10);
      if (Number.isNaN(parsed)) return;
      emit('update:modelValue', clamp(parsed, props.min, props.max));
    };

    return () =>
      h(
        'div',
        {
          role: 'group',
          'aria-label': ariaLabel.value,
          class: 'chordsketch-transpose',
        },
        [
          props.label !== null
            ? h(
                'span',
                { class: 'chordsketch-transpose__label', 'aria-hidden': 'true' },
                props.label,
              )
            : null,
          h(
            'select',
            {
              class: 'chordsketch-transpose__select',
              value: displayValue.value,
              onChange,
              'aria-label': ariaLabel.value,
            },
            options.value.map((pos) =>
              h('option', { key: pos, value: pos }, String(props.formatValue(pos))),
            ),
          ),
        ],
      );
  },
});
