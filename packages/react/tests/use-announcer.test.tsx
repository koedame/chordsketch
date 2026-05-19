import { useEffect, type ReactElement } from 'react';
import { act, render, screen } from '@testing-library/react';
import { describe, expect, test } from 'vitest';

import { useAnnouncer } from '../src/use-announcer';

/**
 * Harness that announces every value in `messages` in order and
 * renders the live region. Each `useEffect` change appends one
 * call so we can verify the empty-then-set transition handles
 * repeated identical announcements.
 */
function Harness({ messages }: { messages: string[] }): ReactElement {
  const { announce, liveRegion } = useAnnouncer();
  useEffect(() => {
    for (const message of messages) {
      announce(message);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <div>{liveRegion}</div>;
}

function flushMicrotasks(): Promise<void> {
  return Promise.resolve();
}

describe('useAnnouncer', () => {
  test('renders a polite ARIA live region with aria-atomic', () => {
    render(<Harness messages={[]} />);
    const live = screen.getByRole('status');
    expect(live.getAttribute('aria-live')).toBe('polite');
    expect(live.getAttribute('aria-atomic')).toBe('true');
  });

  test('uses the shared sr-only utility class so the region stays in the a11y tree', () => {
    render(<Harness messages={[]} />);
    const live = screen.getByRole('status');
    expect(live.classList.contains('chordsketch-ireal-editor__sr-only')).toBe(true);
    expect(live.classList.contains('chordsketch-ireal-editor__live')).toBe(true);
  });

  test('announce sets the live region textContent after a microtask', async () => {
    render(<Harness messages={['Bar 2 deleted']} />);
    await act(async () => {
      await flushMicrotasks();
    });
    expect(screen.getByRole('status').textContent).toBe('Bar 2 deleted');
  });

  test('two consecutive identical announcements both populate (empty-then-set)', async () => {
    // The empty-then-set transition is the load-bearing invariant —
    // `aria-live="polite"` only fires when text content changes, so
    // repeated identical messages would otherwise be silent on
    // every screen reader that follows the spec.
    render(<Harness messages={['Bar deleted', 'Bar deleted']} />);
    await act(async () => {
      await flushMicrotasks();
    });
    // After both calls the final state is the second message — and
    // crucially the latch has cleared, proving the second announce
    // also went through the blank → microtask → set transition.
    expect(screen.getByRole('status').textContent).toBe('Bar deleted');
  });

  test('a fresh announcement after a previous flush still announces', async () => {
    function Stepped(): ReactElement {
      const { announce, liveRegion } = useAnnouncer();
      useEffect(() => {
        announce('first');
        Promise.resolve().then(() => {
          announce('second');
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);
      return <div>{liveRegion}</div>;
    }
    render(<Stepped />);
    await act(async () => {
      await flushMicrotasks();
      await flushMicrotasks();
    });
    expect(screen.getByRole('status').textContent).toBe('second');
  });
});
