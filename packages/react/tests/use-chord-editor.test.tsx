import { act, render } from '@testing-library/react';
import { useRef, useState } from 'react';
import { describe, expect, test, vi } from 'vitest';

import type { ChordSourceAreaHandle } from '../src/chord-source-area';
import { useChordEditor, type UseChordEditor } from '../src/use-chord-editor';

// The hook drives a controlled source: `onSourceChange` feeds the parent
// state, which re-renders the hook with the new source (mirroring how
// `<ChordProEditor>` / the playground wire it). A tiny harness owns that
// loop and exposes the latest hook result + the fake editor handle's
// `setCaret` spy to each test.

const SOURCE = '[G]Almost [Bbm7]heaven';

let latest: UseChordEditor;
let currentSource: string;
let setCaretSpy: ReturnType<typeof vi.fn>;

function Harness({ initial, transpose }: { initial: string; transpose?: number }): null {
  const [source, setSource] = useState(initial);
  currentSource = source;
  const ref = useRef<ChordSourceAreaHandle | null>(null);
  if (ref.current === null) {
    setCaretSpy = vi.fn();
    ref.current = {
      focus: vi.fn(),
      getValue: () => source,
      setValue: vi.fn(),
      insertAtCursor: vi.fn(),
      setCaret: setCaretSpy,
    };
  }
  latest = useChordEditor({ source, onSourceChange: setSource, transpose, editorRef: ref });
  return null;
}

function mount(initial = SOURCE, transpose?: number) {
  setCaretSpy = vi.fn();
  return render(<Harness initial={initial} transpose={transpose} />);
}

/** Move the simulated editor caret to `column` on line 1. */
function caretTo(column: number): void {
  act(() => {
    latest.onCaretChange({ line: 1, column, lineLength: SOURCE.length });
  });
}

describe('useChordEditor', () => {
  test('idle before the caret reports a position: no selection, no Insert', () => {
    mount();
    expect(latest.inspectorProps.selected).toBe(false);
    expect(latest.chordSelection).toBeNull();
    // Insert needs a caret to target.
    expect(latest.inspectorProps.onInsert).toBeUndefined();
  });

  test('a caret on a chord selects it and reflects its parts', () => {
    mount();
    caretTo(1); // inside `[G]`
    expect(latest.inspectorProps.selected).toBe(true);
    expect(latest.inspectorProps.chordName).toBe('G');
    expect(latest.chordSelection).toMatchObject({ line: 1, offset: 0, ordinal: 0 });
    // Insert is idle-only: while a chord is selected the footer offers
    // Remove, not Insert (#2646).
    expect(latest.inspectorProps.onInsert).toBeUndefined();
    expect(latest.inspectorProps.onRemove).toBeTypeOf('function');
    // Caret in the lyrics deselects — and Insert becomes available again.
    caretTo(5); // inside "Almost"
    expect(latest.inspectorProps.selected).toBe(false);
    expect(latest.chordSelection).toBeNull();
    expect(latest.inspectorProps.onInsert).toBeTypeOf('function');
    expect(latest.inspectorProps.onRemove).toBeUndefined();
  });

  test('editing the selected chord rewrites it in source and keeps it selected', () => {
    mount();
    caretTo(1); // select `[G]`
    act(() => {
      latest.inspectorProps.onChange({ root: 'G', accidental: '', suffix: '7', bass: '' });
    });
    expect(currentSource).toBe('[G7]Almost [Bbm7]heaven');
    // Caret restored just inside the rewritten bracket (col 1).
    expect(setCaretSpy).toHaveBeenLastCalledWith(1);
  });

  test('building a chord in idle and inserting writes it at the caret', () => {
    mount();
    caretTo(5); // idle, in "Almost"
    act(() => {
      // Build C + dim7 -> Cdim7 (draft).
      latest.inspectorProps.onChange({ root: 'C', accidental: '', suffix: 'dim7', bass: '' });
    });
    // Insert is now available (caret present, editable).
    expect(latest.inspectorProps.onInsert).toBeTypeOf('function');
    act(() => {
      latest.inspectorProps.onInsert?.();
    });
    expect(currentSource).toBe('[G]Al[Cdim7]most [Bbm7]heaven');
  });

  test('clicking a preview chord moves the editor caret onto it', () => {
    mount();
    // `[Bbm7]` opens at column 10; the hook moves the caret just inside.
    act(() => {
      latest.onChordSelectionChange({ line: 1, offset: 7, ordinal: 0, nonce: 1 });
    });
    expect(setCaretSpy).toHaveBeenLastCalledWith(11);
  });

  test('deleting the selected chord removes its token', () => {
    mount();
    caretTo(1); // select `[G]`
    act(() => {
      latest.inspectorProps.onRemove?.();
    });
    expect(currentSource).toBe('Almost [Bbm7]heaven');
  });

  test('the caret restore fires once per edit and does not re-fire on a later caret move', () => {
    mount();
    caretTo(1); // select `[G]`
    act(() => {
      latest.inspectorProps.onChange({ root: 'G', accidental: '', suffix: '7', bass: '' });
    });
    expect(currentSource).toBe('[G7]Almost [Bbm7]heaven');
    const callsAfterEdit = setCaretSpy.mock.calls.length;
    // Subsequent caret-only moves must not replay the consumed pending
    // caret (the tagged-pending guard clears it after applying).
    caretTo(8);
    caretTo(2);
    expect(setCaretSpy.mock.calls.length).toBe(callsAfterEdit);
  });

  test('a no-op edit (re-clicking an already-selected chip) does not leak pendingCaretRef', () => {
    // Regression for the case where buildChordName(next) === caretChord.chordName.
    // Before the fix, applyChordEdit would return the same source string, React
    // would bail on setState, the source-change effect would never fire, and
    // pendingCaretRef.current would never be cleared — blocking
    // onChordSelectionChange from moving the caret on the next preview chord click.
    mount();
    caretTo(1); // select `[G]`
    const callsBefore = setCaretSpy.mock.calls.length;
    act(() => {
      // Same parts as the existing chord — G major, no accidental, no suffix.
      latest.inspectorProps.onChange({ root: 'G', accidental: '', suffix: '', bass: '' });
    });
    // Source must not change (the guard bails early).
    expect(currentSource).toBe(SOURCE);
    // onChordSelectionChange must still work after the no-op — it would silently
    // return early if pendingCaretRef were set.
    act(() => {
      latest.onChordSelectionChange({ line: 1, offset: 7, ordinal: 0, nonce: 1 });
    });
    // The click moved the caret to Bbm7 (offset 10 → col 11 inside bracket).
    expect(setCaretSpy.mock.calls.length).toBeGreaterThan(callsBefore);
  });

  test('under an active transpose, editing is gated: idle + note, no Insert', () => {
    mount(SOURCE, 2); // CLI transpose +2, no capo -> not source-editable
    caretTo(1); // would be `[G]` but the gate blocks resolution
    expect(latest.inspectorProps.selected).toBe(false);
    expect(latest.chordSelection).toBeNull();
    expect(latest.inspectorProps.onInsert).toBeUndefined();
    expect(latest.inspectorProps.note).toMatch(/transpose/i);
  });
});
