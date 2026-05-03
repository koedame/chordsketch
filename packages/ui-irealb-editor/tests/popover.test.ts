// Unit tests for the bar-edit popover (#2364). Wasm bridge is
// stubbed identically to `editor.test.ts`; these tests exercise the
// popover's open / mutate / save / cancel paths through the public
// `createIrealbEditor` factory rather than `openBarPopover` directly,
// so we cover both the dialog itself and the integration with
// `index.ts` (Bar splice on save, re-render, fireUserEdit, focus
// return on close, dismissal paths).

import { describe, expect, test, vi } from 'vitest';
import { createIrealbEditor, type IrealbWasm } from '../src/index';
import type { Bar, IrealSong } from '../src/ast';

// A two-section, three-bar fixture so reorder, splice, and per-bar
// targeting are all exercisable. Section A has two bars; section B
// has one.
const SAMPLE_SONG: IrealSong = {
  title: 'Popover Sample',
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
      ],
    },
    {
      label: { kind: 'letter', value: 'B' },
      bars: [
        {
          start: 'single',
          end: 'single',
          chords: [
            {
              chord: {
                root: { note: 'G', accidental: 'natural' },
                quality: { kind: 'dominant7' },
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
const SAMPLE_URL = 'irealb://popover-sample';

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

function bar(editor: ReturnType<typeof createIrealbEditor>, n: number): HTMLButtonElement {
  const cells = editor.element.querySelectorAll<HTMLButtonElement>('.irealb-editor__bar');
  const target = cells[n];
  if (!target) throw new Error(`bar #${n} not rendered (have ${cells.length})`);
  return target;
}

function popoverOf(
  editor: ReturnType<typeof createIrealbEditor>,
): HTMLElement {
  const dialog = editor.element.querySelector<HTMLElement>('.irealb-editor__popover');
  if (!dialog) throw new Error('popover not mounted');
  return dialog;
}

function selectIn(root: HTMLElement, n: number): HTMLSelectElement {
  const selects = root.querySelectorAll<HTMLSelectElement>('select');
  const target = selects[n];
  if (!target) throw new Error(`select #${n} not in popover (have ${selects.length})`);
  return target;
}

function inputIn(root: HTMLElement, selector: string): HTMLInputElement {
  const target = root.querySelector<HTMLInputElement>(selector);
  if (!target) throw new Error(`input ${selector} not in popover`);
  return target;
}

function clickButton(root: HTMLElement, label: string): HTMLButtonElement {
  const btns = Array.from(root.querySelectorAll<HTMLButtonElement>('button'));
  const target = btns.find((b) => b.textContent?.trim() === label);
  if (!target) throw new Error(`button "${label}" not in dialog`);
  target.click();
  return target;
}

describe('bar-edit popover', () => {
  test('clicking a bar cell mounts the dialog with role and modal attrs', () => {
    const wasm = makeStubWasm();
    const editor = createIrealbEditor({ initialValue: SAMPLE_URL, wasm });

    expect(editor.element.querySelector('.irealb-editor__popover')).toBeNull();
    bar(editor, 0).click();
    const dialog = popoverOf(editor);
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-label')).toBe('Edit bar');

    editor.destroy();
  });

  test('Save commits start/end barline edits to the AST and fires onChange', () => {
    const wasm = makeStubWasm();
    const editor = createIrealbEditor({ initialValue: SAMPLE_URL, wasm });
    const onChange = vi.fn();
    editor.onChange(onChange);

    bar(editor, 0).click();
    const dialog = popoverOf(editor);
    // First two selects are start/end barlines (form rendered in
    // declaration order).
    const startSelect = selectIn(dialog, 0);
    const endSelect = selectIn(dialog, 1);
    startSelect.value = 'open_repeat';
    startSelect.dispatchEvent(new Event('change', { bubbles: true }));
    endSelect.value = 'close_repeat';
    endSelect.dispatchEvent(new Event('change', { bubbles: true }));
    clickButton(dialog, 'Save');

    const song = readSong(editor);
    expect(song.sections[0]?.bars[0]?.start).toBe('open_repeat');
    expect(song.sections[0]?.bars[0]?.end).toBe('close_repeat');
    // Other bars untouched.
    expect(song.sections[0]?.bars[1]?.start).toBe('single');
    expect(onChange).toHaveBeenCalledTimes(1);
    // Popover dismissed after Save.
    expect(editor.element.querySelector('.irealb-editor__popover')).toBeNull();

    editor.destroy();
  });

  test('Cancel discards edits and does not fire onChange', () => {
    const wasm = makeStubWasm();
    const editor = createIrealbEditor({ initialValue: SAMPLE_URL, wasm });
    const onChange = vi.fn();
    editor.onChange(onChange);

    bar(editor, 0).click();
    const dialog = popoverOf(editor);
    const startSelect = selectIn(dialog, 0);
    startSelect.value = 'final';
    startSelect.dispatchEvent(new Event('change', { bubbles: true }));
    clickButton(dialog, 'Cancel');

    const song = readSong(editor);
    expect(song.sections[0]?.bars[0]?.start).toBe('single'); // unchanged
    expect(onChange).not.toHaveBeenCalled();
    expect(editor.element.querySelector('.irealb-editor__popover')).toBeNull();

    editor.destroy();
  });

  test('Escape dismisses the popover without committing', () => {
    const wasm = makeStubWasm();
    const editor = createIrealbEditor({ initialValue: SAMPLE_URL, wasm });
    const onChange = vi.fn();
    editor.onChange(onChange);

    bar(editor, 0).click();
    const dialog = popoverOf(editor);
    const startSelect = selectIn(dialog, 0);
    startSelect.value = 'double';
    startSelect.dispatchEvent(new Event('change', { bubbles: true }));
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(readSong(editor).sections[0]?.bars[0]?.start).toBe('single');
    expect(onChange).not.toHaveBeenCalled();
    expect(editor.element.querySelector('.irealb-editor__popover')).toBeNull();

    editor.destroy();
  });

  test('outside-click dismisses the popover without committing', () => {
    const wasm = makeStubWasm();
    const editor = createIrealbEditor({ initialValue: SAMPLE_URL, wasm });
    document.body.appendChild(editor.element);
    const onChange = vi.fn();
    editor.onChange(onChange);

    bar(editor, 0).click();
    expect(editor.element.querySelector('.irealb-editor__popover')).not.toBeNull();

    // Pointerdown anywhere in document.body that is not the dialog
    // and not the bar cell — the popover's dismissal listener
    // closes it. jsdom does not implement PointerEvent, so dispatch
    // a plain Event with the matching type — listeners are
    // registered by event-name and accept any Event subclass.
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(editor.element.querySelector('.irealb-editor__popover')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();

    editor.destroy();
    editor.element.remove();
  });

  test('add chord row, edit it, save -> AST gains the new BarChord', () => {
    const wasm = makeStubWasm();
    const editor = createIrealbEditor({ initialValue: SAMPLE_URL, wasm });

    bar(editor, 0).click();
    const dialog = popoverOf(editor);
    expect(readSong(editor).sections[0]?.bars[0]?.chords.length).toBe(1);
    clickButton(dialog, '+ Add chord');

    // The new row's selects come AFTER the existing row, so they
    // are the second cluster. Match by `data-row-index="1"`.
    const newRow = dialog.querySelector<HTMLElement>('[data-row-index="1"]');
    if (!newRow) throw new Error('new chord row not rendered');
    const rootSelect = selectIn(newRow, 0); // root letter
    const accSelect = selectIn(newRow, 1); // accidental
    const qualitySelect = selectIn(newRow, 2); // quality
    rootSelect.value = 'A';
    rootSelect.dispatchEvent(new Event('change', { bubbles: true }));
    accSelect.value = 'flat';
    accSelect.dispatchEvent(new Event('change', { bubbles: true }));
    qualitySelect.value = 'minor7';
    qualitySelect.dispatchEvent(new Event('change', { bubbles: true }));

    clickButton(dialog, 'Save');

    const chords = readSong(editor).sections[0]?.bars[0]?.chords ?? [];
    expect(chords.length).toBe(2);
    expect(chords[1]?.chord.root).toEqual({ note: 'A', accidental: 'flat' });
    expect(chords[1]?.chord.quality).toEqual({ kind: 'minor7' });

    editor.destroy();
  });

  test('reorder chord rows up/down', () => {
    const wasm = makeStubWasm();
    // Seed with two chords in the first bar so reorder has something
    // to swap.
    const seed: IrealSong = JSON.parse(JSON.stringify(SAMPLE_SONG));
    const firstBar = seed.sections[0]?.bars[0] as Bar;
    firstBar.chords.push({
      chord: {
        root: { note: 'D', accidental: 'natural' },
        quality: { kind: 'minor' },
        bass: null,
      },
      position: { beat: 3, subdivision: 0 },
    });
    const seedUrl = `irealb://json:${encodeURIComponent(JSON.stringify(seed))}`;
    const editor = createIrealbEditor({ initialValue: seedUrl, wasm });

    bar(editor, 0).click();
    const dialog = popoverOf(editor);
    const row1 = dialog.querySelector<HTMLElement>('[data-row-index="1"]');
    if (!row1) throw new Error('second chord row not rendered');
    // Click "↑" on the second row to swap with the first.
    const upBtn = Array.from(row1.querySelectorAll<HTMLButtonElement>('button')).find(
      (b) => b.getAttribute('aria-label') === 'Move chord up',
    );
    if (!upBtn) throw new Error('up button missing');
    upBtn.click();
    clickButton(dialog, 'Save');

    const chords = readSong(editor).sections[0]?.bars[0]?.chords ?? [];
    expect(chords[0]?.chord.root.note).toBe('D');
    expect(chords[1]?.chord.root.note).toBe('C');

    editor.destroy();
  });

  test('Custom quality input becomes visible and round-trips', () => {
    const wasm = makeStubWasm();
    const editor = createIrealbEditor({ initialValue: SAMPLE_URL, wasm });

    bar(editor, 0).click();
    const dialog = popoverOf(editor);
    const row = dialog.querySelector<HTMLElement>('[data-row-index="0"]');
    if (!row) throw new Error('first chord row not rendered');
    const qualitySelect = selectIn(row, 2);
    qualitySelect.value = 'custom';
    qualitySelect.dispatchEvent(new Event('change', { bubbles: true }));

    // Custom input is the only text input inside this row (bass
    // input is also text but has placeholder /X). Distinguish by
    // placeholder.
    const customInput = inputIn(row, 'input[placeholder^="e.g."]');
    expect(customInput.style.display).not.toBe('none');
    customInput.value = '7♯9';
    customInput.dispatchEvent(new Event('input', { bubbles: true }));

    clickButton(dialog, 'Save');

    const quality = readSong(editor).sections[0]?.bars[0]?.chords[0]?.chord.quality;
    expect(quality).toEqual({ kind: 'custom', value: '7♯9' });

    editor.destroy();
  });

  test('bass input parses A–G + sharp/flat into a ChordRoot', () => {
    const wasm = makeStubWasm();
    const editor = createIrealbEditor({ initialValue: SAMPLE_URL, wasm });

    bar(editor, 0).click();
    const dialog = popoverOf(editor);
    const row = dialog.querySelector<HTMLElement>('[data-row-index="0"]');
    if (!row) throw new Error('first chord row not rendered');
    const bassInput = inputIn(row, 'input[placeholder^="/X"]');
    bassInput.value = 'G♭';
    bassInput.dispatchEvent(new Event('input', { bubbles: true }));
    clickButton(dialog, 'Save');

    expect(readSong(editor).sections[0]?.bars[0]?.chords[0]?.chord.bass).toEqual({
      note: 'G',
      accidental: 'flat',
    });

    editor.destroy();
  });

  test('beat position select updates BarChord.position on save', () => {
    const wasm = makeStubWasm();
    const editor = createIrealbEditor({ initialValue: SAMPLE_URL, wasm });

    bar(editor, 0).click();
    const dialog = popoverOf(editor);
    const row = dialog.querySelector<HTMLElement>('[data-row-index="0"]');
    if (!row) throw new Error('first chord row not rendered');
    const posSelect = selectIn(row, 3);
    posSelect.value = '2.5';
    posSelect.dispatchEvent(new Event('change', { bubbles: true }));
    clickButton(dialog, 'Save');

    expect(readSong(editor).sections[0]?.bars[0]?.chords[0]?.position).toEqual({
      beat: 2,
      subdivision: 1,
    });

    editor.destroy();
  });

  test('Ending input updates Bar.ending; empty becomes null', () => {
    const wasm = makeStubWasm();
    const editor = createIrealbEditor({ initialValue: SAMPLE_URL, wasm });

    bar(editor, 0).click();
    const dialog = popoverOf(editor);
    const endingInput = inputIn(dialog, 'input[type="number"][min="1"]');
    endingInput.value = '2';
    endingInput.dispatchEvent(new Event('input', { bubbles: true }));
    clickButton(dialog, 'Save');
    expect(readSong(editor).sections[0]?.bars[0]?.ending).toBe(2);

    bar(editor, 0).click();
    const dialog2 = popoverOf(editor);
    const endingInput2 = inputIn(dialog2, 'input[type="number"][min="1"]');
    endingInput2.value = '';
    endingInput2.dispatchEvent(new Event('input', { bubbles: true }));
    clickButton(dialog2, 'Save');
    expect(readSong(editor).sections[0]?.bars[0]?.ending).toBeNull();

    editor.destroy();
  });

  test('MusicalSymbol select round-trips None / segno / fine', () => {
    const wasm = makeStubWasm();
    const editor = createIrealbEditor({ initialValue: SAMPLE_URL, wasm });

    bar(editor, 0).click();
    const dialog = popoverOf(editor);
    // Symbol select is the LAST select in the popover body (after
    // start/end barlines + per-row selects + ending input).
    const symbolSelects = dialog.querySelectorAll<HTMLSelectElement>('select');
    const symbolSelect = symbolSelects[symbolSelects.length - 1];
    if (!symbolSelect) throw new Error('symbol select missing');
    symbolSelect.value = 'segno';
    symbolSelect.dispatchEvent(new Event('change', { bubbles: true }));
    clickButton(dialog, 'Save');
    expect(readSong(editor).sections[0]?.bars[0]?.symbol).toBe('segno');

    bar(editor, 0).click();
    const dialog2 = popoverOf(editor);
    const symbolSelect2Set = dialog2.querySelectorAll<HTMLSelectElement>('select');
    const symbolSelect2 = symbolSelect2Set[symbolSelect2Set.length - 1];
    if (!symbolSelect2) throw new Error('symbol select missing on reopen');
    symbolSelect2.value = '';
    symbolSelect2.dispatchEvent(new Event('change', { bubbles: true }));
    clickButton(dialog2, 'Save');
    expect(readSong(editor).sections[0]?.bars[0]?.symbol).toBeNull();

    editor.destroy();
  });

  test('opening a second popover closes the first (one-at-a-time)', () => {
    const wasm = makeStubWasm();
    const editor = createIrealbEditor({ initialValue: SAMPLE_URL, wasm });

    bar(editor, 0).click();
    const first = popoverOf(editor);
    expect(editor.element.querySelectorAll('.irealb-editor__popover').length).toBe(1);
    bar(editor, 1).click();
    expect(editor.element.querySelectorAll('.irealb-editor__popover').length).toBe(1);
    // The new dialog is a fresh node, not the first one.
    const second = popoverOf(editor);
    expect(second).not.toBe(first);

    editor.destroy();
  });

  test('setValue() while popover open dismisses the popover', () => {
    const wasm = makeStubWasm();
    const editor = createIrealbEditor({ initialValue: SAMPLE_URL, wasm });

    bar(editor, 0).click();
    expect(editor.element.querySelector('.irealb-editor__popover')).not.toBeNull();

    // Programmatic load — must dismiss the popover so a stale Bar
    // reference does not corrupt the freshly-loaded chart on Save.
    const otherSong: IrealSong = { ...SAMPLE_SONG, title: 'Loaded' };
    editor.setValue(`irealb://json:${encodeURIComponent(JSON.stringify(otherSong))}`);
    expect(editor.element.querySelector('.irealb-editor__popover')).toBeNull();

    editor.destroy();
  });

  test('destroy() while popover open removes it', () => {
    const wasm = makeStubWasm();
    const editor = createIrealbEditor({ initialValue: SAMPLE_URL, wasm });
    document.body.appendChild(editor.element);

    bar(editor, 0).click();
    expect(editor.element.querySelector('.irealb-editor__popover')).not.toBeNull();
    editor.destroy();
    expect(editor.element.querySelector('.irealb-editor__popover')).toBeNull();

    editor.element.remove();
  });
});
