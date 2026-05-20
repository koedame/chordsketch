import { type ReactNode, useCallback, useRef, useState } from 'react';

/**
 * Hook that owns a polite ARIA live region for structural-edit
 * announcements in `<IrealBarGrid>`. Mirrors the announcer pattern
 * established by `@chordsketch/ui-irealb-editor`'s
 * `createIrealbEditor` at
 * `packages/ui-irealb-editor/src/index.ts` (lines 105-127, the
 * `announce` closure).
 *
 * **Same-tick coalescing semantics.** The hook flows through React's
 * state-update pipeline, which batches setState calls inside event
 * handlers AND inside `queueMicrotask` callbacks under React 18+
 * concurrent rendering. Two `announce()` calls in the same task
 * therefore produce ONE observable empty → message transition, with
 * the last announcement winning. This is a deliberate semantic
 * difference from the imperative reference at
 * `ui-irealb-editor/src/index.ts:117-126`, where each call mutates
 * `textContent` directly with no batching. The React port accepts
 * the coalescing because:
 *   - React's commit boundary IS the screen-reader change trigger;
 *     splitting one logical edit across two batched same-tick
 *     announces would announce only the last anyway.
 *   - For two logical edits separated by an `await` / another
 *     microtask hop, the pending latch clears between them and both
 *     announcements fire — verified by
 *     `tests/use-announcer.test.tsx` "cross-tick announcements both
 *     fire (latch clears between ticks)".
 *   - The empty-then-set transition the hook performs is what makes
 *     a single announcement audible: `aria-live="polite"` only fires
 *     on actual `textContent` changes, so blank-first guarantees the
 *     screen reader observes the transition.
 *
 * The hook returns:
 * - `announce(message)` — push a sentence into the live region.
 *   Same-tick coalescing applies per the section above; cross-tick
 *   announcements all fire.
 * - `liveRegion` — a JSX node the caller renders once inside the
 *   editor. The element is visually hidden via the
 *   `chordsketch-ireal-bar-grid__sr-only` utility class declared in
 *   `packages/react/src/styles.css` but stays in the accessibility
 *   tree.
 *
 * The live region is rendered as a sibling of the bar grid (not
 * inside it) so a structural rerender of the grid does not detach
 * the live node and risk losing an announcement queued mid-flight —
 * a known regression class on NVDA when a polite region is removed
 * and re-added in the same task.
 */
export interface UseAnnouncerResult {
  /** Push a sentence into the polite live region. Safe to call from
   * render — the actual `textContent` update happens in a queued
   * microtask. */
  announce: (message: string) => void;
  /** JSX node the host MUST render exactly once inside the editor. */
  liveRegion: ReactNode;
}

export function useAnnouncer(): UseAnnouncerResult {
  // The live region's text is owned by React state so a screen
  // reader observes the change via the DOM `textContent` swap that
  // React's reconciler produces. Using a ref + direct DOM mutation
  // here would bypass React's commit phase and on rare interleavings
  // miss the change event the screen reader needs.
  const [message, setMessage] = useState<string>('');
  // Lock-step latch: when an announcement is in-flight we run two
  // setState calls (blank, then message). The latch holds the
  // payload so the microtask-scheduled second call still has the
  // current intent even if a faster announcement queued behind it.
  const pendingRef = useRef<string | null>(null);

  const announce = useCallback((next: string): void => {
    pendingRef.current = next;
    setMessage('');
    queueMicrotask(() => {
      const payload = pendingRef.current;
      if (payload === null) return;
      pendingRef.current = null;
      setMessage(payload);
    });
  }, []);

  const liveRegion = (
    <div
      className="chordsketch-ireal-bar-grid__sr-only chordsketch-ireal-bar-grid__live"
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      {message}
    </div>
  );

  return { announce, liveRegion };
}
