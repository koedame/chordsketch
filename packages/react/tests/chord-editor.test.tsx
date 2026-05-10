import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, test, vi } from 'vitest';

import { ChordEditor } from '../src/index';
import type { ChordWasmLoader } from '../src/use-chord-render';

// Reuse the stub shape from the chord-sheet suite — the editor's
// preview pane is just a `<ChordSheet>` under the hood. Post-#2475
// the html branch parses to AST JSON via parseChordpro instead of
// rendering an HTML string; the text branch is unchanged.
function emptyAst(marker?: string): string {
  return JSON.stringify({
    metadata: {
      title: marker ?? null,
      subtitles: [],
      artists: [],
      composers: [],
      lyricists: [],
      album: null,
      year: null,
      key: null,
      tempo: null,
      time: null,
      capo: null,
      sortTitle: null,
      sortArtist: null,
      arrangers: [],
      copyright: null,
      duration: null,
      tags: [],
      custom: [],
    },
    lines: [],
  });
}

function makeStub() {
  return {
    default: vi.fn(async () => undefined),
    parseChordpro: vi.fn((src: string) => emptyAst(src)),
    parseChordproWithOptions: vi.fn(
      (src: string, _opts: { transpose?: number }) => emptyAst(src),
    ),
    render_text: vi.fn((src: string) => `TEXT:${src}`),
    render_text_with_options: vi.fn(
      (src: string, opts: { transpose?: number }) => `TEXT+${opts.transpose ?? 0}:${src}`,
    ),
  };
}

function makeLoader(stub: ReturnType<typeof makeStub>): ChordWasmLoader {
  return vi.fn(async () => stub as unknown as Awaited<ReturnType<ChordWasmLoader>>);
}

describe('<ChordEditor>', () => {
  test('uncontrolled mode: renders defaultValue and fires onChange on input', async () => {
    const stub = makeStub();
    const onChange = vi.fn();

    render(
      <ChordEditor
        defaultValue="start"
        onChange={onChange}
        wasmLoader={makeLoader(stub)}
        debounceMs={0}
      />,
    );

    const textarea = screen.getByPlaceholderText(
      'Enter ChordPro source here…',
    ) as HTMLTextAreaElement;
    expect(textarea.value).toBe('start');

    fireEvent.change(textarea, { target: { value: 'next' } });
    expect(onChange).toHaveBeenCalledWith('next');
    expect(textarea.value).toBe('next');
  });

  test('controlled mode: value prop wins, host owns state via onChange', () => {
    function Controlled() {
      const [v, setV] = useState('foo');
      return (
        <>
          <ChordEditor
            value={v}
            onChange={setV}
            wasmLoader={makeLoader(makeStub())}
            debounceMs={0}
          />
          <div data-testid="observed">{v}</div>
        </>
      );
    }
    render(<Controlled />);
    const textarea = screen.getByPlaceholderText(
      'Enter ChordPro source here…',
    ) as HTMLTextAreaElement;
    expect(textarea.value).toBe('foo');
    fireEvent.change(textarea, { target: { value: 'bar' } });
    expect(screen.getByTestId('observed').textContent).toBe('bar');
    expect(textarea.value).toBe('bar');
  });

  test('textarea has a default aria-label that overrides the placeholder-as-name fallback', () => {
    const stub = makeStub();
    render(
      <ChordEditor
        defaultValue=""
        wasmLoader={makeLoader(stub)}
        debounceMs={0}
      />,
    );
    const textarea = screen.getByRole('textbox', { name: 'ChordPro editor' });
    expect(textarea.tagName).toBe('TEXTAREA');
  });

  test('textareaAriaLabel prop overrides the default accessible name', () => {
    const stub = makeStub();
    render(
      <ChordEditor
        defaultValue=""
        textareaAriaLabel="Lyrics source"
        wasmLoader={makeLoader(stub)}
        debounceMs={0}
      />,
    );
    const textarea = screen.getByRole('textbox', { name: 'Lyrics source' });
    expect(textarea.tagName).toBe('TEXTAREA');
  });

  test('dev-warning fires when the editor flips between controlled and uncontrolled', () => {
    const stub = makeStub();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // Start controlled (value defined).
      const { rerender } = render(
        <ChordEditor
          value="start"
          onChange={vi.fn()}
          wasmLoader={makeLoader(stub)}
          debounceMs={0}
        />,
      );
      // Flip to uncontrolled by passing undefined — same shape as
      // the React core warning on `<input>`. Regression guard for
      // #2160.
      rerender(
        <ChordEditor
          defaultValue="next"
          onChange={vi.fn()}
          wasmLoader={makeLoader(stub)}
          debounceMs={0}
        />,
      );

      const messages = err.mock.calls.map((call) => String(call[0]));
      expect(
        messages.some((m) => m.includes('controlled') && m.includes('uncontrolled')),
      ).toBe(true);
    } finally {
      err.mockRestore();
    }
  });

  test('readOnly forwards to the textarea', () => {
    render(
      <ChordEditor
        defaultValue="frozen"
        readOnly
        wasmLoader={makeLoader(makeStub())}
        debounceMs={0}
      />,
    );
    const textarea = screen.getByPlaceholderText(
      'Enter ChordPro source here…',
    ) as HTMLTextAreaElement;
    expect(textarea.readOnly).toBe(true);
  });

  test('debounced preview only re-renders after the quiet window', async () => {
    const stub = makeStub();
    render(
      <ChordEditor
        defaultValue=""
        wasmLoader={makeLoader(stub)}
        debounceMs={120}
      />,
    );
    const textarea = screen.getByPlaceholderText(
      'Enter ChordPro source here…',
    ) as HTMLTextAreaElement;

    // Wait for the initial WASM load and empty-input render
    // so the call counter starts from a predictable baseline.
    // The initial render uses \`parseChordproWithOptions\`
    // because \`transpose\` defaults to 0 (a non-undefined value).
    await waitFor(() =>
      expect(stub.parseChordproWithOptions).toHaveBeenCalledTimes(1),
    );

    fireEvent.change(textarea, { target: { value: 'a' } });
    fireEvent.change(textarea, { target: { value: 'ab' } });
    fireEvent.change(textarea, { target: { value: 'abc' } });

    // Within ~50 ms no preview re-render has fired — all three
    // keystrokes are still inside the debounce window.
    await new Promise((r) => setTimeout(r, 50));
    expect(stub.parseChordproWithOptions).toHaveBeenCalledTimes(1);

    // After the window elapses, exactly one additional render
    // fires with the final value.
    await waitFor(
      () => {
        const calls = stub.parseChordproWithOptions.mock.calls;
        const lastSrc = calls.length > 0 ? calls[calls.length - 1]?.[0] : undefined;
        expect(lastSrc).toBe('abc');
      },
      { timeout: 1000 },
    );
    // Still exactly 2 total calls (initial + debounced final),
    // not 4 (one per keystroke) — proves the debounce coalesced.
    expect(stub.parseChordproWithOptions).toHaveBeenCalledTimes(2);
  });

  test('Ctrl+ArrowUp / Ctrl+ArrowDown fire onTransposeChange with clamped values', async () => {
    const onTransposeChange = vi.fn();
    const stub = makeStub();

    render(
      <ChordEditor
        defaultValue="x"
        transpose={2}
        onTransposeChange={onTransposeChange}
        minTranspose={-5}
        maxTranspose={5}
        wasmLoader={makeLoader(stub)}
        debounceMs={0}
      />,
    );
    const textarea = screen.getByPlaceholderText('Enter ChordPro source here…');

    fireEvent.keyDown(textarea, { key: 'ArrowUp', ctrlKey: true });
    expect(onTransposeChange).toHaveBeenLastCalledWith(3);

    fireEvent.keyDown(textarea, { key: 'ArrowDown', ctrlKey: true });
    expect(onTransposeChange).toHaveBeenLastCalledWith(1);

    // Cmd key also works for macOS parity.
    fireEvent.keyDown(textarea, { key: 'ArrowUp', metaKey: true });
    expect(onTransposeChange).toHaveBeenLastCalledWith(3);

    // Arrow keys without modifier do NOT fire the callback (leave
    // cursor navigation alone).
    onTransposeChange.mockClear();
    fireEvent.keyDown(textarea, { key: 'ArrowUp' });
    expect(onTransposeChange).not.toHaveBeenCalled();
  });

  test('transpose shortcut clamps at max / min boundary (no callback fired)', () => {
    const onTransposeChange = vi.fn();
    const stub = makeStub();

    render(
      <ChordEditor
        defaultValue="x"
        transpose={5}
        minTranspose={-5}
        maxTranspose={5}
        onTransposeChange={onTransposeChange}
        wasmLoader={makeLoader(stub)}
        debounceMs={0}
      />,
    );
    const textarea = screen.getByPlaceholderText('Enter ChordPro source here…');

    // At max — up shortcut should be a no-op.
    fireEvent.keyDown(textarea, { key: 'ArrowUp', ctrlKey: true });
    expect(onTransposeChange).not.toHaveBeenCalled();
  });

  test('transpose shortcut at min boundary is a no-op on ArrowDown', () => {
    const onTransposeChange = vi.fn();
    const stub = makeStub();

    render(
      <ChordEditor
        defaultValue="x"
        transpose={-5}
        minTranspose={-5}
        maxTranspose={5}
        onTransposeChange={onTransposeChange}
        wasmLoader={makeLoader(stub)}
        debounceMs={0}
      />,
    );
    const textarea = screen.getByPlaceholderText('Enter ChordPro source here…');

    // At min — down shortcut should be a no-op (symmetric guard
    // to the max-boundary test above).
    fireEvent.keyDown(textarea, { key: 'ArrowDown', ctrlKey: true });
    expect(onTransposeChange).not.toHaveBeenCalled();
  });

  test('transpose value is forwarded to the preview via parseChordproWithOptions', async () => {
    const stub = makeStub();
    render(
      <ChordEditor
        defaultValue="src"
        transpose={3}
        wasmLoader={makeLoader(stub)}
        debounceMs={0}
      />,
    );
    await waitFor(
      () =>
        expect(stub.parseChordproWithOptions).toHaveBeenCalledWith('src', {
          transpose: 3,
          config: undefined,
        }),
      { timeout: 2000 },
    );
  });

  test('previewFormat="text" with default transpose still goes through the with-options variant', async () => {
    const stub = makeStub();
    render(
      <ChordEditor
        defaultValue="src"
        previewFormat="text"
        wasmLoader={makeLoader(stub)}
        debounceMs={0}
      />,
    );
    // `<ChordEditor>` defaults `transpose` to 0 and forwards it
    // to the preview. `useChordRender` routes any non-undefined
    // transpose through `render_text_with_options`, so the plain
    // `render_text` does not fire here — the check below is on
    // the options variant.
    await waitFor(
      () =>
        expect(stub.render_text_with_options).toHaveBeenCalledWith('src', {
          transpose: 0,
          config: undefined,
        }),
      { timeout: 2000 },
    );
  });
});
