// Integration tests for the bar-edit popover wired into
// `<IrealEditor>`. Sister-site (DOM):
// `packages/ui-irealb-editor/tests/popover.test.ts`.
//
// Each test renders the editor against a stub wasm bridge, opens
// the popover by clicking a bar cell, and asserts on the resulting
// dialog / chord-row / Save flow.

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

import { IrealEditor, type IrealEditorLoader } from '../src/ireal-editor';
import type { IrealBar, IrealSong } from '../src/ireal-ast';

interface EditorStub {
  default: ReturnType<typeof vi.fn>;
  parseIrealb: ReturnType<typeof vi.fn>;
  serializeIrealb: ReturnType<typeof vi.fn>;
  lastSong: () => IrealSong;
}

function chord(note: string, kind: 'major' | 'minor7' | 'custom' = 'major', customValue = ''): IrealBar['chords'][number] {
  return {
    chord: {
      root: { note, accidental: 'natural' },
      quality: kind === 'custom' ? { kind: 'custom', value: customValue } : { kind },
      bass: null,
    },
    position: { beat: 1, subdivision: 0 },
  };
}

function songWithOneChordBar(): IrealSong {
  return {
    title: 'Fixture',
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
            chords: [chord('C')],
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
    ],
  };
}

function makeStub(initial: IrealSong): EditorStub {
  let song = initial;
  return {
    default: vi.fn(async () => undefined),
    parseIrealb: vi.fn(() => JSON.stringify(song)),
    serializeIrealb: vi.fn((json: string) => {
      song = JSON.parse(json) as IrealSong;
      return 'irealb://serialised';
    }),
    lastSong: () => song,
  };
}

async function renderEditor(initial: IrealSong = songWithOneChordBar()) {
  const stub = makeStub(initial);
  const onChange = vi.fn();
  const loader: IrealEditorLoader = vi.fn(
    async () => stub as unknown as Awaited<ReturnType<IrealEditorLoader>>,
  );
  const result = render(
    <IrealEditor source="irealb://x" loader={loader} onChange={onChange} />,
  );
  await waitFor(() => expect(stub.parseIrealb).toHaveBeenCalled());
  return { ...result, stub, onChange };
}

function openFirstBarPopover(): void {
  const cell = screen.getAllByRole('button', { name: /^Edit bar 1/ })[0]!;
  fireEvent.click(cell);
}

describe('<IrealEditor> popover — open / dismiss', () => {
  test('clicking a bar cell mounts a role="dialog" aria-modal="true"', async () => {
    await renderEditor();
    openFirstBarPopover();
    const dialog = await screen.findByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-label')).toBe('Edit bar');
  });

  test('Cancel dismisses without committing', async () => {
    const { stub, onChange } = await renderEditor();
    openFirstBarPopover();
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(stub.serializeIrealb).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });

  test('Escape dismisses without committing', async () => {
    const { stub, onChange } = await renderEditor();
    openFirstBarPopover();
    const dialog = await screen.findByRole('dialog');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(stub.serializeIrealb).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });

  test('outside-click dismisses without committing', async () => {
    const { container, stub } = await renderEditor();
    openFirstBarPopover();
    await screen.findByRole('dialog');
    fireEvent.pointerDown(container);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(stub.serializeIrealb).not.toHaveBeenCalled();
  });

  test('opening a second popover closes the first (single dialog invariant)', async () => {
    await renderEditor();
    openFirstBarPopover();
    await screen.findByRole('dialog');
    // Click the second bar cell.
    const secondCell = screen.getByRole('button', { name: /^Edit bar 2/ });
    fireEvent.click(secondCell);
    // Exactly one dialog at any time.
    expect(screen.getAllByRole('dialog').length).toBe(1);
  });
});

describe('<IrealEditor> popover — barline edits', () => {
  test('Save commits start/end barline edits to the AST', async () => {
    const { stub } = await renderEditor();
    openFirstBarPopover();
    await screen.findByRole('dialog');
    const startSelect = screen.getByLabelText('Start barline');
    fireEvent.change(startSelect, { target: { value: 'open_repeat' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(stub.serializeIrealb).toHaveBeenCalled());
    expect(stub.lastSong().sections[0]!.bars[0]!.start).toBe('open_repeat');
  });
});

describe('<IrealEditor> popover — ending input', () => {
  test('empty input → null', async () => {
    const seed = songWithOneChordBar();
    seed.sections[0]!.bars[0]!.ending = 2;
    const { stub } = await renderEditor(seed);
    openFirstBarPopover();
    await screen.findByRole('dialog');
    const endingInput = screen.getByLabelText('N-th ending');
    fireEvent.change(endingInput, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(stub.serializeIrealb).toHaveBeenCalled());
    expect(stub.lastSong().sections[0]!.bars[0]!.ending).toBeNull();
  });

  test('0 → the N0 untitled sentinel', async () => {
    const { stub } = await renderEditor();
    openFirstBarPopover();
    await screen.findByRole('dialog');
    const endingInput = screen.getByLabelText('N-th ending');
    fireEvent.change(endingInput, { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(stub.serializeIrealb).toHaveBeenCalled());
    expect(stub.lastSong().sections[0]!.bars[0]!.ending).toBe(0);
  });

  test('2 → the numbered bracket value', async () => {
    const { stub } = await renderEditor();
    openFirstBarPopover();
    await screen.findByRole('dialog');
    const endingInput = screen.getByLabelText('N-th ending');
    fireEvent.change(endingInput, { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(stub.serializeIrealb).toHaveBeenCalled());
    expect(stub.lastSong().sections[0]!.bars[0]!.ending).toBe(2);
  });
});

describe('<IrealEditor> popover — symbol picker', () => {
  test('None / segno / fine / da_capo_al_coda round-trip', async () => {
    for (const target of ['segno', 'fine', 'da_capo_al_coda'] as const) {
      const { stub, unmount } = await renderEditor();
      openFirstBarPopover();
      await screen.findByRole('dialog');
      const symbolSelect = screen.getByLabelText('Symbol');
      fireEvent.change(symbolSelect, { target: { value: target } });
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(stub.serializeIrealb).toHaveBeenCalled());
      expect(stub.lastSong().sections[0]!.bars[0]!.symbol).toBe(target);
      unmount();
    }
  });
});

describe('<IrealEditor> popover — chord rows', () => {
  test('Add chord appends a new default chord row', async () => {
    const { stub } = await renderEditor();
    openFirstBarPopover();
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: '+ Add chord' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(stub.serializeIrealb).toHaveBeenCalled());
    expect(stub.lastSong().sections[0]!.bars[0]!.chords.length).toBe(2);
  });

  test('Remove chord drops the targeted row', async () => {
    const seed = songWithOneChordBar();
    seed.sections[0]!.bars[0]!.chords = [chord('C'), chord('G')];
    const { stub } = await renderEditor(seed);
    openFirstBarPopover();
    const dialog = await screen.findByRole('dialog');
    const removeButtons = within(dialog).getAllByRole('button', { name: 'Remove chord' });
    fireEvent.click(removeButtons[0]!);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(stub.serializeIrealb).toHaveBeenCalled());
    expect(stub.lastSong().sections[0]!.bars[0]!.chords.length).toBe(1);
    expect(
      (stub.lastSong().sections[0]!.bars[0]!.chords[0]!.chord.root.note),
    ).toBe('G');
  });

  test('Reorder via "Move chord down" swaps adjacent rows', async () => {
    const seed = songWithOneChordBar();
    seed.sections[0]!.bars[0]!.chords = [chord('C'), chord('G')];
    const { stub } = await renderEditor(seed);
    openFirstBarPopover();
    const dialog = await screen.findByRole('dialog');
    const downButtons = within(dialog).getAllByRole('button', { name: 'Move chord down' });
    fireEvent.click(downButtons[0]!);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(stub.serializeIrealb).toHaveBeenCalled());
    expect(
      (stub.lastSong().sections[0]!.bars[0]!.chords[0]!.chord.root.note),
    ).toBe('G');
  });

  test('Custom quality input becomes visible and round-trips', async () => {
    const { stub } = await renderEditor();
    openFirstBarPopover();
    const dialog = await screen.findByRole('dialog');
    const qualitySelect = within(dialog).getByLabelText('Quality');
    fireEvent.change(qualitySelect, { target: { value: 'custom' } });
    // After selecting Custom, the Custom field appears in the row.
    const customInput = within(dialog).getByLabelText('Custom');
    fireEvent.change(customInput, { target: { value: '7♯9' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(stub.serializeIrealb).toHaveBeenCalled());
    const quality = stub.lastSong().sections[0]!.bars[0]!.chords[0]!.chord.quality;
    expect(quality).toEqual({ kind: 'custom', value: '7♯9' });
  });

  test('bass input parses A–G + ♭ / ♯ into a ChordRoot', async () => {
    const { stub } = await renderEditor();
    openFirstBarPopover();
    const dialog = await screen.findByRole('dialog');
    const bassInput = within(dialog).getByLabelText('Bass');
    fireEvent.change(bassInput, { target: { value: 'G♭' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(stub.serializeIrealb).toHaveBeenCalled());
    expect(stub.lastSong().sections[0]!.bars[0]!.chords[0]!.chord.bass).toEqual({
      note: 'G',
      accidental: 'flat',
    });
  });

  test('invalid bass input keeps the previous bass AND flags the field', async () => {
    const seed = songWithOneChordBar();
    seed.sections[0]!.bars[0]!.chords = [
      {
        chord: {
          root: { note: 'C', accidental: 'natural' },
          quality: { kind: 'major' },
          bass: { note: 'G', accidental: 'natural' },
        },
        position: { beat: 1, subdivision: 0 },
      },
    ];
    const { stub } = await renderEditor(seed);
    openFirstBarPopover();
    const dialog = await screen.findByRole('dialog');
    const bassInput = within(dialog).getByLabelText('Bass');
    fireEvent.change(bassInput, { target: { value: 'ZZZ' } });
    expect(bassInput.classList.contains('chordsketch-ireal-editor__input--invalid')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(stub.serializeIrealb).toHaveBeenCalled());
    // AST bass unchanged from the seed value.
    expect(stub.lastSong().sections[0]!.bars[0]!.chords[0]!.chord.bass).toEqual({
      note: 'G',
      accidental: 'natural',
    });
  });

  test('beat position 2.5 maps to { beat: 2, subdivision: 1 }', async () => {
    const { stub } = await renderEditor();
    openFirstBarPopover();
    const dialog = await screen.findByRole('dialog');
    const posSelect = within(dialog).getByLabelText('Pos.');
    fireEvent.change(posSelect, { target: { value: '2.5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(stub.serializeIrealb).toHaveBeenCalled());
    expect(stub.lastSong().sections[0]!.bars[0]!.chords[0]!.position).toEqual({
      beat: 2,
      subdivision: 1,
    });
  });
});

describe('<IrealEditor> popover — preserves unedited fields', () => {
  test('Save preserves staff_texts / system_break_space / beat_grouping_override', async () => {
    const seed = songWithOneChordBar();
    // Cast through unknown because the AST type is conservative —
    // optional fields are not in the IrealBar interface here but
    // are preserved by the wasm round-trip and by our spread.
    (seed.sections[0]!.bars[0] as unknown as Record<string, unknown>).staff_texts = [
      { kind: 'text', value: 'hint' },
    ];
    (seed.sections[0]!.bars[0] as unknown as Record<string, unknown>).system_break_space = 2;
    const { stub } = await renderEditor(seed);
    openFirstBarPopover();
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(stub.serializeIrealb).toHaveBeenCalled());
    const savedBar = stub.lastSong().sections[0]!.bars[0]! as unknown as Record<string, unknown>;
    expect(savedBar.staff_texts).toEqual([{ kind: 'text', value: 'hint' }]);
    expect(savedBar.system_break_space).toBe(2);
  });
});
