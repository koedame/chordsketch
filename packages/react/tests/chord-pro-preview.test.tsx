import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, test, vi } from 'vitest';

import { ChordProPreview, PDF_EXPORT_DEFAULT_LABEL } from '../src/index';
import type { ChordWasmLoader } from '../src/use-chord-render';

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

describe('<ChordProPreview>', () => {
  test('renders a format select with the default option list', () => {
    render(
      <ChordProPreview
        source="{title: Hello}"
        wasmLoader={makeLoader(makeStub())}
      />,
    );
    const select = screen.getByLabelText('Format') as HTMLSelectElement;
    const options = Array.from(select.options).map((o) => o.value);
    expect(options).toEqual(['html', 'text', 'pdf']);
    // Default format is html.
    expect(select.value).toBe('html');
  });

  test('honours a custom formats prop', () => {
    render(
      <ChordProPreview
        source="{title: Hello}"
        formats={['html', 'text']}
        wasmLoader={makeLoader(makeStub())}
      />,
    );
    const select = screen.getByLabelText('Format') as HTMLSelectElement;
    const options = Array.from(select.options).map((o) => o.value);
    expect(options).toEqual(['html', 'text']);
  });

  test('uncontrolled format: select changes drive internal state', () => {
    render(
      <ChordProPreview
        source="{title: Hello}"
        defaultFormat="text"
        wasmLoader={makeLoader(makeStub())}
      />,
    );
    const select = screen.getByLabelText('Format') as HTMLSelectElement;
    expect(select.value).toBe('text');
    fireEvent.change(select, { target: { value: 'html' } });
    expect(select.value).toBe('html');
  });

  test('controlled format: host owns state via onFormatChange', () => {
    const onFormatChange = vi.fn();
    function Controlled() {
      const [format, setFormat] = useState<'html' | 'text' | 'pdf'>('html');
      return (
        <ChordProPreview
          source="src"
          format={format}
          onFormatChange={(next) => {
            onFormatChange(next);
            setFormat(next);
          }}
          wasmLoader={makeLoader(makeStub())}
        />
      );
    }
    render(<Controlled />);
    const select = screen.getByLabelText('Format') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'pdf' } });
    expect(onFormatChange).toHaveBeenCalledWith('pdf');
    expect(select.value).toBe('pdf');
  });

  test('uncontrolled transpose: button clicks fire internal updates', () => {
    render(
      <ChordProPreview
        source="src"
        defaultTranspose={0}
        wasmLoader={makeLoader(makeStub())}
      />,
    );
    const up = screen.getByLabelText('Transpose up one semitone');
    fireEvent.click(up);
    // The Transpose readout displays the current value; the
    // component should now show +1.
    const output = screen.getByRole('status');
    expect(output.textContent).toContain('+1');
  });

  test('controlled transpose: host owns state via onTransposeChange', () => {
    const onTransposeChange = vi.fn();
    function Controlled() {
      const [t, setT] = useState(0);
      return (
        <ChordProPreview
          source="src"
          transpose={t}
          onTransposeChange={(next) => {
            onTransposeChange(next);
            setT(next);
          }}
          wasmLoader={makeLoader(makeStub())}
        />
      );
    }
    render(<Controlled />);
    const up = screen.getByLabelText('Transpose up one semitone');
    fireEvent.click(up);
    expect(onTransposeChange).toHaveBeenCalledWith(1);
  });

  test('PDF branch renders the export button using the shared default label', () => {
    render(
      <ChordProPreview
        source="src"
        defaultFormat="pdf"
        wasmLoader={makeLoader(makeStub())}
      />,
    );
    expect(
      screen.getByRole('button', { name: PDF_EXPORT_DEFAULT_LABEL }),
    ).toBeTruthy();
  });

  test('transposeMin / transposeMax bound the transpose buttons', () => {
    function Controlled() {
      const [t, setT] = useState(0);
      return (
        <ChordProPreview
          source="src"
          transpose={t}
          onTransposeChange={setT}
          transposeMin={-3}
          transposeMax={3}
          wasmLoader={makeLoader(makeStub())}
        />
      );
    }
    render(<Controlled />);
    const up = screen.getByLabelText('Transpose up one semitone') as HTMLButtonElement;
    // Click up six times — the last three should be no-ops because the
    // bound clamps at +3.
    for (let i = 0; i < 6; i++) fireEvent.click(up);
    const output = screen.getByRole('status');
    expect(output.textContent).toContain('+3');
    // The up button is disabled at the boundary (incrementDisabled
    // path in `<Transpose>`).
    expect(up.disabled).toBe(true);
  });

  test('format outside `formats` falls back to the first allowed format and warns in dev', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      render(
        // The host passes `format="pdf"` but restricts the allowed
        // list to `['html', 'text']` — the active value would not
        // match any `<option>`. Fall back to `'html'` (the first
        // entry of `formats`).
        <ChordProPreview
          source="src"
          format="pdf"
          formats={['html', 'text']}
          wasmLoader={makeLoader(makeStub())}
        />,
      );
      const select = screen.getByLabelText('Format') as HTMLSelectElement;
      // The select's `value` reflects the fallback, not the
      // mismatched prop — proves the fallback fired before the DOM
      // committed.
      expect(select.value).toBe('html');
      const messages = err.mock.calls.map((call) => String(call[0]));
      expect(
        messages.some(
          (m) => m.includes('not in the allowed') && m.includes('"pdf"'),
        ),
      ).toBe(true);
    } finally {
      err.mockRestore();
    }
  });

  test('incoming controlled transpose is clamped against [transposeMin, transposeMax]', () => {
    // Caller passes `transpose=15` but `transposeMax=5` — the
    // displayed readout and forwarded value must clamp to 5, not
    // render the out-of-range value.
    render(
      <ChordProPreview
        source="src"
        transpose={15}
        transposeMin={-5}
        transposeMax={5}
        wasmLoader={makeLoader(makeStub())}
      />,
    );
    const output = screen.getByRole('status');
    expect(output.textContent).toContain('+5');
  });

  test('transposeMin > transposeMax: dev warning fires and bounds are swapped', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      render(
        // Inverted bound pair — the component should swap them
        // internally so the control stays usable.
        <ChordProPreview
          source="src"
          defaultTranspose={0}
          transposeMin={5}
          transposeMax={-5}
          wasmLoader={makeLoader(makeStub())}
        />,
      );
      const messages = err.mock.calls.map((call) => String(call[0]));
      expect(
        messages.some((m) =>
          m.includes('transposeMin (5) > transposeMax (-5)'),
        ),
      ).toBe(true);
      // The up button stays enabled because the swapped bounds are
      // `[-5, 5]`, not `[5, -5]`. A regression that did not swap
      // would render the button disabled at 0 (since 0 >= 5 would
      // be true under the un-swapped check? actually 0 < 5 means it
      // would stay enabled — pivot to the down direction).
      // Assert at least one of the buttons is actionable by
      // clicking the down button and checking the readout drops.
      const down = screen.getByLabelText('Transpose down one semitone');
      fireEvent.click(down);
      const output = screen.getByRole('status');
      expect(output.textContent).toContain('-1');
    } finally {
      err.mockRestore();
    }
  });

  test('dev-warning fires when format flips between controlled and uncontrolled', () => {
    const stub = makeStub();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { rerender } = render(
        <ChordProPreview
          source="src"
          format="html"
          onFormatChange={vi.fn()}
          wasmLoader={makeLoader(stub)}
        />,
      );
      rerender(
        <ChordProPreview
          source="src"
          defaultFormat="text"
          wasmLoader={makeLoader(stub)}
        />,
      );
      const messages = err.mock.calls.map((call) => String(call[0]));
      expect(
        messages.some(
          (m) =>
            m.includes('<ChordProPreview> format') &&
            m.includes('controlled') &&
            m.includes('uncontrolled'),
        ),
      ).toBe(true);
    } finally {
      err.mockRestore();
    }
  });

  test('dev-warning fires when transpose flips between controlled and uncontrolled', () => {
    const stub = makeStub();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { rerender } = render(
        <ChordProPreview
          source="src"
          transpose={1}
          onTransposeChange={vi.fn()}
          wasmLoader={makeLoader(stub)}
        />,
      );
      rerender(
        <ChordProPreview
          source="src"
          defaultTranspose={0}
          wasmLoader={makeLoader(stub)}
        />,
      );
      const messages = err.mock.calls.map((call) => String(call[0]));
      expect(
        messages.some(
          (m) =>
            m.includes('<ChordProPreview> transpose') &&
            m.includes('controlled') &&
            m.includes('uncontrolled'),
        ),
      ).toBe(true);
    } finally {
      err.mockRestore();
    }
  });

  // -------------------------------------------------------------
  // toolbar prop (#2545)
  // -------------------------------------------------------------

  test('toolbar="transpose-only" (default) keeps the existing header', () => {
    render(
      <ChordProPreview
        source="src"
        wasmLoader={makeLoader(makeStub())}
      />,
    );
    expect(screen.getByRole('group', { name: 'Transpose' })).toBeTruthy();
    expect(screen.getByLabelText('Format')).toBeTruthy();
    expect(
      screen.queryByRole('toolbar', { name: 'Preview performance controls' }),
    ).toBeNull();
  });

  test('toolbar="performance" renders <PreviewToolbar> with Capo + Export', () => {
    render(
      <ChordProPreview
        source="{title: Demo}"
        toolbar="performance"
        onSourceChange={vi.fn()}
        formats={['html']}
        wasmLoader={makeLoader(makeStub())}
      />,
    );
    expect(
      screen.getByRole('toolbar', { name: 'Preview performance controls' }),
    ).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Transpose' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Capo' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Export' })).toBeTruthy();
    // Format select is hidden in performance mode with a single allowed format.
    expect(screen.queryByLabelText('Format')).toBeNull();
  });

  test('toolbar={false} suppresses the entire header', () => {
    render(
      <ChordProPreview
        source="src"
        toolbar={false}
        wasmLoader={makeLoader(makeStub())}
      />,
    );
    expect(screen.queryByLabelText('Format')).toBeNull();
    expect(screen.queryByRole('group', { name: 'Transpose' })).toBeNull();
    expect(
      screen.queryByRole('toolbar', { name: 'Preview performance controls' }),
    ).toBeNull();
  });

  test('toolbar={node} renders caller-supplied JSX in place of the header', () => {
    render(
      <ChordProPreview
        source="src"
        toolbar={<div data-testid="custom-toolbar">Custom</div>}
        wasmLoader={makeLoader(makeStub())}
      />,
    );
    expect(screen.getByTestId('custom-toolbar')).toBeTruthy();
    expect(screen.queryByLabelText('Format')).toBeNull();
  });

  test('performance toolbar drops Capo group when onSourceChange is omitted', () => {
    render(
      <ChordProPreview
        source="src"
        toolbar="performance"
        formats={['html']}
        wasmLoader={makeLoader(makeStub())}
      />,
    );
    expect(screen.queryByRole('group', { name: 'Capo' })).toBeNull();
    expect(screen.getByRole('group', { name: 'Transpose' })).toBeTruthy();
  });

  test('performance toolbar transpose +/− routes through onTransposeChange', () => {
    const onTransposeChange = vi.fn();
    render(
      <ChordProPreview
        source="src"
        toolbar="performance"
        transpose={0}
        onTransposeChange={onTransposeChange}
        onSourceChange={vi.fn()}
        formats={['html']}
        wasmLoader={makeLoader(makeStub())}
      />,
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Transpose up one semitone' }),
    );
    expect(onTransposeChange).toHaveBeenCalledWith(1);
  });
});
