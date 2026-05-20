// Integration tests for the bar grid layout inside `<IrealBarGrid>`.
// Covers ARIA grid semantics + roving tabindex + active-bar
// reconciliation. Sister-site (DOM):
// `packages/ui-irealb-editor/tests/aria-grid.test.ts`.

import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

import { IrealBarGrid, type IrealBarGridLoader } from '../src/ireal-bar-grid';
import type { IrealSong } from '../src/ireal-ast';

interface EditorStub {
  default: ReturnType<typeof vi.fn>;
  parseIrealb: ReturnType<typeof vi.fn>;
  serializeIrealb: ReturnType<typeof vi.fn>;
}

function songWithBars(barsCount: number, secLabel = 'A'): IrealSong {
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
        label: { kind: 'letter', value: secLabel },
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
  };
}

function makeLoader(stub: EditorStub): IrealBarGridLoader {
  return vi.fn(async () => stub as unknown as Awaited<ReturnType<IrealBarGridLoader>>);
}

async function renderEditor(song: IrealSong) {
  const stub = makeStub(song);
  const onChange = vi.fn();
  const result = render(
    <IrealBarGrid source="irealb://x" loader={makeLoader(stub)} onChange={onChange} />,
  );
  await waitFor(() => expect(stub.parseIrealb).toHaveBeenCalled());
  return { ...result, stub, onChange };
}

describe('<IrealBarGrid> bar grid — ARIA semantics', () => {
  test('grid carries role="grid" + aria-rowcount + aria-colcount + aria-label', async () => {
    await renderEditor(songWithBars(7));
    const grid = screen.getByRole('grid');
    // 7 bars → ceil(7/4) = 2 rows.
    expect(grid.getAttribute('aria-rowcount')).toBe('2');
    expect(grid.getAttribute('aria-colcount')).toBe('4');
    expect(grid.getAttribute('aria-label')).toContain('section A');
  });

  test('rows have role="row" with 1-based aria-rowindex', async () => {
    await renderEditor(songWithBars(7));
    const rows = screen.getAllByRole('row');
    expect(rows.length).toBe(2);
    expect(rows[0]!.getAttribute('aria-rowindex')).toBe('1');
    expect(rows[1]!.getAttribute('aria-rowindex')).toBe('2');
  });

  test('wrappers have role="gridcell" with 1-based aria-colindex cycling 1..4', async () => {
    await renderEditor(songWithBars(7));
    const cells = screen.getAllByRole('gridcell');
    expect(cells.length).toBe(7);
    expect(cells[0]!.getAttribute('aria-colindex')).toBe('1');
    expect(cells[3]!.getAttribute('aria-colindex')).toBe('4');
    // Row 2 cell 5 (barIndex 4) wraps back to aria-colindex 1.
    expect(cells[4]!.getAttribute('aria-colindex')).toBe('1');
  });

  test('empty section reports aria-rowcount=0', async () => {
    const song = songWithBars(0);
    await renderEditor(song);
    const grid = screen.getByRole('grid');
    expect(grid.getAttribute('aria-rowcount')).toBe('0');
  });
});

describe('<IrealBarGrid> bar grid — roving tabindex', () => {
  test('exactly one bar cell has tabindex=0 on initial render', async () => {
    await renderEditor(songWithBars(4));
    const cells = screen
      .getAllByRole('button', { name: /^Edit bar / })
      .filter((b) => b.classList.contains('chordsketch-ireal-bar-grid__bar'));
    const tabZero = cells.filter((c) => c.getAttribute('tabindex') === '0');
    expect(tabZero.length).toBe(1);
    // Per the reconciler default, the first bar of the first
    // non-empty section receives the slot.
    expect(tabZero[0]!.getAttribute('aria-label')).toBe('Edit bar 1');
  });

  test('focusing a different cell moves the tabindex=0 slot', async () => {
    await renderEditor(songWithBars(4));
    const cells = screen
      .getAllByRole('button', { name: /^Edit bar / })
      .filter((b) => b.classList.contains('chordsketch-ireal-bar-grid__bar'));
    // Focus the third cell. After commit the slot should have moved.
    cells[2]!.focus();
    await waitFor(() => {
      expect(cells[2]!.getAttribute('tabindex')).toBe('0');
    });
    const tabZero = cells.filter((c) => c.getAttribute('tabindex') === '0');
    expect(tabZero.length).toBe(1);
  });

  test('section with zero bars contributes no Tab stops', async () => {
    const song = songWithBars(0);
    await renderEditor(song);
    const cells = document.querySelectorAll('.chordsketch-ireal-bar-grid__bar');
    expect(cells.length).toBe(0);
  });
});

describe('<IrealBarGrid> bar grid — focus activation', () => {
  test('focusing a bar cell moves the roving tabindex slot to it', async () => {
    // The cell's `onFocus` fires `onActiveBarChange`; the
    // resulting state update re-renders the grid with the new
    // active-bar ref, which sets `tabIndex={0}` on the newly
    // focused cell. Drives the popover-anchor selection that
    // lands in a follow-up slice.
    await renderEditor(songWithBars(4));
    const cells = screen
      .getAllByRole('button', { name: /^Edit bar / })
      .filter((b) => b.classList.contains('chordsketch-ireal-bar-grid__bar'));
    cells[3]!.focus();
    await waitFor(() => {
      expect(cells[3]!.getAttribute('tabindex')).toBe('0');
    });
  });
});

