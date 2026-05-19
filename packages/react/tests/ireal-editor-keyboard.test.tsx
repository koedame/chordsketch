// Integration tests for the bar-cell keyboard handler. Sister-site
// (DOM): `packages/ui-irealb-editor/tests/keyboard.test.ts`.

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

import { IrealEditor, type IrealEditorLoader } from '../src/ireal-editor';
import type { IrealSong } from '../src/ireal-ast';

interface EditorStub {
  default: ReturnType<typeof vi.fn>;
  parseIrealb: ReturnType<typeof vi.fn>;
  serializeIrealb: ReturnType<typeof vi.fn>;
  lastSong: () => IrealSong;
}

function songWithBars(barsCount: number): IrealSong {
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
        bars: Array.from({ length: barsCount }, () => ({
          start: 'single' as const,
          end: 'single' as const,
          chords: [],
          ending: null,
          symbol: null,
        })),
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

async function renderEditor(barsCount: number) {
  const stub = makeStub(songWithBars(barsCount));
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

function getCells(): HTMLButtonElement[] {
  return Array.from(
    document.querySelectorAll<HTMLButtonElement>('.chordsketch-ireal-editor__bar'),
  );
}

describe('<IrealEditor> keyboard — roving arrow navigation', () => {
  test('ArrowRight moves focus to the next bar within the section', async () => {
    await renderEditor(4);
    const cells = getCells();
    cells[0]!.focus();
    fireEvent.keyDown(cells[0]!, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(cells[1]);
  });

  test('ArrowLeft moves focus to the previous bar', async () => {
    await renderEditor(4);
    const cells = getCells();
    cells[2]!.focus();
    fireEvent.keyDown(cells[2]!, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(cells[1]);
  });

  test('ArrowDown moves by row (cell + BARS_PER_ROW)', async () => {
    // 8 bars → 2 rows of 4. ArrowDown from index 1 lands at index 5.
    await renderEditor(8);
    const cells = getCells();
    cells[1]!.focus();
    fireEvent.keyDown(cells[1]!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(cells[5]);
  });

  test('ArrowUp is the inverse', async () => {
    await renderEditor(8);
    const cells = getCells();
    cells[6]!.focus();
    fireEvent.keyDown(cells[6]!, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(cells[2]);
  });

  test('Home and End jump to first / last bar of the section', async () => {
    await renderEditor(5);
    const cells = getCells();
    cells[2]!.focus();
    fireEvent.keyDown(cells[2]!, { key: 'Home' });
    expect(document.activeElement).toBe(cells[0]);
    fireEvent.keyDown(cells[0]!, { key: 'End' });
    expect(document.activeElement).toBe(cells[4]);
  });

  test('arrow keys with Ctrl / Meta modifier are passed through (no navigation)', async () => {
    await renderEditor(4);
    const cells = getCells();
    cells[0]!.focus();
    fireEvent.keyDown(cells[0]!, { key: 'ArrowRight', ctrlKey: true });
    expect(document.activeElement).toBe(cells[0]);
    fireEvent.keyDown(cells[0]!, { key: 'ArrowRight', metaKey: true });
    expect(document.activeElement).toBe(cells[0]);
  });
});

describe('<IrealEditor> keyboard — Delete / Backspace', () => {
  test('Delete on focused bar cell removes the bar', async () => {
    const { stub } = await renderEditor(3);
    const cells = getCells();
    cells[1]!.focus();
    fireEvent.keyDown(cells[1]!, { key: 'Delete' });
    await waitFor(() => expect(stub.serializeIrealb).toHaveBeenCalled());
    expect(stub.lastSong().sections[0]!.bars.length).toBe(2);
  });

  test('Backspace also triggers bar deletion', async () => {
    const { stub } = await renderEditor(3);
    const cells = getCells();
    cells[1]!.focus();
    fireEvent.keyDown(cells[1]!, { key: 'Backspace' });
    await waitFor(() => expect(stub.serializeIrealb).toHaveBeenCalled());
    expect(stub.lastSong().sections[0]!.bars.length).toBe(2);
  });

  test('Delete with Ctrl modifier is a no-op', async () => {
    const { stub } = await renderEditor(3);
    const cells = getCells();
    cells[1]!.focus();
    fireEvent.keyDown(cells[1]!, { key: 'Delete', ctrlKey: true });
    expect(stub.serializeIrealb).not.toHaveBeenCalled();
  });

  test('Delete with Meta modifier is a no-op', async () => {
    const { stub } = await renderEditor(3);
    const cells = getCells();
    cells[1]!.focus();
    fireEvent.keyDown(cells[1]!, { key: 'Delete', metaKey: true });
    expect(stub.serializeIrealb).not.toHaveBeenCalled();
  });
});

describe('<IrealEditor> keyboard — Alt+Arrow reorder', () => {
  test('Alt+ArrowRight moves the focused bar right', async () => {
    const { stub } = await renderEditor(4);
    const cells = getCells();
    cells[0]!.focus();
    fireEvent.keyDown(cells[0]!, { key: 'ArrowRight', altKey: true });
    await waitFor(() => expect(stub.serializeIrealb).toHaveBeenCalled());
    // Hard to assert "the bars swapped" without distinguishing
    // them; we assert the structural-op call shape via the
    // serializer count + bars length unchanged.
    expect(stub.lastSong().sections[0]!.bars.length).toBe(4);
  });

  test('Alt+ArrowLeft on the first bar is a bounded no-op (preventDefault, no op)', async () => {
    const { stub } = await renderEditor(4);
    const cells = getCells();
    cells[0]!.focus();
    fireEvent.keyDown(cells[0]!, { key: 'ArrowLeft', altKey: true });
    expect(stub.serializeIrealb).not.toHaveBeenCalled();
  });

  test('Alt+ArrowRight on the last bar is a bounded no-op', async () => {
    const { stub } = await renderEditor(4);
    const cells = getCells();
    cells[3]!.focus();
    fireEvent.keyDown(cells[3]!, { key: 'ArrowRight', altKey: true });
    expect(stub.serializeIrealb).not.toHaveBeenCalled();
  });

  test('Alt+Shift+ArrowLeft does not fire (Shift is disqualifying)', async () => {
    const { stub } = await renderEditor(4);
    const cells = getCells();
    cells[1]!.focus();
    fireEvent.keyDown(cells[1]!, {
      key: 'ArrowLeft',
      altKey: true,
      shiftKey: true,
    });
    expect(stub.serializeIrealb).not.toHaveBeenCalled();
  });
});
