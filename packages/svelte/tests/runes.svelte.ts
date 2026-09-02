import { flushSync } from 'svelte';

/** Handle to a helper running inside a standalone effect root. */
export interface EffectRoot<T> {
  /** Whatever the wrapped call returned. */
  value: T;
  /** Tear the root down — call it from `afterEach`. */
  destroy: () => void;
}

/**
 * Run `fn` inside an `$effect.root`, so a helper that registers an
 * `$effect` (`useChordRender`, `useChordDiagram`, `useDebounced`)
 * can be exercised without mounting a component around it.
 *
 * Effects are flushed once before returning, so the first run has
 * already been scheduled by the time the caller starts asserting.
 * The returned `destroy` is what proves teardown works — without it
 * a pending timer or in-flight render would outlive the test.
 */
export function inEffectRoot<T>(fn: () => T): EffectRoot<T> {
  let value!: T;
  const destroy = $effect.root(() => {
    value = fn();
  });
  flushSync();
  return { value, destroy };
}

/**
 * A single writable `$state` cell.
 *
 * Test files are plain `.ts`, where runes are unavailable, so a test
 * that needs a *changing* input for a helper reaches for this
 * instead of declaring `$state` inline.
 */
export function reactiveBox<T>(initial: T): { value: T } {
  let value = $state(initial);
  return {
    get value() {
      return value;
    },
    set value(next: T) {
      value = next;
    },
  };
}
