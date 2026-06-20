/**
 * Briefly flash a `ringingClass` on an element so an audio activation
 * (a played chord / a pressed chord diagram) gets visual feedback. The
 * class is added imperatively — the chordpro-jsx walker is stateless per
 * chord, and `<ChordDiagram>` reuses the same mechanism so the two paths
 * cannot drift (.claude/rules/fix-propagation.md). The class is removed
 * by the caller on `animationend`; a forced reflow between remove and
 * re-add restarts the CSS animation when the same target is activated
 * again before the previous pulse finishes.
 *
 * When `prefers-reduced-motion: reduce` is active the function exits
 * early rather than adding the class — the CSS suppresses the animation
 * (`animation: none`) and `animationend` never fires, which would leave
 * the ring state (crimson background, white text) on the element
 * permanently. The guard also covers SSR / non-DOM environments where
 * `window` is undefined.
 *
 * @param el The element to pulse.
 * @param ringingClass The class toggled for the duration of the pulse
 *   (`"chord--ringing"` for chord names, `"chordsketch-diagram--ringing"`
 *   for chord diagrams).
 */
export function pulseElement(el: HTMLElement, ringingClass: string): void {
  // Skip the visual pulse when the user prefers reduced motion (or when
  // there is no `window`/`matchMedia`, e.g. SSR). The audio still plays;
  // only the animation feedback is suppressed. Without this guard,
  // `animationend` never fires under `animation: none`, so the ring
  // highlight would stick on the element indefinitely.
  if (
    typeof window === 'undefined' ||
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  ) {
    return;
  }
  el.classList.remove(ringingClass);
  // Reading offsetWidth forces a synchronous reflow so the re-added
  // class starts a fresh animation rather than being coalesced away.
  void el.offsetWidth;
  el.classList.add(ringingClass);
}
