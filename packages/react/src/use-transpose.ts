import { useCallback, useState } from 'react';

/** Value returned by {@link useTranspose}. */
export interface UseTransposeResult {
  /** Current semitone offset (clamped into `[min, max]`). */
  value: number;
  /**
   * Increase the offset by `step` (default 1). Clamped to `max`.
   * Calls are idempotent at the clamp boundary.
   */
  increment: (step?: number) => void;
  /**
   * Decrease the offset by `step` (default 1). Clamped to `min`.
   * Calls are idempotent at the clamp boundary.
   */
  decrement: (step?: number) => void;
  /** Reset the offset back to its initial value. */
  reset: () => void;
  /**
   * Set the offset to an explicit value, clamped into the supplied
   * range. Useful for slider / input bindings.
   */
  setValue: (next: number) => void;
}

/** Options accepted by {@link useTranspose}. */
export interface UseTransposeOptions {
  /**
   * Starting semitone offset. Clamped into `[min, max]` before it
   * is adopted as the initial value. Defaults to 0.
   */
  initial?: number;
  /**
   * Minimum semitone offset the hook will ever return. Defaults
   * to `-11` (one semitone short of a full octave down — a full
   * octave is the identity, so `-12` and `0` render the same
   * chords).
   */
  min?: number;
  /**
   * Maximum semitone offset the hook will ever return. Defaults
   * to `+11`.
   */
  max?: number;
}

/**
 * Clamps `n` to `[min, max]`. Also normalises `NaN` → `min` so a
 * caller that passes a parsed input box does not leak an invalid
 * numeric value into the render path.
 */
function clamp(n: number, min: number, max: number): number {
  if (Number.isNaN(n)) return min;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

/**
 * State helper for transposition controls. Use when you want to
 * wire your own UI (slider, number input, etc.). The sibling
 * {@link Transpose} component builds a button + indicator pair on
 * top of the same helper.
 *
 * ```ts
 * const { value, increment, decrement, reset } = useTranspose({ initial: 2 });
 * // `value` is always in [-11, +11] by default.
 * ```
 */
export function useTranspose(options: UseTransposeOptions = {}): UseTransposeResult {
  const { initial = 0, min = -11, max = 11 } = options;
  const initialClamped = clamp(initial, min, max);
  const [value, setRawValue] = useState<number>(initialClamped);

  const setValue = useCallback(
    (next: number): void => {
      setRawValue(clamp(next, min, max));
    },
    [min, max],
  );

  const increment = useCallback(
    (step = 1): void => {
      setRawValue((prev) => clamp(prev + step, min, max));
    },
    [min, max],
  );

  const decrement = useCallback(
    (step = 1): void => {
      setRawValue((prev) => clamp(prev - step, min, max));
    },
    [min, max],
  );

  const reset = useCallback((): void => {
    setRawValue(initialClamped);
  }, [initialClamped]);

  return { value, increment, decrement, reset, setValue };
}
