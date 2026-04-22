/**
 * Clamp `n` into `[min, max]`, normalising `NaN` → `min`.
 *
 * Shared between `useTranspose` (where `NaN` can leak in from
 * parsed numeric-input values) and the `<Transpose>` component
 * (where both operands are guaranteed finite numbers, but
 * sharing the helper guarantees any future normalisation — e.g.
 * rounding — applies to both call sites).
 *
 * @param n Input value.
 * @param min Lower bound (inclusive). Returned when `n < min` or
 *   when `n` is `NaN`.
 * @param max Upper bound (inclusive). Returned when `n > max`.
 */
export function clamp(n: number, min: number, max: number): number {
  if (Number.isNaN(n)) return min;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}
