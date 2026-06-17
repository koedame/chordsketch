import { act, render, waitFor } from '@testing-library/react';
import { useRef, useState } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { ChordSourceAreaHandle } from '../src/chord-source-area';
import { useChordEditor, type UseChordEditor } from '../src/use-chord-editor';
import type { ChordAudioWasmLoader } from '../src/use-chord-audio';
import { resetSharedAudioContextForTests } from '../src/audio-context';

// The hook drives a controlled source: `onSourceChange` feeds the parent
// state, which re-renders the hook with the new source (mirroring how
// `<ChordProEditor>` / the playground wire it). A tiny harness owns that
// loop and exposes the latest hook result + the fake editor handle's
// `setCaret` spy to each test.

const SOURCE = '[G]Almost [Bbm7]heaven';

let latest: UseChordEditor;
let currentSource: string;
let setCaretSpy: ReturnType<typeof vi.fn>;

function Harness({
  initial,
  transpose,
  chordAudio,
  chordAudioLoader,
}: {
  initial: string;
  transpose?: number;
  chordAudio?: boolean;
  chordAudioLoader?: ChordAudioWasmLoader;
}): null {
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
  latest = useChordEditor({
    source,
    onSourceChange: setSource,
    transpose,
    editorRef: ref,
    chordAudio,
    chordAudioLoader,
  });
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
  test('idle before the caret reports a position: no selection, no Remove', () => {
    mount();
    expect(latest.inspectorProps.selected).toBe(false);
    expect(latest.chordSelection).toBeNull();
    // Edit-only footer: nothing to remove until a chord is selected.
    expect(latest.inspectorProps.onRemove).toBeUndefined();
  });

  test('a caret on a chord selects it and reflects its parts', () => {
    mount();
    caretTo(1); // inside `[G]`
    expect(latest.inspectorProps.selected).toBe(true);
    expect(latest.inspectorProps.chordName).toBe('G');
    expect(latest.chordSelection).toMatchObject({ line: 1, offset: 0, ordinal: 0 });
    // Remove is offered only while a chord is selected (edit-only footer).
    expect(latest.inspectorProps.onRemove).toBeTypeOf('function');
    // Caret in the lyrics deselects.
    caretTo(5); // inside "Almost"
    expect(latest.inspectorProps.selected).toBe(false);
    expect(latest.chordSelection).toBeNull();
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

  test('clicking a preview chord moves the editor caret onto it', () => {
    mount();
    // `[Bbm7]` opens at column 10; the hook moves the caret just inside.
    act(() => {
      latest.onChordSelectionChange({ line: 1, offset: 7, ordinal: 0, nonce: 1 });
    });
    expect(setCaretSpy).toHaveBeenLastCalledWith(11);
  });

  test('deselecting (null) moves the caret off the selected chord', () => {
    mount();
    caretTo(1); // select `[G]` (col 0..2)
    expect(latest.inspectorProps.selected).toBe(true);
    act(() => {
      latest.onChordSelectionChange(null);
    });
    // Caret lands just past `[G]`'s `]` (col 3, in the lyrics), so the
    // caret-derived selection clears once the editor reports it back.
    expect(setCaretSpy).toHaveBeenLastCalledWith(3);
    caretTo(3);
    expect(latest.inspectorProps.selected).toBe(false);
    expect(latest.chordSelection).toBeNull();
  });

  test('deselecting an adjacent stacked chord falls back to end of line', () => {
    // `[A][B]word`: col 3 (just past [A]'s `]`) equals [B]'s `[`, which
    // findChordAtCaret would re-select. The deselect must skip past it to
    // the end of the line, which is off every chord on it.
    mount('[A][B]word');
    act(() => {
      latest.onCaretChange({ line: 1, column: 1, lineLength: 10 }); // inside [A]
    });
    expect(latest.inspectorProps.selected).toBe(true);
    act(() => {
      latest.onChordSelectionChange(null);
    });
    expect(setCaretSpy).toHaveBeenLastCalledWith('[A][B]word'.length);
  });

  test('deselecting a chord on a later line uses that line base offset', () => {
    // Locks in the multi-line `lineBaseOffset` arithmetic in the
    // deselect branch: `[G]` sits on line 2, so the caret target is the
    // line-2 base (9) + past its `]` (3) = 12, just after `]` in "two".
    mount('line one\n[G]two');
    act(() => {
      latest.onCaretChange({ line: 2, column: 1, lineLength: 6 }); // inside [G]
    });
    expect(latest.inspectorProps.selected).toBe(true);
    act(() => {
      latest.onChordSelectionChange(null);
    });
    expect(setCaretSpy).toHaveBeenLastCalledWith(12);
  });

  test('deselecting with no chord under the caret is a no-op', () => {
    mount();
    caretTo(5); // in the lyrics, no chord selected
    const callsBefore = setCaretSpy.mock.calls.length;
    act(() => {
      latest.onChordSelectionChange(null);
    });
    expect(setCaretSpy.mock.calls.length).toBe(callsBefore);
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

  test('repositioning a chord lands the caret inside the moved bracket so it stays selected', () => {
    mount();
    // Move `[G]` (col 0, len 3) three lyric characters into "Almost".
    act(() => {
      latest.onChordReposition({
        fromLine: 1,
        fromColumn: 0,
        fromLength: 3,
        toLine: 1,
        toLyricsOffset: 3,
        chord: 'G',
        copy: false,
        expected: 'G',
      });
    });
    // Source rewritten: G removed from col 0, re-inserted inside "Almost".
    expect(currentSource).toBe('Alm[G]ost [Bbm7]heaven');
    // The caret lands just after the moved bracket's `[` (col 4), NOT
    // after its `]` (col 6) — the latter would sit in the lyrics and
    // deselect the chord. This is the post-drop "keep it selected" fix.
    expect(setCaretSpy).toHaveBeenLastCalledWith(4);
    // And the caret-driven selection re-resolves onto the moved chord
    // once the editor reports the restored caret.
    caretTo(4);
    expect(latest.inspectorProps.selected).toBe(true);
    expect(latest.chordSelection).toMatchObject({ line: 1, offset: 3, ordinal: 0 });
  });

  test('a reposition that no-ops on the expected-token guard does not move the caret', () => {
    mount();
    // `expected` does not match the token at the `from` span, so
    // applyChordReposition returns the source unchanged; the deferred
    // caret restore must not fire (React bails on the equal setState).
    act(() => {
      latest.onChordReposition({
        fromLine: 1,
        fromColumn: 0,
        fromLength: 3,
        toLine: 1,
        toLyricsOffset: 3,
        chord: 'G',
        copy: false,
        expected: 'Wrong',
      });
    });
    expect(currentSource).toBe(SOURCE);
    expect(setCaretSpy).not.toHaveBeenCalled();
  });

  test('under an active transpose, editing is gated: idle state + note', () => {
    mount(SOURCE, 2); // CLI transpose +2, no capo -> not source-editable
    caretTo(1); // would be `[G]` but the gate blocks resolution
    expect(latest.inspectorProps.selected).toBe(false);
    expect(latest.chordSelection).toBeNull();
    expect(latest.inspectorProps.onRemove).toBeUndefined();
    expect(latest.inspectorProps.note).toMatch(/transpose/i);
  });
});

// ---- Chord-audio integration (#2652 follow-up) --------------------
// The hook owns a single audio instance so a panel-driven mutation
// auditions the chord through the SAME instance the host forwards to the
// preview. jsdom has no Web Audio API, so a minimal fake records the
// oscillators `play` creates; the wasm `chordPitches` loader is stubbed.

describe('useChordEditor chord-audio', () => {
  class FakeOscillator {
    type = '';
    onended: (() => void) | null = null;
    frequency = { setValueAtTime: vi.fn() };
    connect = vi.fn();
    disconnect = vi.fn();
    start = vi.fn();
    stop = vi.fn();
  }
  class FakeAudioContext {
    static instances: FakeAudioContext[] = [];
    state: 'suspended' | 'running' | 'closed' = 'running';
    currentTime = 0;
    destination = {};
    oscillators: FakeOscillator[] = [];
    resume = vi.fn(() => Promise.resolve());
    createOscillator = vi.fn(() => {
      const osc = new FakeOscillator();
      this.oscillators.push(osc);
      return osc;
    });
    createGain = vi.fn(() => ({
      gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
      connect: vi.fn(),
      disconnect: vi.fn(),
    }));
    constructor() {
      FakeAudioContext.instances.push(this);
    }
  }

  // `[G]` → a real triad, `[G7]` → a 4-note voicing so a retype produces
  // a distinguishable oscillator count.
  const loadCalls = vi.fn();
  const makeLoader = (): ChordAudioWasmLoader => () => {
    loadCalls();
    return Promise.resolve({
      default: () => Promise.resolve(),
      chordPitches: (chord: string): Uint8Array | undefined => {
        if (chord === 'G') return new Uint8Array([55, 59, 62]);
        if (chord === 'G7') return new Uint8Array([55, 59, 62, 65]);
        return undefined;
      },
    });
  };

  const originalAudioContext = (globalThis as { AudioContext?: unknown }).AudioContext;

  beforeEach(() => {
    FakeAudioContext.instances = [];
    loadCalls.mockClear();
    resetSharedAudioContextForTests();
    (window as unknown as { AudioContext: unknown }).AudioContext = FakeAudioContext;
  });

  afterEach(() => {
    resetSharedAudioContextForTests();
    if (originalAudioContext === undefined) {
      delete (window as unknown as { AudioContext?: unknown }).AudioContext;
    } else {
      (window as unknown as { AudioContext: unknown }).AudioContext = originalAudioContext;
    }
  });

  /** Mount with audio on and wait for the wasm preload to resolve so a
   * synchronous `play` inside an edit can read the pitch module. */
  async function mountWithAudioLoaded() {
    setCaretSpy = vi.fn();
    const loader = makeLoader();
    render(<Harness initial={SOURCE} chordAudio chordAudioLoader={loader} />);
    await waitFor(() => expect(loadCalls).toHaveBeenCalled());
    await act(async () => {
      await Promise.resolve();
    });
  }

  test('exposes a non-null chordAudio config when audio is on and supported', () => {
    setCaretSpy = vi.fn();
    render(<Harness initial={SOURCE} chordAudio chordAudioLoader={makeLoader()} />);
    expect(latest.chordAudio).not.toBeNull();
    expect(latest.chordAudio?.enabled).toBe(true);
    expect(latest.chordAudio?.play).toBeTypeOf('function');
  });

  test('chordAudio config is null when the feature is off', () => {
    setCaretSpy = vi.fn();
    render(<Harness initial={SOURCE} chordAudioLoader={makeLoader()} />);
    expect(latest.chordAudio).toBeNull();
  });

  test('editing a chord in the panel auditions the new chord', async () => {
    await mountWithAudioLoaded();
    caretTo(1); // select `[G]`
    act(() => {
      latest.inspectorProps.onChange({ root: 'G', accidental: '', suffix: '7', bass: '' });
    });
    // The retype rewrote the source AND sounded the new chord (G7 → 4
    // oscillators).
    expect(currentSource).toBe('[G7]Almost [Bbm7]heaven');
    const ctx = FakeAudioContext.instances[0]!;
    expect(ctx.oscillators).toHaveLength(4);
  });

  test('moving a chord with the panel buttons re-auditions it', async () => {
    await mountWithAudioLoaded();
    caretTo(1); // select `[G]`
    act(() => {
      latest.inspectorProps.onNudge(1);
    });
    // `[G]` (3-note voicing) re-sounded on the move.
    const ctx = FakeAudioContext.instances[0]!;
    expect(ctx.oscillators).toHaveLength(3);
  });

  test('onChordReposition does NOT audition (the preview wrapper owns that path — no double play)', async () => {
    // Regression: the preview drag-drop / arrow-nudge routes through
    // `<ChordSheet>`'s single audition wrapper, which both applies this
    // callback AND plays. If this callback also played, controlled mode
    // would double-fire. So `onChordReposition` must stay silent.
    await mountWithAudioLoaded();
    act(() => {
      latest.onChordReposition({
        fromLine: 1,
        fromColumn: 0,
        fromLength: 3,
        toLine: 1,
        toLyricsOffset: 3,
        chord: 'G',
        copy: false,
        expected: 'G',
      });
    });
    // The source moved, but no chord was sounded from here.
    expect(currentSource).not.toBe(SOURCE);
    const ctx = FakeAudioContext.instances[0];
    expect(ctx?.oscillators ?? []).toHaveLength(0);
  });
});
