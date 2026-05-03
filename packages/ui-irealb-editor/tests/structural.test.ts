// Vitest cases for structural editing (#2365): section
// add / rename / delete / reorder, bar add / delete / reorder.
//
// The host stubs `promptSectionLabel` + `confirmDeleteSection` so
// the tests do not block on jsdom's window.prompt / window.confirm
// (which throw "not implemented" by default).

import { describe, expect, test, vi } from 'vitest';
import {
  createIrealbEditor,
  parseSectionLabel,
  type IrealbWasm,
} from '../src/index';
import type { IrealSong, SectionLabel } from '../src/ast';

const SAMPLE_SONG: IrealSong = {
  title: 'Structural Sample',
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
          chords: [],
          ending: null,
          symbol: null,
        },
        {
          start: 'single',
          end: 'single',
          chords: [],
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
          chords: [],
          ending: null,
          symbol: null,
        },
      ],
    },
  ],
};
const SAMPLE_URL = 'irealb://structural-sample';

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

function clickAction(editor: ReturnType<typeof createIrealbEditor>, ariaLabel: string, n = 0): void {
  const btns = Array.from(
    editor.element.querySelectorAll<HTMLButtonElement>(
      `button[aria-label="${ariaLabel}"]`,
    ),
  );
  const target = btns[n];
  if (!target) {
    throw new Error(`button[aria-label="${ariaLabel}"][${n}] not rendered (have ${btns.length})`);
  }
  target.click();
}

function clickByText(editor: ReturnType<typeof createIrealbEditor>, label: string): void {
  const btns = Array.from(editor.element.querySelectorAll<HTMLButtonElement>('button'));
  const target = btns.find((b) => b.textContent?.trim() === label);
  if (!target) throw new Error(`button "${label}" not rendered`);
  target.click();
}

describe('parseSectionLabel', () => {
  test('single letter A..Z -> Letter variant', () => {
    expect(parseSectionLabel('A')).toEqual({ kind: 'letter', value: 'A' });
    expect(parseSectionLabel('Z')).toEqual({ kind: 'letter', value: 'Z' });
  });

  test('named variants are case-insensitive', () => {
    expect(parseSectionLabel('Verse')).toEqual({ kind: 'verse' });
    expect(parseSectionLabel('chorus')).toEqual({ kind: 'chorus' });
    expect(parseSectionLabel('INTRO')).toEqual({ kind: 'intro' });
    expect(parseSectionLabel('Outro')).toEqual({ kind: 'outro' });
    expect(parseSectionLabel('bridge')).toEqual({ kind: 'bridge' });
  });

  test('arbitrary text -> Custom variant', () => {
    expect(parseSectionLabel('Pre-Chorus')).toEqual({
      kind: 'custom',
      value: 'Pre-Chorus',
    });
  });

  test('empty / whitespace -> null (cancellation)', () => {
    expect(parseSectionLabel('')).toBeNull();
    expect(parseSectionLabel('   ')).toBeNull();
  });

  test('single lowercase letter is normalised to uppercase Letter', () => {
    // iReal Pro section labels are uppercase by convention; normalising
    // prevents a user who types 'a' from accidentally creating a Custom
    // label rather than the intended Letter variant.
    expect(parseSectionLabel('a')).toEqual({ kind: 'letter', value: 'A' });
    expect(parseSectionLabel('z')).toEqual({ kind: 'letter', value: 'Z' });
  });

  test('multi-letter all-caps falls into Custom (not Letter)', () => {
    // The Letter variant is for single uppercase letters only;
    // "AB" is not a valid jazz-form label, so it round-trips as
    // a Custom value rather than getting silently truncated.
    expect(parseSectionLabel('AB')).toEqual({ kind: 'custom', value: 'AB' });
  });
});

describe('section management', () => {
  test('Add section appends with prompted label and one default bar', () => {
    const wasm = makeStubWasm();
    const onChange = vi.fn();
    const promptSectionLabel = vi.fn(
      (): SectionLabel => ({ kind: 'letter', value: 'C' }),
    );
    const editor = createIrealbEditor({
      initialValue: SAMPLE_URL,
      wasm,
      promptSectionLabel,
    });
    editor.onChange(onChange);

    expect(readSong(editor).sections.length).toBe(2);
    clickByText(editor, '+ Add section');

    expect(promptSectionLabel).toHaveBeenCalledTimes(1);
    expect(promptSectionLabel).toHaveBeenCalledWith(null);
    const song = readSong(editor);
    expect(song.sections.length).toBe(3);
    expect(song.sections[2]?.label).toEqual({ kind: 'letter', value: 'C' });
    expect(song.sections[2]?.bars.length).toBe(1);
    expect(onChange).toHaveBeenCalledTimes(1);

    editor.destroy();
  });

  test('Add section with cancelled prompt is a no-op', () => {
    const wasm = makeStubWasm();
    const onChange = vi.fn();
    const promptSectionLabel = vi.fn((): SectionLabel | null => null);
    const editor = createIrealbEditor({
      initialValue: SAMPLE_URL,
      wasm,
      promptSectionLabel,
    });
    editor.onChange(onChange);

    clickByText(editor, '+ Add section');
    expect(readSong(editor).sections.length).toBe(2);
    expect(onChange).not.toHaveBeenCalled();

    editor.destroy();
  });

  test('Rename section replaces label and seeds prompt with current value', () => {
    const wasm = makeStubWasm();
    const onChange = vi.fn();
    const promptSectionLabel = vi.fn(
      (): SectionLabel => ({ kind: 'verse' }),
    );
    const editor = createIrealbEditor({
      initialValue: SAMPLE_URL,
      wasm,
      promptSectionLabel,
    });
    editor.onChange(onChange);

    clickAction(editor, 'Rename section', 0);
    expect(promptSectionLabel).toHaveBeenCalledWith({ kind: 'letter', value: 'A' });
    expect(readSong(editor).sections[0]?.label).toEqual({ kind: 'verse' });
    expect(onChange).toHaveBeenCalledTimes(1);

    editor.destroy();
  });

  test('Delete section requires confirmation and removes the section', () => {
    const wasm = makeStubWasm();
    const onChange = vi.fn();
    const confirmDeleteSection = vi.fn(() => true);
    const editor = createIrealbEditor({
      initialValue: SAMPLE_URL,
      wasm,
      confirmDeleteSection,
    });
    editor.onChange(onChange);

    clickAction(editor, 'Delete section', 1);
    expect(confirmDeleteSection).toHaveBeenCalledWith({ kind: 'letter', value: 'B' });
    const song = readSong(editor);
    expect(song.sections.length).toBe(1);
    expect(song.sections[0]?.label).toEqual({ kind: 'letter', value: 'A' });
    expect(onChange).toHaveBeenCalledTimes(1);

    editor.destroy();
  });

  test('Delete section with declined confirmation is a no-op', () => {
    const wasm = makeStubWasm();
    const onChange = vi.fn();
    const confirmDeleteSection = vi.fn(() => false);
    const editor = createIrealbEditor({
      initialValue: SAMPLE_URL,
      wasm,
      confirmDeleteSection,
    });
    editor.onChange(onChange);

    clickAction(editor, 'Delete section', 0);
    expect(readSong(editor).sections.length).toBe(2);
    expect(onChange).not.toHaveBeenCalled();

    editor.destroy();
  });

  test('Move section up swaps with previous; first section button is disabled', () => {
    const wasm = makeStubWasm();
    const onChange = vi.fn();
    const editor = createIrealbEditor({ initialValue: SAMPLE_URL, wasm });
    editor.onChange(onChange);

    // First section's "up" button is disabled.
    const upButtons = editor.element.querySelectorAll<HTMLButtonElement>(
      'button[aria-label="Move section up"]',
    );
    expect(upButtons[0]?.disabled).toBe(true);
    expect(upButtons[1]?.disabled).toBe(false);

    // Click the second section's "up" button -> swap.
    clickAction(editor, 'Move section up', 1);
    const song = readSong(editor);
    expect(song.sections[0]?.label).toEqual({ kind: 'letter', value: 'B' });
    expect(song.sections[1]?.label).toEqual({ kind: 'letter', value: 'A' });
    expect(onChange).toHaveBeenCalledTimes(1);

    editor.destroy();
  });

  test('Move section down swaps with next; last section button is disabled', () => {
    const wasm = makeStubWasm();
    const onChange = vi.fn();
    const editor = createIrealbEditor({ initialValue: SAMPLE_URL, wasm });
    editor.onChange(onChange);

    const downButtons = editor.element.querySelectorAll<HTMLButtonElement>(
      'button[aria-label="Move section down"]',
    );
    expect(downButtons[0]?.disabled).toBe(false);
    expect(downButtons[1]?.disabled).toBe(true);

    clickAction(editor, 'Move section down', 0);
    const song = readSong(editor);
    expect(song.sections[0]?.label).toEqual({ kind: 'letter', value: 'B' });
    expect(song.sections[1]?.label).toEqual({ kind: 'letter', value: 'A' });
    expect(onChange).toHaveBeenCalledTimes(1);

    editor.destroy();
  });
});

describe('bar structural management', () => {
  test('Add bar appends to the targeted section only', () => {
    const wasm = makeStubWasm();
    const onChange = vi.fn();
    const editor = createIrealbEditor({ initialValue: SAMPLE_URL, wasm });
    editor.onChange(onChange);

    expect(readSong(editor).sections[0]?.bars.length).toBe(2);
    expect(readSong(editor).sections[1]?.bars.length).toBe(1);

    // Click the first section's "+ Add bar" button. There are
    // multiple add-bar buttons (one per section); index 0 is the
    // first section's.
    const addBarBtns = Array.from(
      editor.element.querySelectorAll<HTMLButtonElement>(
        '.irealb-editor__add-bar',
      ),
    );
    expect(addBarBtns.length).toBe(2);
    addBarBtns[0]?.click();

    const song = readSong(editor);
    expect(song.sections[0]?.bars.length).toBe(3);
    expect(song.sections[1]?.bars.length).toBe(1); // untouched
    expect(onChange).toHaveBeenCalledTimes(1);

    editor.destroy();
  });

  test('Delete bar removes the targeted bar', () => {
    const wasm = makeStubWasm();
    const onChange = vi.fn();
    const editor = createIrealbEditor({ initialValue: SAMPLE_URL, wasm });
    editor.onChange(onChange);

    // Section A has 2 bars, section B has 1, so 3 delete-bar buttons total.
    clickAction(editor, 'Delete bar', 0);
    const song = readSong(editor);
    expect(song.sections[0]?.bars.length).toBe(1);
    expect(song.sections[1]?.bars.length).toBe(1);
    expect(onChange).toHaveBeenCalledTimes(1);

    editor.destroy();
  });

  test('Move bar left swaps with previous; first bar button is disabled', () => {
    const wasm = makeStubWasm();
    const onChange = vi.fn();
    // Seed section 0 with two bars whose chord text differs so we
    // can detect the swap by reading the bar text after the move.
    const seed: IrealSong = JSON.parse(JSON.stringify(SAMPLE_SONG));
    const sectionA = seed.sections[0];
    if (!sectionA) throw new Error('seed missing section A');
    const bar0 = sectionA.bars[0];
    if (!bar0) throw new Error('seed missing bar 0');
    bar0.chords.push({
      chord: {
        root: { note: 'C', accidental: 'natural' },
        quality: { kind: 'major' },
        bass: null,
      },
      position: { beat: 1, subdivision: 0 },
    });
    const bar1 = sectionA.bars[1];
    if (!bar1) throw new Error('seed missing bar 1');
    bar1.chords.push({
      chord: {
        root: { note: 'F', accidental: 'natural' },
        quality: { kind: 'major' },
        bass: null,
      },
      position: { beat: 1, subdivision: 0 },
    });
    const seedUrl = `irealb://json:${encodeURIComponent(JSON.stringify(seed))}`;
    const editor = createIrealbEditor({ initialValue: seedUrl, wasm });
    editor.onChange(onChange);

    // First bar's "left" button is disabled.
    const leftButtons = editor.element.querySelectorAll<HTMLButtonElement>(
      'button[aria-label="Move bar left"]',
    );
    expect(leftButtons[0]?.disabled).toBe(true);
    expect(leftButtons[1]?.disabled).toBe(false);

    clickAction(editor, 'Move bar left', 1);
    const song = readSong(editor);
    expect(song.sections[0]?.bars[0]?.chords[0]?.chord.root.note).toBe('F');
    expect(song.sections[0]?.bars[1]?.chords[0]?.chord.root.note).toBe('C');
    expect(onChange).toHaveBeenCalledTimes(1);

    editor.destroy();
  });

  test('Move bar right swaps with next; last bar button is disabled', () => {
    const wasm = makeStubWasm();
    const onChange = vi.fn();
    const seed: IrealSong = JSON.parse(JSON.stringify(SAMPLE_SONG));
    const sectionA = seed.sections[0];
    if (!sectionA) throw new Error('seed missing section A');
    const bar0 = sectionA.bars[0];
    if (!bar0) throw new Error('seed missing bar 0');
    bar0.chords.push({
      chord: {
        root: { note: 'C', accidental: 'natural' },
        quality: { kind: 'major' },
        bass: null,
      },
      position: { beat: 1, subdivision: 0 },
    });
    const bar1 = sectionA.bars[1];
    if (!bar1) throw new Error('seed missing bar 1');
    bar1.chords.push({
      chord: {
        root: { note: 'F', accidental: 'natural' },
        quality: { kind: 'major' },
        bass: null,
      },
      position: { beat: 1, subdivision: 0 },
    });
    const seedUrl = `irealb://json:${encodeURIComponent(JSON.stringify(seed))}`;
    const editor = createIrealbEditor({ initialValue: seedUrl, wasm });
    editor.onChange(onChange);

    const rightButtons = editor.element.querySelectorAll<HTMLButtonElement>(
      'button[aria-label="Move bar right"]',
    );
    // Section A: 2 bars (last has right-disabled). Section B: 1 bar
    // (its right is also disabled — single-bar section).
    expect(rightButtons[0]?.disabled).toBe(false); // A's first bar
    expect(rightButtons[1]?.disabled).toBe(true); // A's second bar (last)
    expect(rightButtons[2]?.disabled).toBe(true); // B's only bar

    clickAction(editor, 'Move bar right', 0);
    const song = readSong(editor);
    expect(song.sections[0]?.bars[0]?.chords[0]?.chord.root.note).toBe('F');
    expect(song.sections[0]?.bars[1]?.chords[0]?.chord.root.note).toBe('C');
    expect(onChange).toHaveBeenCalledTimes(1);

    editor.destroy();
  });

  test('Add section starts with one default bar (clickable + editable)', () => {
    const wasm = makeStubWasm();
    const promptSectionLabel = vi.fn((): SectionLabel => ({ kind: 'verse' }));
    const editor = createIrealbEditor({
      initialValue: SAMPLE_URL,
      wasm,
      promptSectionLabel,
    });

    clickByText(editor, '+ Add section');
    const song = readSong(editor);
    expect(song.sections.length).toBe(3);
    const newSection = song.sections[2];
    expect(newSection?.label).toEqual({ kind: 'verse' });
    expect(newSection?.bars.length).toBe(1);
    expect(newSection?.bars[0]?.start).toBe('single');
    expect(newSection?.bars[0]?.end).toBe('single');
    expect(newSection?.bars[0]?.chords).toEqual([]);

    editor.destroy();
  });

  test('Structural ops dismiss any open bar popover', () => {
    const wasm = makeStubWasm();
    const editor = createIrealbEditor({ initialValue: SAMPLE_URL, wasm });

    // Open the popover by clicking bar 0.
    const cells = editor.element.querySelectorAll<HTMLButtonElement>(
      '.irealb-editor__bar',
    );
    cells[0]?.click();
    expect(editor.element.querySelector('.irealb-editor__popover')).not.toBeNull();

    // A structural op (delete bar) must dismiss it — the bar that
    // the popover targets may have been deleted, and re-rendering
    // detaches the popover anchor regardless.
    clickAction(editor, 'Delete bar', 1); // delete a different bar
    expect(editor.element.querySelector('.irealb-editor__popover')).toBeNull();

    editor.destroy();
  });
});
