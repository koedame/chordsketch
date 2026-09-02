import { toValue, type MaybeGetter } from './reactive';

/** Reactive state returned by {@link useDebounced}. */
export interface DebouncedResult<T> {
  /**
   * The debounced value. Lags the input by at most one `delay`
   * window.
   */
  readonly current: T;
}

/**
 * Returns a debounced copy of `value` that only updates after
 * `delay` milliseconds have passed without `value` changing.
 *
 * Used by `<ChordTextarea>` to avoid re-rendering the
 * `@chordsketch/wasm`-backed preview on every keystroke. A change in
 * `delay` reschedules the pending update on the new window rather
 * than firing on the stale one.
 *
 * Call it during component initialisation — the timer lives in an
 * `$effect`, whose teardown cancels a pending update when the owner
 * is destroyed.
 *
 * ```ts
 * let draft = $state('');
 * const debounced = useDebounced(() => draft, 300);
 * ```
 *
 * @param value Latest value — a getter, or a plain value that never
 *   changes.
 * @param delay Debounce window in milliseconds. Values ≤ 0 skip the
 *   timer and update on the effect's own schedule (the next
 *   microtask), which is what tests and zero-latency previews want.
 */
export function useDebounced<T>(
  value: MaybeGetter<T>,
  delay: MaybeGetter<number>,
): DebouncedResult<T> {
  let current = $state(toValue(value));

  $effect(() => {
    const next = toValue(value);
    const ms = toValue(delay);
    if (ms <= 0) {
      current = next;
      return;
    }
    const timer = setTimeout(() => {
      current = next;
    }, ms);
    // Teardown runs both when an input changes (restarting the
    // window) and when the owning component is destroyed, so no
    // timer outlives the value it was going to publish.
    return () => clearTimeout(timer);
  });

  return {
    get current() {
      return current;
    },
  };
}
