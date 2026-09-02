import { clamp } from './clamp';

/** Value returned by {@link useTranspose}. */
export interface UseTransposeResult {
  /**
   * Current semitone offset, always clamped into `[min, max]`.
   * Writable, so it binds straight to
   * `<Transpose bind:value={transpose.value} />`.
   */
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
   * range. Equivalent to assigning to `value`; kept as a method so
   * the helper can be passed around as a plain callback.
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
   * Minimum semitone offset the helper will ever return.
   * Defaults to `-11` (one semitone short of a full octave down —
   * a full octave is the identity, so `-12` and `0` render the same
   * chords).
   */
  min?: number;
  /**
   * Maximum semitone offset the helper will ever return.
   * Defaults to `+11`.
   */
  max?: number;
}

/**
 * State helper for transposition controls. Use when you want to
 * wire your own UI (slider, number input, etc.). The sibling
 * `<Transpose>` component builds a labelled select on top of the
 * same value contract.
 *
 * Registers no `$effect`, so it can be called anywhere — including
 * module scope, if a whole app shares one transposition.
 *
 * ```ts
 * const transpose = useTranspose({ initial: 2 });
 * // `transpose.value` is always in [-11, +11] by default.
 * ```
 */
export function useTranspose(options: UseTransposeOptions = {}): UseTransposeResult {
  const { initial = 0, min = -11, max = 11 } = options;
  const initialClamped = clamp(initial, min, max);
  let value = $state(initialClamped);

  return {
    get value() {
      return value;
    },
    // Clamping in the setter is what makes `bind:value` safe: a
    // `<Transpose max={11}>` writing 11 into a helper capped at 6
    // lands on 6 here rather than escaping the range the caller
    // asked for.
    set value(next: number) {
      value = clamp(next, min, max);
    },
    setValue(next: number) {
      value = clamp(next, min, max);
    },
    increment(step = 1) {
      value = clamp(value + step, min, max);
    },
    decrement(step = 1) {
      value = clamp(value - step, min, max);
    },
    reset() {
      value = initialClamped;
    },
  };
}
