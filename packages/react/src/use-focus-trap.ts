import { type RefObject, useEffect } from 'react';

/**
 * Selector matching every element the dialog's focus trap should
 * cycle through. Mirrors the list at
 * `packages/ui-irealb-editor/src/popover.ts` (the
 * `collectFocusables` helper).
 *
 * The list intentionally omits `iframe` / `object` / `embed` — the
 * popover does not embed external content and including them would
 * mean the trap could land on a node that captures its own keyboard
 * input independently of the host page.
 */
const FOCUSABLE_SELECTOR =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

function collectFocusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
}

export interface UseFocusTrapOptions {
  /** Called when the user presses Escape OR clicks outside the
   * dialog and its anchor. The host typically maps this to closing
   * the popover. */
  onDismiss: () => void;
  /** The trigger element that opened the popover. Outside-click
   * dismissal explicitly excludes pointerdown events landing inside
   * this anchor so a click on the anchor (which is what opened the
   * popover) does not immediately close it via the freshly-attached
   * document listener. May be `null` when the anchor has been
   * removed from the DOM (e.g. structural edit during open). */
  anchorRef: RefObject<HTMLElement | null>;
  /** When `false`, the hook attaches no listeners and performs no
   * focus management. Use this to gate the trap on the dialog being
   * mounted. */
  enabled: boolean;
}

/**
 * React hook implementing the focus-trap + Escape + outside-click
 * dismissal contract for the iReal bar popover. Sister-site to the
 * imperative version in `packages/ui-irealb-editor/src/popover.ts`
 * (lines 451-525); the same invariants apply:
 *
 * - On mount, focus moves to the first focusable inside the dialog
 *   (or the dialog node itself when it has none).
 * - Tab cycles forward through focusables; Shift+Tab cycles
 *   backward. The focusable list is refreshed on every keydown so
 *   add/remove of chord rows mid-edit updates the cycle order.
 * - Escape calls `onDismiss`.
 * - A `pointerdown` anywhere outside the dialog AND outside the
 *   anchor element calls `onDismiss`. The anchor exclusion prevents
 *   the click that opened the popover from racing through to the
 *   freshly-installed document listener (pointerdown fires before
 *   click; the listener is installed during the open commit, so a
 *   stray pointerdown re-entering this branch would otherwise close
 *   the dialog the same task it mounted).
 * - On unmount the hook returns focus to `anchorRef.current` when
 *   it is still in the document. A detached anchor (host
 *   re-rendered the bar cell while the popover was open — the
 *   common case after a Save) silently falls through.
 *
 * The hook deliberately attaches its document `pointerdown`
 * listener inside `useEffect` (not `useLayoutEffect`) so the
 * listener installs ONE task after the open click has finished
 * propagating, closing the race documented at
 * `popover.ts:458-466`.
 */
export function useFocusTrap(
  dialogRef: RefObject<HTMLElement | null>,
  options: UseFocusTrapOptions,
): void {
  const { onDismiss, anchorRef, enabled } = options;

  useEffect(() => {
    if (!enabled) return;
    const dialog = dialogRef.current;
    if (dialog === null) return;

    // Initial focus: first focusable in the dialog; fall back to
    // the dialog itself so screen-reader users still land inside
    // the modal scope even when it carries no interactive elements.
    const initial = collectFocusables(dialog)[0] ?? dialog;
    initial.focus();

    const onKeyDown = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        onDismiss();
        return;
      }
      if (ev.key === 'Tab') {
        // Refresh on every Tab so a row add/remove mid-edit is
        // reflected in the cycle order.
        const focusables = collectFocusables(dialog);
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (first === undefined || last === undefined) return;
        const active = (dialog.ownerDocument ?? document).activeElement;
        if (ev.shiftKey && active === first) {
          ev.preventDefault();
          last.focus();
        } else if (!ev.shiftKey && active === last) {
          ev.preventDefault();
          first.focus();
        }
      }
    };
    dialog.addEventListener('keydown', onKeyDown);

    const onDocumentPointerDown = (ev: PointerEvent): void => {
      const target = ev.target as Node | null;
      if (target === null) return;
      if (dialog.contains(target)) return;
      const anchor = anchorRef.current;
      if (anchor !== null && anchor.contains(target)) return;
      onDismiss();
    };
    const ownerDocument = dialog.ownerDocument ?? document;
    ownerDocument.addEventListener('pointerdown', onDocumentPointerDown, true);

    return (): void => {
      dialog.removeEventListener('keydown', onKeyDown);
      ownerDocument.removeEventListener('pointerdown', onDocumentPointerDown, true);
      const anchor = anchorRef.current;
      if (anchor !== null && ownerDocument.contains(anchor)) {
        anchor.focus();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);
}
