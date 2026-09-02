import {
  getCurrentScope,
  onScopeDispose,
  ref,
  toValue,
  watch,
  type MaybeRefOrGetter,
  type Ref,
} from 'vue';

/**
 * Returns a debounced copy of `value` that only updates after `delay`
 * milliseconds have passed without `value` changing.
 *
 * Used by `<ChordTextarea>` to avoid re-rendering the
 * `@chordsketch/wasm`-backed preview on every keystroke. The
 * returned ref lags the input by at most one `delay` window; a
 * change in `delay` flushes the pending timer so the next update
 * happens on the new schedule.
 *
 * ```ts
 * const draft = ref('');
 * const debounced = useDebounced(draft, 300);
 * ```
 *
 * @param value Latest value — a ref, a getter, or a plain value.
 * @param delay Debounce window in milliseconds. Values ≤ 0 bypass
 *   the debounce entirely and pass the input through synchronously
 *   (the watcher runs with `flush: 'sync'`), useful in tests.
 */
export function useDebounced<T>(
  value: MaybeRefOrGetter<T>,
  delay: MaybeRefOrGetter<number>,
): Ref<T> {
  const debounced = ref(toValue(value)) as Ref<T>;

  let timer: ReturnType<typeof setTimeout> | null = null;
  const clearPending = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  watch(
    () => [toValue(value), toValue(delay)] as const,
    ([next, ms]) => {
      // A change in either input cancels the in-flight timer: a new
      // `value` restarts the window, and a new `delay` reschedules
      // on the new one rather than firing on the stale schedule.
      clearPending();
      if (ms <= 0) {
        debounced.value = next;
        return;
      }
      timer = setTimeout(() => {
        debounced.value = next;
        timer = null;
      }, ms);
    },
    // `sync` so the `delay <= 0` branch propagates in the same tick
    // the source changed, matching the "no debounce requested means
    // no scheduling at all" contract callers rely on in tests.
    { flush: 'sync' },
  );

  if (getCurrentScope()) {
    onScopeDispose(clearPending);
  }

  return debounced;
}
