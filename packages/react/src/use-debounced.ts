import { useEffect, useState } from 'react';

/**
 * Returns a debounced copy of `value` that only updates after `delay`
 * milliseconds have passed without `value` changing.
 *
 * Used by `<ChordEditor>` to avoid re-rendering the
 * `@chordsketch/wasm`-backed preview on every keystroke. The
 * returned value lags the input by at most one `delay` window; a
 * change in `delay` flushes the pending timer so the next update
 * happens on the new schedule.
 *
 * ```ts
 * const [draft, setDraft] = useState('');
 * const debounced = useDebounced(draft, 300);
 * ```
 *
 * @param value Latest value from state / props.
 * @param delay Debounce window in milliseconds. Values ≤ 0 bypass
 *   the debounce entirely and pass the input through synchronously
 *   on the next render (no effect tick), useful in tests.
 */
export function useDebounced<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState<T>(value);

  useEffect(() => {
    if (delay <= 0) {
      // No debounce requested — if the state slot has somehow
      // drifted from `value` (e.g. the component initially mounted
      // with delay > 0), resync it immediately. The fast-path
      // return below handles the normal case without going
      // through the effect at all.
      if (debounced !== value) {
        setDebounced(value);
      }
      return undefined;
    }
    const id = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(id);
    // `debounced` intentionally excluded — it only matters on the
    // delay-swap resync, which `delay` change already retriggers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, delay]);

  // Fast-path for `delay <= 0`: return the live input synchronously
  // on every render so tests (and consumers that want a "flush
  // now" mode) do not have to wait a microtask for the effect to
  // fire.
  if (delay <= 0) {
    return value;
  }
  return debounced;
}
