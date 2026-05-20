// Integration tests for the bar-edit popover wired into
// `<IrealBarGrid>`. Sister-site (DOM):
// `packages/ui-irealb-editor/tests/popover.test.ts`.
//
// Each test renders the editor against a stub wasm bridge, opens
// the popover by clicking a bar cell, and asserts on the resulting
// dialog / chord-row / Save flow.

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

import { IrealBarGrid, type IrealBarGridLoader } from '../src/ireal-bar-grid';
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
  const loader: IrealBarGridLoader = vi.fn(
    async () => stub as unknown as Awaited<ReturnType<IrealBarGridLoader>>,
  );
  const result = render(
    <IrealBarGrid source="irealb://x" loader={loader} onChange={onChange} />,
  );
  await waitFor(() => expect(stub.parseIrealb).toHaveBeenCalled());
  return { ...result, stub, onChange };
}

function openFirstBarPopover(): void {
  const cell = screen.getAllByRole('button', { name: /^Edit bar 1/ })[0]!;
  fireEvent.click(cell);
}

describe('<IrealBarGrid> popover — open / dismiss', () => {
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

  test('opening a second popover closes the first AND swaps the bound bar', async () => {
    // Differentiated seed: bar 1 carries `start: 'single'`, bar 2
    // carries `start: 'open_repeat'`. Without `key={secIndex:barIndex}`
    // on `<IrealBarPopover>` React would reuse the same instance
    // across the swap, leaving the dialog showing bar 1's content
    // while supposedly editing bar 2 — the assertion below catches
    // that regression.
    const seed = songWithOneChordBar();
    seed.sections[0]!.bars[1]!.start = 'open_repeat';
    await renderEditor(seed);
    openFirstBarPopover();
    const firstDialog = await screen.findByRole('dialog');
    expect(
      (within(firstDialog).getByLabelText('Start barline') as HTMLSelectElement).value,
    ).toBe('single');
    // Click the second bar cell.
    const secondCell = screen.getByRole('button', { name: /^Edit bar 2/ });
    fireEvent.click(secondCell);
    const dialogs = screen.getAllByRole('dialog');
    expect(dialogs.length).toBe(1);
    expect(
      (within(dialogs[0]!).getByLabelText('Start barline') as HTMLSelectElement).value,
    ).toBe('open_repeat');
  });
});

describe('<IrealBarGrid> popover — barline edits', () => {
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

describe('<IrealBarGrid> popover — ending input', () => {
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

describe('<IrealBarGrid> popover — symbol picker', () => {
  // Parametrised across the full 18-option list. A typo or accidental
  // drop in `SYMBOL_OPTIONS` (e.g. a missing
  // `da_capo_al_3rd_end` entry) would surface here as a select-value
  // failure rather than slipping through to release.
  test.each([
    'segno',
    'coda',
    'fine',
    'fermata',
    'break',
    'da_capo',
    'da_capo_al_coda',
    'da_capo_al_fine',
    'da_capo_al_1st_end',
    'da_capo_al_2nd_end',
    'da_capo_al_3rd_end',
    'dal_segno',
    'dal_segno_al_coda',
    'dal_segno_al_fine',
    'dal_segno_al_1st_end',
    'dal_segno_al_2nd_end',
    'dal_segno_al_3rd_end',
  ] as const)('%s round-trips through Save', async (target) => {
    const { stub, unmount } = await renderEditor();
    openFirstBarPopover();
    await screen.findByRole('dialog');
    const symbolSelect = screen.getByLabelText('Symbol');
    fireEvent.change(symbolSelect, { target: { value: target } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(stub.serializeIrealb).toHaveBeenCalled());
    expect(stub.lastSong().sections[0]!.bars[0]!.symbol).toBe(target);
    unmount();
  });

  test('None (empty value) clears the symbol back to null', async () => {
    const seed = songWithOneChordBar();
    seed.sections[0]!.bars[0]!.symbol = 'segno';
    const { stub } = await renderEditor(seed);
    openFirstBarPopover();
    await screen.findByRole('dialog');
    const symbolSelect = screen.getByLabelText('Symbol') as HTMLSelectElement;
    expect(symbolSelect.value).toBe('segno');
    fireEvent.change(symbolSelect, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(stub.serializeIrealb).toHaveBeenCalled());
    expect(stub.lastSong().sections[0]!.bars[0]!.symbol).toBeNull();
  });
});

describe('<IrealBarGrid> popover — focus restoration', () => {
  test('after Cancel, focus returns to the bar cell that opened the popover', async () => {
    await renderEditor();
    const cell = screen.getAllByRole('button', { name: /^Edit bar 1/ })[0]!;
    cell.focus();
    fireEvent.click(cell);
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement?.getAttribute?.('aria-label')).toMatch(/^Edit bar 1/);
  });

  test('after Save, focus returns to the (rebuilt) bar cell at the same index', async () => {
    const { stub } = await renderEditor();
    const cell = screen.getAllByRole('button', { name: /^Edit bar 1/ })[0]!;
    cell.focus();
    fireEvent.click(cell);
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(stub.serializeIrealb).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement?.getAttribute?.('aria-label')).toMatch(/^Edit bar 1/);
  });
});

describe('<IrealBarGrid> popover — chord rows', () => {
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
    expect(bassInput.classList.contains('chordsketch-ireal-bar-grid__input--invalid')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(stub.serializeIrealb).toHaveBeenCalled());
    // AST bass unchanged from the seed value.
    expect(stub.lastSong().sections[0]!.bars[0]!.chords[0]!.chord.bass).toEqual({
      note: 'G',
      accidental: 'natural',
    });
  });

  test('reorder syncs each row\'s bass input from its new chord prop', async () => {
    // Regression for the positional-key state-desync UX bug: a
    // `<ChordRowEditor>` reused across reorder must show the new
    // chord's bass, not the previous slot's bass. Row 0 carries
    // bass G; row 1 carries no bass. After Move-down on row 0,
    // the inputs swap positions; without the prop-sync useEffect,
    // row 0's display would still show "G" because its local
    // `bassRaw` is stale.
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
      {
        chord: {
          root: { note: 'D', accidental: 'natural' },
          quality: { kind: 'minor7' },
          bass: null,
        },
        position: { beat: 3, subdivision: 0 },
      },
    ];
    await renderEditor(seed);
    openFirstBarPopover();
    const dialog = await screen.findByRole('dialog');
    const bassInputs = within(dialog).getAllByLabelText('Bass') as HTMLInputElement[];
    expect(bassInputs[0]!.value).toBe('G');
    expect(bassInputs[1]!.value).toBe('');
    // Swap rows: move row 0 down.
    fireEvent.click(within(dialog).getAllByRole('button', { name: 'Move chord down' })[0]!);
    const reordered = within(dialog).getAllByLabelText('Bass') as HTMLInputElement[];
    // After reorder, the bass-G chord is at row 1 and the
    // no-bass chord is at row 0. The inputs must reflect the
    // new bound chords, not retain the previous slot's strings.
    expect(reordered[0]!.value).toBe('');
    expect(reordered[1]!.value).toBe('G');
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

  test('bass text input syncs correctly after chord-row reorder', async () => {
    // Regression: ChordRowEditor uses key={index} with local bassRaw state.
    // Before the fix, reordering left the bass inputs showing the previous
    // row's value rather than the newly-swapped chord's bass.
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
      {
        chord: {
          root: { note: 'F', accidental: 'natural' },
          quality: { kind: 'major' },
          bass: null,
        },
        position: { beat: 3, subdivision: 0 },
      },
    ];
    await renderEditor(seed);
    openFirstBarPopover();
    const dialog = await screen.findByRole('dialog');
    // Move the first chord (C/G, bass=G) down → it becomes row 1.
    const downButtons = within(dialog).getAllByRole('button', { name: 'Move chord down' });
    fireEvent.click(downButtons[0]!);
    // After reorder: row 0 = F (no bass), row 1 = C/G (bass G).
    const bassInputs = within(dialog).getAllByLabelText('Bass');
    expect((bassInputs[0] as HTMLInputElement).value).toBe('');
    expect((bassInputs[1] as HTMLInputElement).value).toBe('G');
  });

  test('bass text input resets after null→null reorder (stale invalid state)', async () => {
    // Regression guard for the null→null edge case: if the user has typed
    // an invalid bass in a chord that has no bass, then reorders with
    // another chord that also has no bass, the dep [barChord.chord.bass]
    // would see null===null and skip the reset — leaving bassRaw='ZZZ' and
    // aria-invalid set against the wrong chord. The dep is now [barChord]
    // so any swap, even null→null, resets the display.
    const seed = songWithOneChordBar();
    seed.sections[0]!.bars[0]!.chords = [
      {
        chord: {
          root: { note: 'C', accidental: 'natural' },
          quality: { kind: 'major' },
          bass: null,
        },
        position: { beat: 1, subdivision: 0 },
      },
      {
        chord: {
          root: { note: 'F', accidental: 'natural' },
          quality: { kind: 'major' },
          bass: null,
        },
        position: { beat: 3, subdivision: 0 },
      },
    ];
    await renderEditor(seed);
    openFirstBarPopover();
    const dialog = await screen.findByRole('dialog');
    // Type an invalid bass into row 0 (no onChange fires — AST unchanged).
    const [bassInput0] = within(dialog).getAllByLabelText('Bass') as HTMLInputElement[];
    fireEvent.change(bassInput0!, { target: { value: 'ZZZ' } });
    expect(bassInput0!.getAttribute('aria-invalid')).toBe('true');
    // Reorder: chord 0 (C, no bass) moves down; chord 1 (F, no bass) takes row 0.
    const downButtons = within(dialog).getAllByRole('button', { name: 'Move chord down' });
    fireEvent.click(downButtons[0]!);
    // Row 0 now holds the F chord — bass display must reset, not carry 'ZZZ'.
    const [updatedBass0] = within(dialog).getAllByLabelText('Bass') as HTMLInputElement[];
    expect(updatedBass0!.value).toBe('');
    expect(updatedBass0!.getAttribute('aria-invalid')).not.toBe('true');
  });
});

describe('<IrealBarGrid> popover — preserves unedited fields', () => {
  test('Save preserves staff_texts and system_break_space on the seed bar', async () => {
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
