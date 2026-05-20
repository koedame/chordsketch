import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

import { IrealProEditor, type CombinedIrealLoader } from '../src/ireal-pro-editor';
import type { IrealSong } from '../src/ireal-ast';

interface EditorStub {
  default: ReturnType<typeof vi.fn>;
  parseIrealb: ReturnType<typeof vi.fn>;
  serializeIrealb: ReturnType<typeof vi.fn>;
  renderIrealSvg: ReturnType<typeof vi.fn>;
}

function songFixture(): IrealSong {
  return {
    title: 'Test',
    composer: null,
    style: null,
    key_signature: {
      root: { note: 'C', accidental: 'natural' },
      mode: 'major',
    },
    time_signature: { numerator: 4, denominator: 4 },
    tempo: null,
    transpose: 0,
    sections: [],
  };
}

function makeStub(): EditorStub {
  let song = songFixture();
  return {
    default: vi.fn(async () => undefined),
    parseIrealb: vi.fn(() => JSON.stringify(song)),
    serializeIrealb: vi.fn((json: string) => {
      song = JSON.parse(json) as IrealSong;
      return `irealb://t/${encodeURIComponent(song.title)}`;
    }),
    renderIrealSvg: vi.fn((src: string) => `<svg data-testid="ireal-svg">${src}</svg>`),
  };
}

function makeLoader(stub: EditorStub): CombinedIrealLoader {
  // The stub provides `parseIrealb` + `serializeIrealb` (bar-grid
  // surface) AND `renderIrealSvg` (preview surface), satisfying the
  // intersection at the prop boundary without an `unknown`-cast.
  return vi.fn(async () => stub as unknown as Awaited<ReturnType<CombinedIrealLoader>>);
}

describe('<IrealProEditor>', () => {
  test('mounts both editor and preview by default', async () => {
    const stub = makeStub();
    const { container } = render(
      <IrealProEditor defaultValue="irealb://demo" loader={makeLoader(stub)} />,
    );
    await waitFor(() => expect(stub.parseIrealb).toHaveBeenCalled());
    expect(container.querySelector('.chordsketch-ireal-pro-editor__editor')).toBeTruthy();
    expect(container.querySelector('.chordsketch-ireal-pro-editor__preview')).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId('ireal-svg')).toBeTruthy());
  });

  test('hidePreview removes the preview pane', async () => {
    const stub = makeStub();
    const { container } = render(
      <IrealProEditor defaultValue="irealb://demo" loader={makeLoader(stub)} hidePreview />,
    );
    await waitFor(() => expect(stub.parseIrealb).toHaveBeenCalled());
    expect(container.querySelector('.chordsketch-ireal-pro-editor__preview')).toBeNull();
    // Preview's wasm calls should not happen either.
    expect(stub.renderIrealSvg).not.toHaveBeenCalled();
  });

  test('uncontrolled mode: editor edits update internal state', async () => {
    const stub = makeStub();
    render(
      <IrealProEditor defaultValue="irealb://demo" loader={makeLoader(stub)} />,
    );
    await waitFor(() => expect(stub.parseIrealb).toHaveBeenCalled());
    const titleInput = screen.getByLabelText('Title') as HTMLInputElement;
    fireEvent.change(titleInput, { target: { value: 'Edited' } });
    await waitFor(() => expect(stub.serializeIrealb).toHaveBeenCalled());
    // Internal value should reflect the new URL; we cannot inspect
    // it directly without an exposed handle, but we can confirm the
    // editor re-rendered with the new title.
    await waitFor(() => {
      expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('Edited');
    });
  });

  test('controlled mode forwards onChange to the host', async () => {
    const stub = makeStub();
    const onChange = vi.fn();
    render(
      <IrealProEditor
        source="irealb://controlled"
        onChange={onChange}
        loader={makeLoader(stub)}
      />,
    );
    await waitFor(() => expect(stub.parseIrealb).toHaveBeenCalled());
    const titleInput = screen.getByLabelText('Title') as HTMLInputElement;
    fireEvent.change(titleInput, { target: { value: 'Ctrl' } });
    await waitFor(() => expect(onChange).toHaveBeenCalled());
  });
});
