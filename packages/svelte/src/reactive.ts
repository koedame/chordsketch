/**
 * A value, or a function returning it.
 *
 * Svelte 5 has no reference cell to hand around: `$state` is a
 * plain variable at its declaration site, and reading it inside a
 * function is what registers the dependency. A helper that wants to
 * re-run when its input changes therefore has to be handed a
 * *getter* (`() => source`) rather than the value itself — reading
 * `source` at the call site would capture one snapshot and never
 * see the next one.
 *
 * Every helper in this package accepts either form so a static
 * input stays a plain argument:
 *
 * ```ts
 * useChordRender('{title: Song}');       // never changes
 * useChordRender(() => source);          // re-renders when `source` does
 * ```
 */
export type MaybeGetter<T> = T | (() => T);

/**
 * Read a {@link MaybeGetter}. Call this inside the reactive scope
 * that should track the input (an `$effect` or `$derived` body), not
 * before it.
 */
export function toValue<T>(source: MaybeGetter<T>): T {
  return typeof source === 'function' ? (source as () => T)() : source;
}
