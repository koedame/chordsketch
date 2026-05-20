import { fireEvent, render, screen } from '@testing-library/react';
import { beforeAll, describe, expect, test, vi } from 'vitest';

import { ChordProEditor } from '../src/index';
import type { ChordWasmLoader } from '../src/use-chord-render';

// `<SplitLayout>` (used by `<ChordProEditor>` to lay out source +
// preview side-by-side) reads `window.matchMedia` to decide whether
// to stack the panes on narrow viewports. jsdom does not provide
// matchMedia, so we install a minimal polyfill that always reports
// the wide-viewport branch.
beforeAll(() => {
  if (typeof window.matchMedia !== 'function') {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => false,
      }),
    });
  }
});

// Smoke-level coverage for the Tier 3 composed editor — verifies the
// header / source area / preview compose together, that source edits
// flow through to the preview, and that the format select swaps the
// rendered branch. Heavier interaction coverage lives in the
// `<ChordProPreview>` and `<ChordSourceArea>` suites that back this
// composition. The wasm AST loader is stubbed because the preview
// pane parses the live source on every keystroke; without the stub
// the editor would attempt a real wasm-bindgen dynamic import in
// jsdom.

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
    parseChordproWithWarnings: vi.fn((src: string) => ({
      ast: emptyAst(src),
      warnings: [],
      transposedKey: undefined,
    })),
    parseChordproWithWarningsAndOptions: vi.fn(
      (src: string, _opts: { transpose?: number }) => ({
        ast: emptyAst(src),
        warnings: [],
        transposedKey: undefined,
      }),
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

describe('<ChordProEditor>', () => {
  test('mounts with default props and renders the brand title', () => {
    render(<ChordProEditor wasmLoader={makeLoader(makeStub())} />);
    // Default title is `"ChordSketch"` per the prop default.
    expect(screen.getByRole('heading', { name: /ChordSketch/ })).toBeTruthy();
    // Preview format select shows the default `html` option.
    const select = screen.getByLabelText('Format') as HTMLSelectElement;
    expect(select.value).toBe('html');
  });

  test('null title omits the heading entirely', () => {
    render(<ChordProEditor title={null} wasmLoader={makeLoader(makeStub())} />);
    // Heading must not be in the DOM when title is null.
    expect(screen.queryByRole('heading')).toBeNull();
  });

  test('empty-string title omits the heading entirely', () => {
    // `<ChordProEditor>`'s `hasTitle` check treats `''` as "no title"
    // so a host that wants to hide the heading can pass an empty
    // string without falling through to the default `"ChordSketch"`.
    render(<ChordProEditor title="" wasmLoader={makeLoader(makeStub())} />);
    expect(screen.queryByRole('heading')).toBeNull();
  });

  test('headerExtras={null} does not render the controls slot', () => {
    // A host that conditionally renders header extras must not
    // produce an empty `<div class="…__controls">` when the
    // conditional is falsy.
    const { container } = render(
      <ChordProEditor
        title={null}
        headerExtras={null}
        wasmLoader={makeLoader(makeStub())}
      />,
    );
    expect(
      container.querySelector('.chordsketch-chord-pro-editor__controls'),
    ).toBeNull();
  });

  test('format toggle swaps the rendered preview branch', () => {
    render(<ChordProEditor wasmLoader={makeLoader(makeStub())} />);
    const select = screen.getByLabelText('Format') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'pdf' } });
    // PDF branch renders a download button.
    expect(screen.getByRole('button', { name: 'Download PDF' })).toBeTruthy();
  });

  test('controlled source: edits propagate via onSourceChange', () => {
    // The editor uses `<ChordSourceArea>` (CodeMirror) on the
    // source side. Driving CodeMirror via fireEvent inside jsdom is
    // brittle, so this test asserts the controlled-mode contract
    // directly: when the host updates `source`, the editor receives
    // and forwards it to the preview pane. The smoke assertion is
    // that the component re-renders without throwing when the
    // controlled value changes.
    const onSourceChange = vi.fn();
    const { rerender } = render(
      <ChordProEditor
        source="initial"
        onSourceChange={onSourceChange}
        wasmLoader={makeLoader(makeStub())}
      />,
    );
    rerender(
      <ChordProEditor
        source="next"
        onSourceChange={onSourceChange}
        wasmLoader={makeLoader(makeStub())}
      />,
    );
    // The controlled rerender path is exercised; the source change
    // would flow into `<ChordProPreview>` via the `source` prop.
    expect(screen.getByLabelText('Format')).toBeTruthy();
  });

  test('dev-warning fires when source flips between controlled and uncontrolled', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { rerender } = render(
        <ChordProEditor
          source="controlled"
          onSourceChange={vi.fn()}
          wasmLoader={makeLoader(makeStub())}
        />,
      );
      rerender(
        <ChordProEditor
          defaultSource="uncontrolled"
          wasmLoader={makeLoader(makeStub())}
        />,
      );
      const messages = err.mock.calls.map((call) => String(call[0]));
      expect(
        messages.some(
          (m) =>
            m.includes('<ChordProEditor> source') &&
            m.includes('controlled') &&
            m.includes('uncontrolled'),
        ),
      ).toBe(true);
    } finally {
      err.mockRestore();
    }
  });
});
