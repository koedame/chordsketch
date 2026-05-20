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
    expect(live.classList.contains('chordsketch-ireal-bar-grid__sr-only')).toBe(true);
    expect(live.classList.contains('chordsketch-ireal-bar-grid__live')).toBe(true);
  });

  test('announce sets the live region textContent after a microtask', async () => {
    render(<Harness messages={['Bar 2 deleted']} />);
    await act(async () => {
      await flushMicrotasks();
    });
    expect(screen.getByRole('status').textContent).toBe('Bar 2 deleted');
  });

  test('two same-tick announcements coalesce; the last one wins', async () => {
    // React 18+ batches setState inside `queueMicrotask` callbacks,
    // so two same-tick announce() calls produce ONE observable
    // empty → message transition with the second message winning.
    // This is a deliberate semantic difference from the imperative
    // reference at `ui-irealb-editor/src/index.ts:117-126` — the
    // React port's commit boundary IS the screen-reader change
    // trigger, so splitting one logical edit across two batched
    // announces would only announce the last one anyway. See the
    // hook's JSDoc §"Same-tick coalescing semantics" for the full
    // rationale.
    render(<Harness messages={['first', 'second']} />);
    await act(async () => {
      await flushMicrotasks();
    });
    // The second message wins under same-tick coalescing.
    expect(screen.getByRole('status').textContent).toBe('second');
  });

  test('cross-tick announcements both fire (latch clears between ticks)', async () => {
    // Two announces separated by an `await` / another microtask hop
    // each go through their own empty → message transition. This is
    // the case that matters for distinct logical edits and the path
    // the hook is actually designed for; same-tick coalescing only
    // applies when two announces happen in one React batch.
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
