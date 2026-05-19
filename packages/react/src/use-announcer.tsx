import { type ReactNode, useCallback, useRef, useState } from 'react';

/**
 * Hook that owns a polite ARIA live region for structural-edit
 * announcements in `<IrealEditor>`. Mirrors the announcer pattern
 * established by `@chordsketch/ui-irealb-editor`'s
 * `createIrealbEditor` at
 * `packages/ui-irealb-editor/src/index.ts` (lines 105-127, the
 * `announce` closure).
 *
 * The hook returns:
 * - `announce(message)` — push a sentence into the live region.
 *   Two consecutive identical messages still produce two announcement
 *   events because the hook blanks the region first and then sets
 *   the message in a queued microtask, so the live region observes
 *   the empty-then-populated transition as a change. Without the
 *   blank-first transition `aria-live="polite"` would only fire when
 *   `textContent` actually changes — meaning two identical
 *   announcements would otherwise be silent on every screen reader
 *   that follows the spec (NVDA, VoiceOver in particular).
 * - `liveRegion` — a JSX node the caller renders once inside the
 *   editor. The element is visually hidden via the
 *   `chordsketch-ireal-editor__sr-only` utility class but stays in
 *   the accessibility tree.
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
      className="chordsketch-ireal-editor__sr-only chordsketch-ireal-editor__live"
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      {message}
    </div>
  );

  return { announce, liveRegion };
}
