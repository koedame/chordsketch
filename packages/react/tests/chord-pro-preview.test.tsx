import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, test, vi } from 'vitest';

import { ChordProPreview } from '../src/index';
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

  test('PDF branch renders the download button', () => {
    render(
      <ChordProPreview
        source="src"
        defaultFormat="pdf"
        wasmLoader={makeLoader(makeStub())}
      />,
    );
    expect(screen.getByRole('button', { name: 'Download PDF' })).toBeTruthy();
  });
});
