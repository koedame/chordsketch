// Vitest cases for the bar-cell keyboard shortcuts (#2376):
//   Delete / Backspace          → remove the focused bar
//   Alt+ArrowLeft / ArrowRight  → reorder the focused bar within
//                                 its section
//
// Behaviour mirrors the per-bar `×` / `←` / `→` UI buttons that
// shipped in #2365; the shortcut tests here focus on the focus
// bookkeeping that the click-flow tests in `structural.test.ts` do
// not exercise (the click flow lands focus on the action buttons,
// the keyboard flow lands focus back on the bar cell so a
// repeat-press keeps moving the same bar).

import { describe, expect, test, vi } from 'vitest';
import { createIrealbEditor, type IrealbWasm } from '../src/index';
import type { IrealSong } from '../src/ast';

const SAMPLE_SONG: IrealSong = {
  title: 'Keyboard Sample',
  composer: null,
  style: null,
  key_signature: { root: { note: 'C', accidental: 'natural' }, mode: 'major' },
  time_signature: { numerator: 4, denominator: 4 },
  tempo: null,
  transpose: 0,
  sections: [
    {
      label: { kind: 'letter', value: 'A' },
      bars: [
        {
          start: 'single',
          end: 'single',
          chords: [
            {
              chord: {
                root: { note: 'C', accidental: 'natural' },
                quality: { kind: 'major' },
                bass: null,
              },
              position: { beat: 1, subdivision: 0 },
            },
          ],
          ending: null,
          symbol: null,
        },
        {
          start: 'single',
          end: 'single',
          chords: [
            {
              chord: {
                root: { note: 'F', accidental: 'natural' },
                quality: { kind: 'major' },
                bass: null,
              },
              position: { beat: 1, subdivision: 0 },
            },
          ],
          ending: null,
          symbol: null,
        },
        {
          start: 'single',
          end: 'single',
          chords: [
            {
              chord: {
                root: { note: 'G', accidental: 'natural' },
                quality: { kind: 'major' },
                bass: null,
              },
              position: { beat: 1, subdivision: 0 },
            },
          ],
          ending: null,
          symbol: null,
        },
      ],
    },
  ],
};
const SAMPLE_URL = 'irealb://kbd-sample';

function makeStubWasm(): IrealbWasm & {
  parseIrealb: ReturnType<typeof vi.fn>;
  serializeIrealb: ReturnType<typeof vi.fn>;
} {
  const parseIrealb = vi.fn((input: string): string => {
    if (input === SAMPLE_URL) return JSON.stringify(SAMPLE_SONG);
    if (input.startsWith('irealb://json:')) {
      return decodeURIComponent(input.slice('irealb://json:'.length));
    }
    throw new Error(`stub parseIrealb: unknown URL: ${input}`);
  });
  const serializeIrealb = vi.fn(
    (input: string): string => `irealb://json:${encodeURIComponent(input)}`,
  );
  return { parseIrealb, serializeIrealb };
}

function readSong(editor: ReturnType<typeof createIrealbEditor>): IrealSong {
  const url = editor.getValue();
  return JSON.parse(decodeURIComponent(url.slice('irealb://json:'.length))) as IrealSong;
}

interface KeydownOptions {
  alt?: boolean;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
}

function dispatchKey(target: HTMLElement, key: string, opts: KeydownOptions = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key,
    altKey: opts.alt ?? false,
    ctrlKey: opts.ctrl ?? false,
    metaKey: opts.meta ?? false,
    shiftKey: opts.shift ?? false,
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(event);
  return event;
}

function getCells(editor: ReturnType<typeof createIrealbEditor>): HTMLButtonElement[] {
  return Array.from(
    editor.element.querySelectorAll<HTMLButtonElement>('.irealb-editor__bar'),
  );
}

describe('keyboard shortcuts: bar delete', () => {
  test('Delete on a focused bar cell removes the bar (no confirmation)', () => {
    const wasm = makeStubWasm();
    const onChange = vi.fn();
    const editor = createIrealbEditor({ initialValue: SAMPLE_URL, wasm });
    document.body.appendChild(editor.element);
    editor.onChange(onChange);

    const cells = getCells(editor);
    expect(cells.length).toBe(3);
    cells[1]?.focus();
    dispatchKey(cells[1] as HTMLElement, 'Delete');

    const song = readSong(editor);
    expect(song.sections[0]?.bars.length).toBe(2);
    // The middle bar (F) was deleted; remaining bars are C, G.
    expect(song.sections[0]?.bars[0]?.chords[0]?.chord.root.note).toBe('C');
    expect(song.sections[0]?.bars[1]?.chords[0]?.chord.root.note).toBe('G');
    expect(onChange).toHaveBeenCalledTimes(1);

    editor.destroy();
    editor.element.remove();
  });

  test('Backspace also triggers bar deletion', () => {
    const wasm = makeStubWasm();
    const editor = createIrealbEditor({ initialValue: SAMPLE_URL, wasm });
    document.body.appendChild(editor.element);

    const cells = getCells(editor);
    cells[0]?.focus();
    dispatchKey(cells[0] as HTMLElement, 'Backspace');

    expect(readSong(editor).sections[0]?.bars.length).toBe(2);

    editor.destroy();
    editor.element.remove();
  });

  test('Delete focuses the next-sibling bar cell after the bar is removed', () => {
    const wasm = makeStubWasm();
    const editor = createIrealbEditor({ initialValue: SAMPLE_URL, wasm });
    document.body.appendChild(editor.element);

    const cells = getCells(editor);
    cells[0]?.focus();
    dispatchKey(cells[0] as HTMLElement, 'Delete');

    // The cell that was at index 1 (F) now sits at index 0 and
    // should hold focus so the user can delete again with the same
    // key.
    const focused = document.activeElement as HTMLButtonElement | null;
    expect(focused?.classList.contains('irealb-editor__bar')).toBe(true);
    const wrapper = focused?.closest<HTMLElement>('[data-bar-index]');
    expect(wrapper?.getAttribute('data-bar-index')).toBe('0');
    expect(focused?.textContent?.trim().startsWith('F')).toBe(true);

    editor.destroy();
    editor.element.remove();
  });

  test('Delete on the last remaining bar in a section focuses the "+ Add bar" trailer', () => {
    // Trim section A down to a single bar so the keyboard delete
    // empties the section. Without an explicit fallback the focus
    // would drop to <body> and a keyboard user would have to
    // re-discover the section's add-bar trailer with Tab.
    const wasm = makeStubWasm();
    const seed: IrealSong = JSON.parse(JSON.stringify(SAMPLE_SONG));
    const sectionA = seed.sections[0];
    if (!sectionA) throw new Error('seed missing section A');
    sectionA.bars = sectionA.bars.slice(0, 1);
    const seedUrl = `irealb://json:${encodeURIComponent(JSON.stringify(seed))}`;
    const editor = createIrealbEditor({ initialValue: seedUrl, wasm });
    document.body.appendChild(editor.element);

    const cell = getCells(editor)[0];
    cell?.focus();
    dispatchKey(cell as HTMLElement, 'Delete');

    const focused = document.activeElement as HTMLElement | null;
    expect(focused?.classList.contains('irealb-editor__add-bar')).toBe(true);

    editor.destroy();
    editor.element.remove();
  });

  test('Delete with Ctrl modifier does not trigger the shortcut', () => {
    const wasm = makeStubWasm();
    const onChange = vi.fn();
    const editor = createIrealbEditor({ initialValue: SAMPLE_URL, wasm });
    document.body.appendChild(editor.element);
    editor.onChange(onChange);

    const cells = getCells(editor);
    cells[0]?.focus();
    dispatchKey(cells[0] as HTMLElement, 'Delete', { ctrl: true });

    expect(readSong(editor).sections[0]?.bars.length).toBe(3);
    expect(onChange).not.toHaveBeenCalled();

    editor.destroy();
    editor.element.remove();
  });
});

describe('keyboard shortcuts: bar reorder', () => {
  test('Alt+ArrowLeft moves the bar one position left and re-focuses the cell', () => {
    const wasm = makeStubWasm();
    const editor = createIrealbEditor({ initialValue: SAMPLE_URL, wasm });
    document.body.appendChild(editor.element);

    const cells = getCells(editor);
    cells[1]?.focus(); // F bar at index 1
    const event = dispatchKey(cells[1] as HTMLElement, 'ArrowLeft', { alt: true });

    expect(event.defaultPrevented).toBe(true);

    const song = readSong(editor);
    // F (was at 1) moved to index 0; C (was at 0) shifted to 1.
    expect(song.sections[0]?.bars[0]?.chords[0]?.chord.root.note).toBe('F');
    expect(song.sections[0]?.bars[1]?.chords[0]?.chord.root.note).toBe('C');

    // Focus follows the moved bar (now at index 0).
    const focused = document.activeElement as HTMLButtonElement | null;
    expect(focused?.classList.contains('irealb-editor__bar')).toBe(true);
    const wrapper = focused?.closest<HTMLElement>('[data-bar-index]');
    expect(wrapper?.getAttribute('data-bar-index')).toBe('0');
    expect(focused?.textContent?.trim().startsWith('F')).toBe(true);

    editor.destroy();
    editor.element.remove();
  });

  test('Alt+ArrowRight moves the bar one position right and re-focuses the cell', () => {
    const wasm = makeStubWasm();
    const editor = createIrealbEditor({ initialValue: SAMPLE_URL, wasm });
    document.body.appendChild(editor.element);

    const cells = getCells(editor);
    cells[0]?.focus(); // C bar at index 0
    dispatchKey(cells[0] as HTMLElement, 'ArrowRight', { alt: true });

    const song = readSong(editor);
    expect(song.sections[0]?.bars[0]?.chords[0]?.chord.root.note).toBe('F');
    expect(song.sections[0]?.bars[1]?.chords[0]?.chord.root.note).toBe('C');

    const focused = document.activeElement as HTMLButtonElement | null;
    const wrapper = focused?.closest<HTMLElement>('[data-bar-index]');
    expect(wrapper?.getAttribute('data-bar-index')).toBe('1');
    expect(focused?.textContent?.trim().startsWith('C')).toBe(true);

    editor.destroy();
    editor.element.remove();
  });

  test('Alt+ArrowLeft on the first bar is a bounded no-op', () => {
    const wasm = makeStubWasm();
    const onChange = vi.fn();
    const editor = createIrealbEditor({ initialValue: SAMPLE_URL, wasm });
    document.body.appendChild(editor.element);
    editor.onChange(onChange);

    const cells = getCells(editor);
    cells[0]?.focus();
    const event = dispatchKey(cells[0] as HTMLElement, 'ArrowLeft', { alt: true });

    // The shortcut still preventDefaults so the browser does not
    // trigger a back-navigation, but it does not mutate the AST.
    expect(event.defaultPrevented).toBe(true);
    const song = readSong(editor);
    expect(song.sections[0]?.bars[0]?.chords[0]?.chord.root.note).toBe('C');
    expect(onChange).not.toHaveBeenCalled();

    editor.destroy();
    editor.element.remove();
  });

  test('Alt+ArrowRight on the last bar is a bounded no-op', () => {
    const wasm = makeStubWasm();
    const onChange = vi.fn();
    const editor = createIrealbEditor({ initialValue: SAMPLE_URL, wasm });
    document.body.appendChild(editor.element);
    editor.onChange(onChange);

    const cells = getCells(editor);
    cells[2]?.focus(); // G at the end of the section
    const event = dispatchKey(cells[2] as HTMLElement, 'ArrowRight', { alt: true });

    expect(event.defaultPrevented).toBe(true);
    expect(readSong(editor).sections[0]?.bars[2]?.chords[0]?.chord.root.note).toBe('G');
    expect(onChange).not.toHaveBeenCalled();

    editor.destroy();
    editor.element.remove();
  });

  test('Repeated Alt+ArrowLeft moves the same bar leftward without losing focus', () => {
    // Canonical "follow the moved item" check: a user starts on the
    // last bar (G at index 2) and presses Alt+Left twice; the bar
    // should end up at index 0 and focus should remain on it. Pins
    // the focus contract called out in the issue ACs.
    const wasm = makeStubWasm();
    const editor = createIrealbEditor({ initialValue: SAMPLE_URL, wasm });
    document.body.appendChild(editor.element);

    const cells = getCells(editor);
    cells[2]?.focus(); // G at index 2
    let active = document.activeElement as HTMLElement;
    dispatchKey(active, 'ArrowLeft', { alt: true });
    active = document.activeElement as HTMLElement;
    dispatchKey(active, 'ArrowLeft', { alt: true });

    const song = readSong(editor);
    // G has migrated to the front of the section.
    expect(song.sections[0]?.bars[0]?.chords[0]?.chord.root.note).toBe('G');
    expect(song.sections[0]?.bars[1]?.chords[0]?.chord.root.note).toBe('C');
    expect(song.sections[0]?.bars[2]?.chords[0]?.chord.root.note).toBe('F');

    // Focus is on the moved bar (G) at its new index 0.
    const focused = document.activeElement as HTMLButtonElement | null;
    expect(focused?.classList.contains('irealb-editor__bar')).toBe(true);
    const wrapper = focused?.closest<HTMLElement>('[data-bar-index]');
    expect(wrapper?.getAttribute('data-bar-index')).toBe('0');
    expect(focused?.textContent?.trim().startsWith('G')).toBe(true);

    editor.destroy();
    editor.element.remove();
  });

  test('Bar-cell shortcut does not fire while a bar popover holds focus', () => {
    // The popover is a W3C APG dialog with a Tab focus trap, so a
    // user driving the keyboard cannot focus a bar cell while the
    // popover is open. Pinning the invariant here guards against a
    // future refactor that drops the trap (or adds a non-modal mode)
    // and would otherwise let Delete/Backspace silently delete the
    // bar the popover is editing.
    const wasm = makeStubWasm();
    const onChange = vi.fn();
    const editor = createIrealbEditor({ initialValue: SAMPLE_URL, wasm });
    document.body.appendChild(editor.element);
    editor.onChange(onChange);

    const cells = getCells(editor);
    cells[1]?.click(); // open popover for the F bar
    expect(editor.element.querySelector('.irealb-editor__popover')).not.toBeNull();

    // While the popover is open, focus is trapped inside it. The
    // bar cell does not receive keyboard events; dispatching one
    // directly on the (now-blurred) cell verifies that no AST
    // mutation occurs even if a synthetic event somehow reaches it.
    // The test asserts the AST is unchanged — covering both the
    // "focus trap prevented the keystroke" and the "handler ran but
    // no side effect" reading.
    dispatchKey(cells[1] as HTMLElement, 'Delete');
    expect(readSong(editor).sections[0]?.bars.length).toBe(3);
    // The popover open did not call onChange; deleting via Delete
    // should not have fired it either.
    expect(onChange).not.toHaveBeenCalled();

    editor.destroy();
    editor.element.remove();
  });

  test('Alt+Shift+ArrowLeft does not trigger the shortcut', () => {
    // The Alt+Shift+arrow chord is reserved by some IMEs / screen
    // readers (e.g. NVDA / VoiceOver overlay key) for jump-by-word
    // selection. Keep the editor out of that path so users with
    // assistive tech do not see bars silently reorder when they
    // intended to extend a selection.
    const wasm = makeStubWasm();
    const onChange = vi.fn();
    const editor = createIrealbEditor({ initialValue: SAMPLE_URL, wasm });
    document.body.appendChild(editor.element);
    editor.onChange(onChange);

    const cells = getCells(editor);
    cells[1]?.focus();
    const event = dispatchKey(cells[1] as HTMLElement, 'ArrowLeft', { alt: true, shift: true });

    expect(event.defaultPrevented).toBe(false);
    expect(readSong(editor).sections[0]?.bars[0]?.chords[0]?.chord.root.note).toBe('C');
    expect(onChange).not.toHaveBeenCalled();

    editor.destroy();
    editor.element.remove();
  });
});
