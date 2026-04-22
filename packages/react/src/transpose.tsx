import type { HTMLAttributes, KeyboardEvent } from 'react';
import { useCallback } from 'react';

/** Props accepted by {@link Transpose}. */
export interface TransposeProps extends Omit<HTMLAttributes<HTMLDivElement>, 'onChange'> {
  /** Current semitone offset (controlled mode). */
  value: number;
  /** Fired when the user clicks a button or presses a keyboard shortcut. */
  onChange: (next: number) => void;
  /** Minimum offset the buttons will emit. Defaults to `-11`. */
  min?: number;
  /** Maximum offset the buttons will emit. Defaults to `+11`. */
  max?: number;
  /** Step size for `+` / `−` buttons. Defaults to `1`. */
  step?: number;
  /**
   * Optional label shown inline with the buttons. Defaults to
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
 * Accessible transposition control: a − button, a current-value
 * readout, a + button, and a reset button (only rendered when the
 * offset is non-zero). Keyboard support on the wrapper: `+` / `=`
 * step up, `-` / `_` step down, `0` resets to zero.
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
  min = -11,
  max = 11,
  step = 1,
  label = 'Transpose',
  formatValue = defaultFormat,
  className,
  ...divProps
}: TransposeProps): JSX.Element {
  const clamp = useCallback(
    (next: number): number => {
      if (next < min) return min;
      if (next > max) return max;
      return next;
    },
    [min, max],
  );

  const handleDecrement = useCallback(() => {
    onChange(clamp(value - step));
  }, [onChange, clamp, value, step]);

  const handleIncrement = useCallback(() => {
    onChange(clamp(value + step));
  }, [onChange, clamp, value, step]);

  const handleReset = useCallback(() => {
    onChange(0);
  }, [onChange]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>): void => {
      // Keyboard shortcuts fire only when the wrapper or one of its
      // descendants has focus, so they don't interfere with form
      // fields elsewhere on the page.
      switch (event.key) {
        case '+':
        case '=':
          event.preventDefault();
          handleIncrement();
          break;
        case '-':
        case '_':
          event.preventDefault();
          handleDecrement();
          break;
        case '0':
          if (value !== 0) {
            event.preventDefault();
            handleReset();
          }
          break;
        default:
          // Let arrow keys and tab key bubble as usual — they
          // already move focus between the individual buttons.
          break;
      }
    },
    [handleIncrement, handleDecrement, handleReset, value],
  );

  const decrementDisabled = value <= min;
  const incrementDisabled = value >= max;

  return (
    <div
      {...divProps}
      role="group"
      // `aria-label` has to be a string; fall back to the literal
      // `"Transpose"` if the caller passed a ReactNode label (e.g.
      // `<span>🎵</span>`) so the group still has an accessible
      // name. Consumers who want a different accessible name can
      // pass an explicit `aria-label` through divProps, which wins.
      aria-label={
        typeof divProps['aria-label'] === 'string'
          ? divProps['aria-label']
          : typeof label === 'string'
            ? label
            : 'Transpose'
      }
      className={['chordsketch-transpose', className].filter(Boolean).join(' ')}
      onKeyDown={handleKeyDown}
    >
      {label !== null ? (
        <span className="chordsketch-transpose__label" aria-hidden="true">
          {label}
        </span>
      ) : null}
      <button
        type="button"
        onClick={handleDecrement}
        disabled={decrementDisabled}
        aria-label={
          step === 1 ? 'Transpose down one semitone' : `Transpose down ${step} semitones`
        }
        className="chordsketch-transpose__button chordsketch-transpose__button--decrement"
      >
        −
      </button>
      <output
        className="chordsketch-transpose__value"
        aria-live="polite"
        aria-atomic="true"
      >
        {formatValue(value)}
      </output>
      <button
        type="button"
        onClick={handleIncrement}
        disabled={incrementDisabled}
        aria-label={
          step === 1 ? 'Transpose up one semitone' : `Transpose up ${step} semitones`
        }
        className="chordsketch-transpose__button chordsketch-transpose__button--increment"
      >
        +
      </button>
      {value !== 0 ? (
        <button
          type="button"
          onClick={handleReset}
          aria-label="Reset transposition to zero"
          className="chordsketch-transpose__button chordsketch-transpose__button--reset"
        >
          Reset
        </button>
      ) : null}
    </div>
  );
}
