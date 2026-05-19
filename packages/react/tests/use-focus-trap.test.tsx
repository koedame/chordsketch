/* eslint-disable react/jsx-key */
import { useRef, useState, type ReactElement } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

import { useFocusTrap } from '../src/use-focus-trap';

/**
 * Narrow harness: a dialog that mounts `useFocusTrap` while
 * `enabled=true`. The anchor is a sibling button so outside-click
 * pointerdown can target it. The dialog renders an arbitrary list
 * of inner buttons so we can verify the focusable-list refresh.
 *
 * `closed` mirrors the host's "popover dismissed but the surrounding
 * editor stays mounted" lifecycle — when it flips to `true` the
 * dialog stays in the tree but the trap's `enabled` flag goes
 * false, exercising the cleanup branch that returns focus to the
 * anchor.
 */
function Harness({
  onDismiss,
  initialButtonCount = 2,
  closed = false,
}: {
  onDismiss: () => void;
  initialButtonCount?: number;
  closed?: boolean;
}): ReactElement {
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const [buttonCount, setButtonCount] = useState(initialButtonCount);
  useFocusTrap(dialogRef, { onDismiss, anchorRef, enabled: !closed });
  return (
    <div>
      <button ref={anchorRef} type="button" data-testid="anchor">
        anchor
      </button>
      <div ref={dialogRef} role="dialog" aria-modal="true" data-testid="dialog">
        {Array.from({ length: buttonCount }).map((_, i) => (
          <button key={i} type="button" data-testid={`btn-${i}`}>
            button {i}
          </button>
        ))}
        <button
          type="button"
          data-testid="add-button"
          onClick={() => setButtonCount(buttonCount + 1)}
        >
          add
        </button>
      </div>
    </div>
  );
}

describe('useFocusTrap', () => {
  test('moves focus to the first focusable on mount', () => {
    render(<Harness onDismiss={vi.fn()} />);
    expect(document.activeElement).toBe(screen.getByTestId('btn-0'));
  });

  test('Tab from the last focusable cycles to the first', () => {
    render(<Harness onDismiss={vi.fn()} />);
    // Move to the add button (last focusable in the harness).
    const lastBtn = screen.getByTestId('add-button');
    lastBtn.focus();
    fireEvent.keyDown(screen.getByTestId('dialog'), { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByTestId('btn-0'));
  });

  test('Shift+Tab from the first focusable cycles to the last', () => {
    render(<Harness onDismiss={vi.fn()} />);
    const first = screen.getByTestId('btn-0');
    first.focus();
    fireEvent.keyDown(screen.getByTestId('dialog'), { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(screen.getByTestId('add-button'));
  });

  test('Tab refreshes the focusable list each keydown', () => {
    render(<Harness onDismiss={vi.fn()} initialButtonCount={1} />);
    // Add a focusable so the cycle order grows.
    fireEvent.click(screen.getByTestId('add-button'));
    // The new button (btn-1) should be in the cycle. Focus the add
    // button (still last), tab forward — should hit btn-0.
    screen.getByTestId('add-button').focus();
    fireEvent.keyDown(screen.getByTestId('dialog'), { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByTestId('btn-0'));
  });

  test('Escape calls onDismiss', () => {
    const onDismiss = vi.fn();
    render(<Harness onDismiss={onDismiss} />);
    fireEvent.keyDown(screen.getByTestId('dialog'), { key: 'Escape' });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  test('pointerdown outside dialog AND outside anchor calls onDismiss', () => {
    const onDismiss = vi.fn();
    const { container } = render(
      <div data-testid="outside">
        <Harness onDismiss={onDismiss} />
      </div>,
    );
    // pointerdown on the outer container (not dialog, not anchor).
    fireEvent.pointerDown(container);
    expect(onDismiss).toHaveBeenCalled();
  });

  test('pointerdown inside the anchor does NOT call onDismiss', () => {
    const onDismiss = vi.fn();
    render(<Harness onDismiss={onDismiss} />);
    fireEvent.pointerDown(screen.getByTestId('anchor'));
    expect(onDismiss).not.toHaveBeenCalled();
  });

  test('pointerdown inside the dialog does NOT call onDismiss', () => {
    const onDismiss = vi.fn();
    render(<Harness onDismiss={onDismiss} />);
    fireEvent.pointerDown(screen.getByTestId('btn-0'));
    expect(onDismiss).not.toHaveBeenCalled();
  });

  test('disabling the trap returns focus to the anchor', () => {
    // Simulates the host's "popover dismissed, editor still mounted"
    // path — the realistic scenario where the anchor bar cell is
    // still in the document. (A full host-unmount path that also
    // tears down the anchor is silently a no-op per the
    // `document.contains(anchor)` guard in the hook.)
    const { rerender } = render(<Harness onDismiss={vi.fn()} closed={false} />);
    const anchor = screen.getByTestId('anchor');
    act(() => {
      rerender(<Harness onDismiss={vi.fn()} closed />);
    });
    expect(document.activeElement).toBe(anchor);
  });
});
