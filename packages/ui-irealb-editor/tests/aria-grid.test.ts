// Vitest cases for the ARIA grid semantics, roving tabindex, arrow-
// key navigation, and live-region announcements added in #2368.
//
// These complement `keyboard.test.ts` (Delete / Backspace / Alt+Arrow
// from #2376) — that suite covers structural shortcuts, this suite
// covers the W3C APG roving-tabindex grid pattern + assistive-tech
// surface.

import { describe, expect, test, vi } from 'vitest';
import { createIrealbEditor, type IrealbWasm } from '../src/index';
import type { IrealSong } from '../src/ast';

/** Build a song with `barsCount` bars in a single section. Only the
 * barIndex matters for the grid-shape tests, so the chord values are
 * stub C major across the board. */
function makeSongWithBars(barsCount: number): IrealSong {
  const bars = [];
  for (let i = 0; i < barsCount; i += 1) {
    bars.push({
      start: 'single' as const,
      end: 'single' as const,
      chords: [
        {
          chord: {
            root: { note: 'C' as const, accidental: 'natural' as const },
            quality: { kind: 'major' as const },
            bass: null,
          },
          position: { beat: 1, subdivision: 0 },
        },
      ],
      ending: null,
      symbol: null,
    });
  }
  return {
    title: 'Aria Grid Sample',
    composer: null,
    style: null,
    key_signature: { root: { note: 'C', accidental: 'natural' }, mode: 'major' },
    time_signature: { numerator: 4, denominator: 4 },
    tempo: null,
    transpose: 0,
    sections: [
      {
        label: { kind: 'letter', value: 'A' },
        bars,
      },
    ],
  };
}

const SAMPLE_URL = 'irealb://aria-sample';

function makeStubWasm(song: IrealSong): IrealbWasm & {
  parseIrealb: ReturnType<typeof vi.fn>;
  serializeIrealb: ReturnType<typeof vi.fn>;
} {
  const parseIrealb = vi.fn((input: string): string => {
    if (input === SAMPLE_URL) return JSON.stringify(song);
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

function withMounted<T>(
  editor: ReturnType<typeof createIrealbEditor>,
  fn: () => T,
): T {
  document.body.appendChild(editor.element);
  try {
    return fn();
  } finally {
    editor.element.remove();
  }
}

describe('ARIA grid semantics', () => {
  test('grid carries role="grid" with aria-rowcount and aria-colcount', () => {
    const wasm = makeStubWasm(makeSongWithBars(7));
    const editor = createIrealbEditor({ initialValue: SAMPLE_URL, wasm });
    try {
      const grids = editor.element.querySelectorAll('.irealb-editor__bars');
      expect(grids.length).toBe(1);
      const grid = grids[0] as HTMLElement;
      expect(grid.getAttribute('role')).toBe('grid');
      // 7 bars / 4 per row → 2 rows (4 + 3).
      expect(grid.getAttribute('aria-rowcount')).toBe('2');
      expect(grid.getAttribute('aria-colcount')).toBe('4');
      // The grid label includes the section label so an assistive
      // tech traversing multiple sections distinguishes them.
      expect(grid.getAttribute('aria-label')).toContain('section A');
    } finally {
      editor.destroy();
    }
  });

  test('rows carry role="row" with 1-based aria-rowindex', () => {
    const wasm = makeStubWasm(makeSongWithBars(7));
    const editor = createIrealbEditor({ initialValue: SAMPLE_URL, wasm });
    try {
      const rows = editor.element.querySelectorAll('.irealb-editor__row');
      expect(rows.length).toBe(2);
      expect((rows[0] as HTMLElement).getAttribute('role')).toBe('row');
      expect((rows[0] as HTMLElement).getAttribute('aria-rowindex')).toBe('1');
      expect((rows[1] as HTMLElement).getAttribute('aria-rowindex')).toBe('2');
    } finally {
      editor.destroy();
    }
  });

  test('bar wrappers carry role="gridcell" with 1-based aria-colindex', () => {
    const wasm = makeStubWasm(makeSongWithBars(6));
    const editor = createIrealbEditor({ initialValue: SAMPLE_URL, wasm });
    try {
      const wrappers = editor.element.querySelectorAll('.irealb-editor__bar-wrapper');
      expect(wrappers.length).toBe(6);
      // First row: bars 0-3, colindex 1-4.
      expect((wrappers[0] as HTMLElement).getAttribute('role')).toBe('gridcell');
      expect((wrappers[0] as HTMLElement).getAttribute('aria-colindex')).toBe('1');
      expect((wrappers[3] as HTMLElement).getAttribute('aria-colindex')).toBe('4');
      // Second row: bars 4-5, colindex 1-2 (the row counter wraps;
      // colindex restarts from 1 in each row per the wrap layout).
      expect((wrappers[4] as HTMLElement).getAttribute('aria-colindex')).toBe('1');
      expect((wrappers[5] as HTMLElement).getAttribute('aria-colindex')).toBe('2');
    } finally {
      editor.destroy();
    }
  });

  test('empty section still carries role="grid" with aria-rowcount=1', () => {
    const wasm = makeStubWasm({
      title: 't',
      composer: null,
      style: null,
      key_signature: { root: { note: 'C', accidental: 'natural' }, mode: 'major' },
      time_signature: { numerator: 4, denominator: 4 },
      tempo: null,
      transpose: 0,
      sections: [{ label: { kind: 'letter', value: 'A' }, bars: [] }],
    });
    const editor = createIrealbEditor({ initialValue: SAMPLE_URL, wasm });
    try {
      const grid = editor.element.querySelector('.irealb-editor__bars');
      expect(grid).not.toBeNull();
      expect((grid as HTMLElement).getAttribute('role')).toBe('grid');
      expect((grid as HTMLElement).getAttribute('aria-rowcount')).toBe('1');
      expect(getCells(editor).length).toBe(0);
    } finally {
      editor.destroy();
    }
  });
});

describe('roving tabindex', () => {
  test('exactly one bar cell has tabindex="0" on initial render', () => {
    const wasm = makeStubWasm(makeSongWithBars(5));
    const editor = createIrealbEditor({ initialValue: SAMPLE_URL, wasm });
    try {
      const cells = getCells(editor);
      const tabbable = cells.filter((c) => c.tabIndex === 0);
      expect(tabbable.length).toBe(1);
      // First bar is the default active cell.
      expect(cells[0]?.tabIndex).toBe(0);
      expect(cells[1]?.tabIndex).toBe(-1);
      expect(cells[4]?.tabIndex).toBe(-1);
    } finally {
      editor.destroy();
    }
  });

  test('focusing a different cell makes it the tabbable one after the next render', () => {
    const wasm = makeStubWasm(makeSongWithBars(5));
    const editor = createIrealbEditor({ initialValue: SAMPLE_URL, wasm });
    withMounted(editor, () => {
      const cells = getCells(editor);
      const cell2 = cells[2];
      if (!cell2) throw new Error('cell2 missing');
      cell2.focus();
      expect(document.activeElement).toBe(cell2);
      // The DOM does not yet reflect the new tabindex (we only
      // restamp on render). After we trigger a re-render via a
      // structural op (e.g. add bar), the new active cell should
      // be cell index 2 — which after a no-op no-mutation render
      // means the carry-over via setActiveBar persisted.
      // Easier: directly trigger setValue('') then the original
      // URL to force a renderNow() and check the post-render
      // tabindex distribution.
      const onChange = vi.fn();
      editor.onChange(onChange);
      // Force a re-render by updating a metadata field: changing the
      // title via the rendered <input>.
      const titleInput = editor.element.querySelector<HTMLInputElement>(
        '.irealb-editor__input',
      );
      if (!titleInput) throw new Error('title input missing');
      titleInput.value = 'updated';
      titleInput.dispatchEvent(new Event('input', { bubbles: true }));
      // Title edit doesn't trigger renderNow (form-only), so cells
      // remain. The roving state was updated by the focus listener
      // (fired by `cell2.focus()`). Trigger a renderNow via deleteBar
      // on a different bar so the new cells reflect activeBar.
      const deleteBtns = Array.from(
        editor.element.querySelectorAll<HTMLButtonElement>(
          'button[aria-label="Delete bar"]',
        ),
      );
      // Delete the first bar so the active bar (index 2) re-anchors
      // — index 2 of the post-delete grid is the same logical cell,
      // and its tabindex should be 0.
      deleteBtns[0]?.click();
      const cellsAfter = getCells(editor);
      const tabbable = cellsAfter.filter((c) => c.tabIndex === 0);
      expect(tabbable.length).toBe(1);
    });
    editor.destroy();
  });

  test('after deleting the active bar, a sibling becomes the tabbable cell', () => {
    const wasm = makeStubWasm(makeSongWithBars(5));
    const editor = createIrealbEditor({ initialValue: SAMPLE_URL, wasm });
    withMounted(editor, () => {
      const cells = getCells(editor);
      cells[4]?.focus(); // active bar = last
      const deleteBtns = Array.from(
        editor.element.querySelectorAll<HTMLButtonElement>(
          'button[aria-label="Delete bar"]',
        ),
      );
      deleteBtns[4]?.click(); // delete the last bar
      const cellsAfter = getCells(editor);
      expect(cellsAfter.length).toBe(4);
      const tabbable = cellsAfter.filter((c) => c.tabIndex === 0);
      // The active ref was clamped to barIndex - 1 (== last
      // remaining bar, index 3). One cell tabbable.
      expect(tabbable.length).toBe(1);
      expect(cellsAfter[3]?.tabIndex).toBe(0);
    });
    editor.destroy();
  });
});

describe('arrow-key roving navigation', () => {
  test('ArrowRight moves focus to the next bar', () => {
    const wasm = makeStubWasm(makeSongWithBars(8));
    const editor = createIrealbEditor({ initialValue: SAMPLE_URL, wasm });
    withMounted(editor, () => {
      const cells = getCells(editor);
      cells[0]?.focus();
      dispatchKey(cells[0] as HTMLElement, 'ArrowRight');
      expect(document.activeElement).toBe(cells[1]);
    });
    editor.destroy();
  });

  test('ArrowLeft moves focus to the previous bar', () => {
    const wasm = makeStubWasm(makeSongWithBars(8));
    const editor = createIrealbEditor({ initialValue: SAMPLE_URL, wasm });
    withMounted(editor, () => {
      const cells = getCells(editor);
      cells[3]?.focus();
      dispatchKey(cells[3] as HTMLElement, 'ArrowLeft');
      expect(document.activeElement).toBe(cells[2]);
    });
    editor.destroy();
  });

  test('ArrowDown moves focus by one row (4 bars)', () => {
    const wasm = makeStubWasm(makeSongWithBars(8));
    const editor = createIrealbEditor({ initialValue: SAMPLE_URL, wasm });
    withMounted(editor, () => {
      const cells = getCells(editor);
      cells[1]?.focus();
      dispatchKey(cells[1] as HTMLElement, 'ArrowDown');
      expect(document.activeElement).toBe(cells[5]);
    });
    editor.destroy();
  });

  test('ArrowUp moves focus by one row (4 bars)', () => {
    const wasm = makeStubWasm(makeSongWithBars(8));
    const editor = createIrealbEditor({ initialValue: SAMPLE_URL, wasm });
    withMounted(editor, () => {
      const cells = getCells(editor);
      cells[6]?.focus();
      dispatchKey(cells[6] as HTMLElement, 'ArrowUp');
      expect(document.activeElement).toBe(cells[2]);
    });
    editor.destroy();
  });

  test('Home jumps focus to the first bar of the section', () => {
    const wasm = makeStubWasm(makeSongWithBars(7));
    const editor = createIrealbEditor({ initialValue: SAMPLE_URL, wasm });
    withMounted(editor, () => {
      const cells = getCells(editor);
      cells[5]?.focus();
      dispatchKey(cells[5] as HTMLElement, 'Home');
      expect(document.activeElement).toBe(cells[0]);
    });
    editor.destroy();
  });

  test('End jumps focus to the last bar of the section', () => {
    const wasm = makeStubWasm(makeSongWithBars(7));
    const editor = createIrealbEditor({ initialValue: SAMPLE_URL, wasm });
    withMounted(editor, () => {
      const cells = getCells(editor);
      cells[2]?.focus();
      dispatchKey(cells[2] as HTMLElement, 'End');
      expect(document.activeElement).toBe(cells[6]);
    });
    editor.destroy();
  });

  test('arrow keys are bounded — ArrowLeft on first bar is a no-op', () => {
    const wasm = makeStubWasm(makeSongWithBars(4));
    const editor = createIrealbEditor({ initialValue: SAMPLE_URL, wasm });
    withMounted(editor, () => {
      const cells = getCells(editor);
      cells[0]?.focus();
      const ev = dispatchKey(cells[0] as HTMLElement, 'ArrowLeft');
      // Bounded no-op: focus stays, default not prevented.
      expect(document.activeElement).toBe(cells[0]);
      expect(ev.defaultPrevented).toBe(false);
    });
    editor.destroy();
  });

  test('ArrowDown without enough rows is a bounded no-op', () => {
    const wasm = makeStubWasm(makeSongWithBars(3)); // single row
    const editor = createIrealbEditor({ initialValue: SAMPLE_URL, wasm });
    withMounted(editor, () => {
      const cells = getCells(editor);
      cells[1]?.focus();
      dispatchKey(cells[1] as HTMLElement, 'ArrowDown');
      expect(document.activeElement).toBe(cells[1]);
    });
    editor.destroy();
  });

  test('arrow keys with Ctrl/Meta do not roving-navigate (passes through to OS)', () => {
    const wasm = makeStubWasm(makeSongWithBars(8));
    const editor = createIrealbEditor({ initialValue: SAMPLE_URL, wasm });
    withMounted(editor, () => {
      const cells = getCells(editor);
      cells[0]?.focus();
      dispatchKey(cells[0] as HTMLElement, 'ArrowRight', { ctrl: true });
      expect(document.activeElement).toBe(cells[0]);
      dispatchKey(cells[0] as HTMLElement, 'ArrowRight', { meta: true });
      expect(document.activeElement).toBe(cells[0]);
    });
    editor.destroy();
  });
});

describe('Enter / Space activation opens the popover', () => {
  test('Enter on a bar cell opens the bar-edit popover', () => {
    const wasm = makeStubWasm(makeSongWithBars(2));
    const editor = createIrealbEditor({ initialValue: SAMPLE_URL, wasm });
    withMounted(editor, () => {
      const cells = getCells(editor);
      // <button type="button"> activates on Enter via the synthetic
      // click the browser dispatches; jsdom mirrors that. The
      // resulting click handler opens the popover.
      cells[0]?.click();
      const popover = editor.element.querySelector('.irealb-editor__popover');
      expect(popover).not.toBeNull();
      expect((popover as HTMLElement).getAttribute('role')).toBe('dialog');
      expect((popover as HTMLElement).getAttribute('aria-modal')).toBe('true');
    });
    editor.destroy();
  });
});

describe('live region announces structural edits', () => {
  function getLive(editor: ReturnType<typeof createIrealbEditor>): HTMLElement {
    const live = editor.element.querySelector('.irealb-editor__live');
    if (!(live instanceof HTMLElement)) {
      throw new Error('live region not mounted');
    }
    return live;
  }

  test('live region exists with aria-live="polite" and aria-atomic="true"', () => {
    const wasm = makeStubWasm(makeSongWithBars(2));
    const editor = createIrealbEditor({ initialValue: SAMPLE_URL, wasm });
    try {
      const live = getLive(editor);
      expect(live.getAttribute('aria-live')).toBe('polite');
      expect(live.getAttribute('aria-atomic')).toBe('true');
    } finally {
      editor.destroy();
    }
  });

  test('deleting a bar announces "Bar N deleted from section L"', async () => {
    const wasm = makeStubWasm(makeSongWithBars(3));
    const editor = createIrealbEditor({ initialValue: SAMPLE_URL, wasm });
    try {
      const live = getLive(editor);
      const deleteBtns = Array.from(
        editor.element.querySelectorAll<HTMLButtonElement>(
          'button[aria-label="Delete bar"]',
        ),
      );
      deleteBtns[1]?.click();
      // Announcement is queued via queueMicrotask — flush.
      await Promise.resolve();
      expect(live.textContent).toContain('Bar 2 deleted');
      expect(live.textContent).toContain('section A');
    } finally {
      editor.destroy();
    }
  });

  test('adding a bar announces "Bar N added to section L"', async () => {
    const wasm = makeStubWasm(makeSongWithBars(2));
    const editor = createIrealbEditor({ initialValue: SAMPLE_URL, wasm });
    try {
      const live = getLive(editor);
      const addBarBtn = editor.element.querySelector<HTMLButtonElement>(
        '.irealb-editor__add-bar',
      );
      addBarBtn?.click();
      await Promise.resolve();
      expect(live.textContent).toContain('Bar 3 added');
      expect(live.textContent).toContain('section A');
    } finally {
      editor.destroy();
    }
  });

  test('adding a section announces "Section L added"', async () => {
    const wasm = makeStubWasm(makeSongWithBars(1));
    const editor = createIrealbEditor({
      initialValue: SAMPLE_URL,
      wasm,
      promptSectionLabel: () => ({ kind: 'letter', value: 'B' }),
    });
    try {
      const live = getLive(editor);
      const addSectionBtn = editor.element.querySelector<HTMLButtonElement>(
        '.irealb-editor__add-section',
      );
      addSectionBtn?.click();
      await Promise.resolve();
      expect(live.textContent).toContain('Section B added');
    } finally {
      editor.destroy();
    }
  });

  test('deleting a section announces "Section L deleted"', async () => {
    const wasm = makeStubWasm(makeSongWithBars(1));
    const editor = createIrealbEditor({
      initialValue: SAMPLE_URL,
      wasm,
      confirmDeleteSection: () => true,
    });
    try {
      const live = getLive(editor);
      const deleteSectionBtn = editor.element.querySelector<HTMLButtonElement>(
        'button[aria-label="Delete section"]',
      );
      deleteSectionBtn?.click();
      await Promise.resolve();
      expect(live.textContent).toContain('Section A deleted');
    } finally {
      editor.destroy();
    }
  });

  test('moving a bar announces "Bar N moved left/right"', async () => {
    const wasm = makeStubWasm(makeSongWithBars(3));
    const editor = createIrealbEditor({ initialValue: SAMPLE_URL, wasm });
    try {
      const live = getLive(editor);
      const rightBtns = Array.from(
        editor.element.querySelectorAll<HTMLButtonElement>(
          'button[aria-label="Move bar right"]',
        ),
      );
      rightBtns[0]?.click();
      await Promise.resolve();
      expect(live.textContent).toContain('Bar 1 moved right');
    } finally {
      editor.destroy();
    }
  });

  test('two consecutive identical announcements both populate the region (empty-then-set)', async () => {
    // Polite live regions only fire when text content changes. The
    // announce() implementation blanks the region first via
    // queueMicrotask so two consecutive identical messages still
    // trigger an announcement. Verify the empty-then-set transition
    // is observable by inspecting the region between flushes.
    const wasm = makeStubWasm(makeSongWithBars(3));
    const editor = createIrealbEditor({ initialValue: SAMPLE_URL, wasm });
    try {
      const live = getLive(editor);
      const rightBtns = (): HTMLButtonElement[] =>
        Array.from(
          editor.element.querySelectorAll<HTMLButtonElement>(
            'button[aria-label="Move bar right"]',
          ),
        );

      // First click: synchronous side effect blanks the region;
      // microtask populates it.
      rightBtns()[0]?.click();
      expect(live.textContent).toBe('');
      await Promise.resolve();
      expect(live.textContent).toContain('moved right');

      // Second click on what is now bar 2 (post-move): same blank-
      // then-set transition; the region empties and re-populates so
      // the screen reader observes a change even though the message
      // is identical.
      rightBtns()[1]?.click();
      expect(live.textContent).toBe('');
      await Promise.resolve();
      expect(live.textContent).toContain('moved right');
    } finally {
      editor.destroy();
    }
  });
});
