import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

import { IrealEditor } from '../src/ireal-editor';
import type { IrealEditorLoader } from '../src/ireal-editor';
import type { IrealSong } from '../src/ireal-ast';

interface EditorStub {
  default: ReturnType<typeof vi.fn>;
  parseIrealb: ReturnType<typeof vi.fn>;
  serializeIrealb: ReturnType<typeof vi.fn>;
}

function songFixture(): IrealSong {
  return {
    title: 'Autumn Leaves',
    composer: 'Joseph Kosma',
    style: 'Jazz Ballad',
    key_signature: {
      root: { note: 'E', accidental: 'natural' },
      mode: 'minor',
    },
    time_signature: { numerator: 4, denominator: 4 },
    tempo: 90,
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
                  quality: { kind: 'minor7' },
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
}

function makeStub(initial: IrealSong = songFixture()): EditorStub {
  // Simple round-trip: parse returns the JSON of the held song;
  // serialize updates the held song from incoming JSON.
  let song = initial;
  return {
    default: vi.fn(async () => undefined),
    parseIrealb: vi.fn(() => JSON.stringify(song)),
    serializeIrealb: vi.fn((json: string) => {
      song = JSON.parse(json) as IrealSong;
      return `irealb://serialised/${encodeURIComponent(song.title)}`;
    }),
  };
}

function makeLoader(stub: EditorStub): IrealEditorLoader {
  return vi.fn(async () => stub as unknown as Awaited<ReturnType<IrealEditorLoader>>);
}

describe('<IrealEditor>', () => {
  test('shows a loading state until wasm resolves', async () => {
    let resolve!: (stub: EditorStub) => void;
    const loader: IrealEditorLoader = () =>
      new Promise<Awaited<ReturnType<IrealEditorLoader>>>((res) => {
        resolve = (s) => res(s as unknown as Awaited<ReturnType<IrealEditorLoader>>);
      });
    const { container } = render(<IrealEditor source="irealb://x" loader={loader} />);
    expect(container.querySelector('.chordsketch-ireal-editor__loading')).toBeTruthy();
    const stub = makeStub();
    resolve(stub);
    await waitFor(() => expect(stub.parseIrealb).toHaveBeenCalled());
  });

  test('populates form fields from the parsed song', async () => {
    const stub = makeStub();
    render(<IrealEditor source="irealb://x" loader={makeLoader(stub)} />);
    await waitFor(() => expect(stub.parseIrealb).toHaveBeenCalled());
    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('Autumn Leaves');
    expect((screen.getByLabelText('Composer') as HTMLInputElement).value).toBe('Joseph Kosma');
    expect((screen.getByLabelText('Style') as HTMLInputElement).value).toBe('Jazz Ballad');
    expect((screen.getByLabelText('Key root') as HTMLSelectElement).value).toBe('E');
    expect((screen.getByLabelText('Mode') as HTMLSelectElement).value).toBe('minor');
    expect((screen.getByLabelText('Tempo') as HTMLInputElement).value).toBe('90');
  });

  test('renders bar grid with section label + chord text', async () => {
    const stub = makeStub();
    render(<IrealEditor source="irealb://x" loader={makeLoader(stub)} />);
    await waitFor(() => expect(stub.parseIrealb).toHaveBeenCalled());
    expect(screen.getByRole('heading', { name: 'A' })).toBeTruthy();
    expect(screen.getByText('C-7')).toBeTruthy();
  });

  test('editing title triggers onChange with serialised URL', async () => {
    const stub = makeStub();
    const onChange = vi.fn();
    render(
      <IrealEditor source="irealb://x" loader={makeLoader(stub)} onChange={onChange} />,
    );
    await waitFor(() => expect(stub.parseIrealb).toHaveBeenCalled());
    const titleInput = screen.getByLabelText('Title') as HTMLInputElement;
    fireEvent.change(titleInput, { target: { value: 'New Title' } });
    await waitFor(() => {
      expect(stub.serializeIrealb).toHaveBeenCalled();
      expect(onChange).toHaveBeenCalledWith(
        `irealb://serialised/${encodeURIComponent('New Title')}`,
      );
    });
  });

  test('omitting onChange forces read-only fields', async () => {
    const stub = makeStub();
    render(<IrealEditor source="irealb://x" loader={makeLoader(stub)} />);
    await waitFor(() => expect(stub.parseIrealb).toHaveBeenCalled());
    const titleInput = screen.getByLabelText('Title') as HTMLInputElement;
    // `<fieldset disabled>` propagates the disabled *behaviour* to
    // its descendant form controls but does NOT set the child's
    // own `.disabled` IDL attribute. Check the fieldset directly,
    // which is the canonical signal HTML uses.
    expect(titleInput.closest('fieldset')?.disabled).toBe(true);
  });

  test('readOnly={true} disables fields even when onChange is provided', async () => {
    const stub = makeStub();
    render(
      <IrealEditor
        source="irealb://x"
        loader={makeLoader(stub)}
        onChange={vi.fn()}
        readOnly
      />,
    );
    await waitFor(() => expect(stub.parseIrealb).toHaveBeenCalled());
    const titleInput = screen.getByLabelText('Title') as HTMLInputElement;
    expect(titleInput.closest('fieldset')?.disabled).toBe(true);
  });

  test('empty source seeds an empty song without invoking parseIrealb', async () => {
    const stub = makeStub();
    render(<IrealEditor source="" loader={makeLoader(stub)} />);
    await waitFor(() => expect(stub.default).toHaveBeenCalled());
    expect(stub.parseIrealb).not.toHaveBeenCalled();
    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('');
  });

  test('parse errors surface as inline role="alert"', async () => {
    const stub = makeStub();
    stub.parseIrealb.mockImplementation(() => {
      throw new Error('parse boom');
    });
    render(<IrealEditor source="irealb://garbage" loader={makeLoader(stub)} />);
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toBe('parse boom');
    });
  });

  test('hides URL textarea when showUrl=false', async () => {
    const stub = makeStub();
    render(
      <IrealEditor source="irealb://x" loader={makeLoader(stub)} showUrl={false} />,
    );
    await waitFor(() => expect(stub.parseIrealb).toHaveBeenCalled());
    expect(screen.queryByLabelText('iReal Pro URL')).toBeNull();
  });

  test('transpose input clamps to [-11, 11]', async () => {
    const stub = makeStub();
    const onChange = vi.fn();
    render(
      <IrealEditor source="irealb://x" loader={makeLoader(stub)} onChange={onChange} />,
    );
    await waitFor(() => expect(stub.parseIrealb).toHaveBeenCalled());
    const transpose = screen.getByLabelText('Transpose') as HTMLInputElement;
    fireEvent.change(transpose, { target: { value: '50' } });
    await waitFor(() => expect(stub.serializeIrealb).toHaveBeenCalled());
    const serialised = stub.serializeIrealb.mock.calls.at(-1)?.[0] as string;
    const parsed = JSON.parse(serialised) as IrealSong;
    expect(parsed.transpose).toBe(11);
  });
});
