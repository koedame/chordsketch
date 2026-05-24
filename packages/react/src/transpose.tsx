import type { ChangeEvent, HTMLAttributes } from 'react';
import { useCallback } from 'react';

import { clamp as clampValue } from './clamp';

/**
 * Default minimum the `<Transpose>` slider exposes when the host
 * does not pass `min` explicitly. The `TRANSPOSE_MIN` /
 * `TRANSPOSE_MAX` constants in `chord-source-edit.ts` are the
 * absolute feature limits (`±11`); the slider's default render
 * range is the narrower `±6` per #2560, since wider transposition
 * is rarely useful in practice and the narrower scale is easier
 * to read on a slider.
 */
export const TRANSPOSE_DEFAULT_MIN = -6;
/** Default maximum the `<Transpose>` slider exposes. See {@link TRANSPOSE_DEFAULT_MIN}. */
export const TRANSPOSE_DEFAULT_MAX = 6;

/** Props accepted by {@link Transpose}. */
export interface TransposeProps extends Omit<HTMLAttributes<HTMLDivElement>, 'onChange'> {
  /** Current semitone offset (controlled mode). */
  value: number;
  /** Fired when the slider's input value changes. */
  onChange: (next: number) => void;
  /**
   * Minimum offset the slider will emit. Defaults to
   * {@link TRANSPOSE_DEFAULT_MIN} (`-6`). Pass an explicit value
   * (down to the `TRANSPOSE_MIN` floor of `-11`) to widen the
   * range.
   */
  min?: number;
  /**
   * Maximum offset the slider will emit. Defaults to
   * {@link TRANSPOSE_DEFAULT_MAX} (`+6`). Pass an explicit value
   * (up to the `TRANSPOSE_MAX` ceiling of `+11`) to widen the
   * range.
   */
  max?: number;
  /** Step size for the slider. Defaults to `1`. */
  step?: number;
  /**
   * Optional label shown inline with the slider. Defaults to
   * `"Transpose"`. Pass `null` to omit the visible label; the
   * component still exposes `aria-label` on the wrapper.
   */
  label?: React.ReactNode;
  /** Format the semitone indicator. Defaults to signed integer. */
  formatValue?: (value: number) => React.ReactNode;
}

function defaultFormat(value: number): string {
  if (value === 0) return '0';
  return value > 0 ? `+${value}` : `${value}`;
}

/**
 * Accessible transposition control: a native `<input type="range">`
 * slider with a signed current-value readout. Keyboard support
 * comes from the native range input (Arrow keys, Home / End,
 * PageUp / PageDown).
 *
 * The component is **controlled** — pass `value` and `onChange`.
 * Wire up `useTranspose()` next to it if you want the internal
 * state helper.
 *
 * ```tsx
 * const { value, setValue } = useTranspose();
 * <Transpose value={value} onChange={setValue} />
 * ```
 */
export function Transpose({
  value,
  onChange,
  min = TRANSPOSE_DEFAULT_MIN,
  max = TRANSPOSE_DEFAULT_MAX,
  step = 1,
  label = 'Transpose',
  formatValue = defaultFormat,
  className,
  ...divProps
}: TransposeProps): JSX.Element {
  const clamp = useCallback(
    (next: number): number => clampValue(next, min, max),
    [min, max],
  );

  // Clamp the host-supplied `value` for display purposes. The native
  // range input visually pins the thumb to the bound when `value`
  // is out of range, but the `<output>` readout would otherwise
  // surface the raw (unclamped) prop and disagree with the thumb.
  const displayValue = clamp(value);

  const handleSliderChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>): void => {
      const parsed = Number.parseInt(event.target.value, 10);
      if (Number.isNaN(parsed)) return;
      onChange(clamp(parsed));
    },
    [onChange, clamp],
  );

  const ariaLabel =
    typeof divProps['aria-label'] === 'string'
      ? divProps['aria-label']
      : typeof label === 'string'
        ? label
        : 'Transpose';

  return (
    <div
      {...divProps}
      role="group"
      aria-label={ariaLabel}
      className={['chordsketch-transpose', className].filter(Boolean).join(' ')}
    >
      {label !== null ? (
        <span className="chordsketch-transpose__label" aria-hidden="true">
          {label}
        </span>
      ) : null}
      <input
        type="range"
        className="chordsketch-transpose__slider"
        min={min}
        max={max}
        step={step}
        value={displayValue}
        onChange={handleSliderChange}
        aria-label={ariaLabel}
      />
      <output
        className="chordsketch-transpose__value"
        aria-live="polite"
        aria-atomic="true"
      >
        {formatValue(displayValue)}
      </output>
    </div>
  );
}
