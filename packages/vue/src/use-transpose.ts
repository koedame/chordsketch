import { ref, type Ref } from 'vue';

import { clamp } from './clamp';

/** Value returned by {@link useTranspose}. */
export interface UseTransposeResult {
  /**
   * Current semitone offset (clamped into `[min, max]`). A ref, so
   * it binds straight to `<Transpose v-model="value">` and unwraps
   * automatically inside templates.
   */
  value: Ref<number>;
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
   * Minimum semitone offset the composable will ever return.
   * Defaults to `-11` (one semitone short of a full octave down —
   * a full octave is the identity, so `-12` and `0` render the same
   * chords).
   */
  min?: number;
  /**
   * Maximum semitone offset the composable will ever return.
   * Defaults to `+11`.
   */
  max?: number;
}

/**
 * State helper for transposition controls. Use when you want to
 * wire your own UI (slider, number input, etc.). The sibling
 * {@link Transpose} component builds a labelled select on top of
 * the same value contract.
 *
 * ```ts
 * const { value, increment, decrement, reset } = useTranspose({ initial: 2 });
 * // `value.value` is always in [-11, +11] by default.
 * ```
 */
export function useTranspose(options: UseTransposeOptions = {}): UseTransposeResult {
  const { initial = 0, min = -11, max = 11 } = options;
  const initialClamped = clamp(initial, min, max);
  const value = ref<number>(initialClamped);

  const setValue = (next: number): void => {
    value.value = clamp(next, min, max);
  };

  const increment = (step = 1): void => {
    value.value = clamp(value.value + step, min, max);
  };

  const decrement = (step = 1): void => {
    value.value = clamp(value.value - step, min, max);
  };

  const reset = (): void => {
    value.value = initialClamped;
  };

  return { value, increment, decrement, reset, setValue };
}
