// Integration tests for structural editing (add/rename/delete/move
// section + bar) in `<IrealEditor>`. Sister-site (DOM):
// `packages/ui-irealb-editor/tests/structural.test.ts`.

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

import { IrealEditor, type IrealEditorLoader } from '../src/ireal-editor';
import type {
  IrealSong,
  IrealSectionLabel,
} from '../src/ireal-ast';

interface EditorStub {
  default: ReturnType<typeof vi.fn>;
  parseIrealb: ReturnType<typeof vi.fn>;
  serializeIrealb: ReturnType<typeof vi.fn>;
  /** Capture of the most-recently-serialised song so tests can
   * assert AST mutations without re-parsing the URL. */
  lastSong: () => IrealSong;
}

function twoSectionsSong(): IrealSong {
  const emptyBar = {
    start: 'single' as const,
    end: 'single' as const,
    chords: [],
    ending: null,
    symbol: null,
  };
  return {
    title: 'Fixture',
    composer: null,
    style: null,
    key_signature: { root: { note: 'C', accidental: 'natural' }, mode: 'major' },
    time_signature: { numerator: 4, denominator: 4 },
    tempo: null,
    transpose: 0,
    sections: [
      { label: { kind: 'letter', value: 'A' }, bars: [emptyBar, emptyBar] },
      { label: { kind: 'letter', value: 'B' }, bars: [emptyBar] },
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

function makeLoader(stub: EditorStub): IrealEditorLoader {
  return vi.fn(async () => stub as unknown as Awaited<ReturnType<IrealEditorLoader>>);
}

async function renderEditor(opts?: {
  song?: IrealSong;
  promptSectionLabel?: (current: IrealSectionLabel | null) => IrealSectionLabel | null;
  confirmDeleteSection?: (label: IrealSectionLabel) => boolean;
}) {
  const stub = makeStub(opts?.song ?? twoSectionsSong());
  const onChange = vi.fn();
  const result = render(
    <IrealEditor
      source="irealb://x"
      loader={makeLoader(stub)}
      onChange={onChange}
      promptSectionLabel={opts?.promptSectionLabel}
      confirmDeleteSection={opts?.confirmDeleteSection}
    />,
  );
  await waitFor(() => expect(stub.parseIrealb).toHaveBeenCalled());
  return { ...result, stub, onChange };
}

describe('<IrealEditor> structural — add section', () => {
  test('appends with prompted label + one default bar', async () => {
    const { stub } = await renderEditor({
      promptSectionLabel: () => ({ kind: 'letter', value: 'C' }),
    });
    fireEvent.click(screen.getByRole('button', { name: '+ Add section' }));
    await waitFor(() => expect(stub.serializeIrealb).toHaveBeenCalled());
    const next = stub.lastSong();
    expect(next.sections.length).toBe(3);
    expect(next.sections[2]!.label).toEqual({ kind: 'letter', value: 'C' });
    expect(next.sections[2]!.bars.length).toBe(1);
  });

  test('cancelled prompt is a no-op (no onChange, no AST change)', async () => {
    const { stub, onChange } = await renderEditor({
      promptSectionLabel: () => null,
    });
    fireEvent.click(screen.getByRole('button', { name: '+ Add section' }));
    expect(stub.serializeIrealb).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
    expect(stub.lastSong().sections.length).toBe(2);
  });
});

describe('<IrealEditor> structural — rename section', () => {
  test('replaces label after prompt + seeds prompt with current value', async () => {
    const prompt = vi.fn<(c: IrealSectionLabel | null) => IrealSectionLabel | null>(
      () => ({ kind: 'letter', value: 'X' }),
    );
    const { stub } = await renderEditor({ promptSectionLabel: prompt });
    const renameButtons = screen.getAllByRole('button', { name: 'Rename section' });
    fireEvent.click(renameButtons[0]!);
    await waitFor(() => expect(stub.serializeIrealb).toHaveBeenCalled());
    // The prompt was seeded with the current section's label.
    expect(prompt.mock.calls[0]![0]).toEqual({ kind: 'letter', value: 'A' });
    expect(stub.lastSong().sections[0]!.label).toEqual({ kind: 'letter', value: 'X' });
  });

  test('renaming to the identical label suppresses onChange', async () => {
    const { stub, onChange } = await renderEditor({
      promptSectionLabel: () => ({ kind: 'letter', value: 'A' }),
    });
    fireEvent.click(screen.getAllByRole('button', { name: 'Rename section' })[0]!);
    expect(stub.serializeIrealb).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('<IrealEditor> structural — delete section', () => {
  test('confirmation accepted removes the section', async () => {
    const { stub } = await renderEditor({
      confirmDeleteSection: () => true,
    });
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete section' })[0]!);
    await waitFor(() => expect(stub.serializeIrealb).toHaveBeenCalled());
    expect(stub.lastSong().sections.length).toBe(1);
    expect(stub.lastSong().sections[0]!.label).toEqual({ kind: 'letter', value: 'B' });
  });

  test('confirmation declined is a no-op', async () => {
    const { stub, onChange } = await renderEditor({
      confirmDeleteSection: () => false,
    });
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete section' })[0]!);
    expect(stub.serializeIrealb).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('<IrealEditor> structural — move section', () => {
  test('Move section up swaps with the previous; disabled at index 0', async () => {
    const { stub } = await renderEditor();
    const moveUps = screen.getAllByRole('button', { name: 'Move section up' });
    expect((moveUps[0]! as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(moveUps[1]!);
    await waitFor(() => expect(stub.serializeIrealb).toHaveBeenCalled());
    expect(stub.lastSong().sections[0]!.label).toEqual({ kind: 'letter', value: 'B' });
    expect(stub.lastSong().sections[1]!.label).toEqual({ kind: 'letter', value: 'A' });
  });

  test('Move section down swaps with the next; disabled on the last section', async () => {
    const { stub } = await renderEditor();
    const moveDowns = screen.getAllByRole('button', { name: 'Move section down' });
    expect((moveDowns[1]! as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(moveDowns[0]!);
    await waitFor(() => expect(stub.serializeIrealb).toHaveBeenCalled());
    expect(stub.lastSong().sections[0]!.label).toEqual({ kind: 'letter', value: 'B' });
    expect(stub.lastSong().sections[1]!.label).toEqual({ kind: 'letter', value: 'A' });
  });
});

describe('<IrealEditor> structural — bar operations', () => {
  test('Add bar appends to the targeted section only', async () => {
    const { stub } = await renderEditor();
    const addBarButtons = screen.getAllByRole('button', { name: '+ Add bar' });
    fireEvent.click(addBarButtons[0]!);
    await waitFor(() => expect(stub.serializeIrealb).toHaveBeenCalled());
    expect(stub.lastSong().sections[0]!.bars.length).toBe(3);
    expect(stub.lastSong().sections[1]!.bars.length).toBe(1);
  });

  test('Delete bar removes the targeted bar', async () => {
    const { stub } = await renderEditor();
    const deleteButtons = screen.getAllByRole('button', { name: 'Delete bar' });
    fireEvent.click(deleteButtons[0]!);
    await waitFor(() => expect(stub.serializeIrealb).toHaveBeenCalled());
    expect(stub.lastSong().sections[0]!.bars.length).toBe(1);
  });

  test('Move bar left / right swap within section; first/last disabled', async () => {
    const { stub } = await renderEditor();
    const moveLefts = screen.getAllByRole('button', { name: 'Move bar left' });
    const moveRights = screen.getAllByRole('button', { name: 'Move bar right' });
    expect((moveLefts[0]! as HTMLButtonElement).disabled).toBe(true);
    expect((moveRights[1]! as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(moveRights[0]!);
    await waitFor(() => expect(stub.serializeIrealb).toHaveBeenCalled());
    // Swap doesn't change visible chord text in this fixture (both
    // bars are empty), so we assert via call count + final length.
    expect(stub.lastSong().sections[0]!.bars.length).toBe(2);
  });
});

describe('<IrealEditor> structural — announcements', () => {
  test('section add announces via the live region', async () => {
    const { container } = await renderEditor({
      promptSectionLabel: () => ({ kind: 'letter', value: 'C' }),
    });
    fireEvent.click(screen.getByRole('button', { name: '+ Add section' }));
    // Live region populated after the queueMicrotask hop inside
    // useAnnouncer. Flush microtasks then assert.
    await Promise.resolve();
    await waitFor(() => {
      const live = container.querySelector('[role="status"]');
      expect(live?.textContent).toBe('Section C added');
    });
  });

  test('bar delete announces with the bar number + section label', async () => {
    const { container } = await renderEditor();
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete bar' })[0]!);
    await Promise.resolve();
    await waitFor(() => {
      const live = container.querySelector('[role="status"]');
      expect(live?.textContent).toBe('Bar 1 deleted from section A');
    });
  });
});
