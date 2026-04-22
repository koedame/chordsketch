import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

import { ChordSheet } from '../src/index';
import type { ChordWasmLoader } from '../src/use-chord-render';

interface StubRenderer {
  default: ReturnType<typeof vi.fn>;
  render_html: ReturnType<typeof vi.fn>;
  render_text: ReturnType<typeof vi.fn>;
  render_html_with_options: ReturnType<typeof vi.fn>;
  render_text_with_options: ReturnType<typeof vi.fn>;
}

function makeStub(): StubRenderer {
  return {
    default: vi.fn(async () => undefined),
    render_html: vi.fn((src: string) => `<article>${src}</article>`),
    render_text: vi.fn((src: string) => `TEXT:${src}`),
    render_html_with_options: vi.fn(
      (src: string, opts) => `<article data-opts=${JSON.stringify(opts)}>${src}</article>`,
    ),
    render_text_with_options: vi.fn((src: string) => `TEXT+OPT:${src}`),
  };
}

function makeLoader(stub: StubRenderer): ChordWasmLoader {
  return vi.fn(async () => stub as unknown as Awaited<ReturnType<ChordWasmLoader>>);
}

describe('<ChordSheet>', () => {
  test('renders HTML output via render_html when no options are set', async () => {
    const stub = makeStub();

    const { container } = render(
      <ChordSheet source="{title: Hi}" wasmLoader={makeLoader(stub)} />,
    );

    await waitFor(() => {
      const sheet = container.querySelector('.chordsketch-sheet');
      expect(sheet?.innerHTML).toContain('<article>{title: Hi}</article>');
    });
    expect(stub.render_html).toHaveBeenCalledWith('{title: Hi}');
    expect(stub.render_html_with_options).not.toHaveBeenCalled();
  });

  test('forwards transpose via render_html_with_options', async () => {
    const stub = makeStub();

    render(
      <ChordSheet
        source="{title: T}"
        transpose={2}
        wasmLoader={makeLoader(stub)}
      />,
    );

    await waitFor(() =>
      expect(stub.render_html_with_options).toHaveBeenCalledWith('{title: T}', {
        transpose: 2,
        config: undefined,
      }),
    );
    expect(stub.render_html).not.toHaveBeenCalled();
  });

  test('format="text" renders into a <pre>', async () => {
    const stub = makeStub();

    render(
      <ChordSheet
        source="source-text"
        format="text"
        wasmLoader={makeLoader(stub)}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('TEXT:source-text').tagName).toBe('PRE');
    });
    expect(stub.render_text).toHaveBeenCalledWith('source-text');
  });

  test('initial state sets aria-busy="true" while WASM loads', () => {
    const stub = makeStub();
    const { container } = render(
      <ChordSheet source="x" wasmLoader={makeLoader(stub)} />,
    );
    // Before the effect resolves, aria-busy should be true.
    const sheet = container.querySelector('.chordsketch-sheet');
    expect(sheet?.getAttribute('aria-busy')).toBe('true');
  });

  test('renders loadingFallback before the first successful render', async () => {
    // Hold the loader open so the loading state is observed.
    let releaseLoader!: (stub: StubRenderer) => void;
    const loader: ChordWasmLoader = () =>
      new Promise<Awaited<ReturnType<ChordWasmLoader>>>((resolve) => {
        releaseLoader = (s) => resolve(s as unknown as Awaited<ReturnType<ChordWasmLoader>>);
      });

    render(
      <ChordSheet
        source="x"
        wasmLoader={loader}
        loadingFallback={<span data-testid="loading">Loading…</span>}
      />,
    );

    expect(screen.getByTestId('loading').textContent).toBe('Loading…');

    const stub = makeStub();
    releaseLoader(stub);

    await waitFor(() => expect(stub.render_html).toHaveBeenCalled());
  });

  test('surfaces renderer errors via the default inline alert', async () => {
    const stub = makeStub();
    stub.render_html.mockImplementation(() => {
      throw new Error('parse boom');
    });

    render(
      <ChordSheet source="broken" wasmLoader={makeLoader(stub)} />,
    );

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toBe('parse boom');
    });
  });

  test('custom errorFallback overrides the default alert', async () => {
    const stub = makeStub();
    stub.render_text.mockImplementation(() => {
      throw new Error('custom-error');
    });

    render(
      <ChordSheet
        source="broken"
        format="text"
        errorFallback={(err) => <p data-testid="err">Oops: {err.message}</p>}
        wasmLoader={makeLoader(stub)}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('err').textContent).toBe('Oops: custom-error');
    });
  });

  test('errorFallback=null hides errors entirely', async () => {
    const stub = makeStub();
    // Render once so stale output is preserved, then break the next render.
    const { rerender } = render(
      <ChordSheet source="first" format="text" wasmLoader={makeLoader(stub)} errorFallback={null} />,
    );
    await waitFor(() => expect(stub.render_text).toHaveBeenCalledWith('first'));

    stub.render_text.mockImplementation(() => {
      throw new Error('ignored');
    });
    rerender(
      <ChordSheet source="second" format="text" wasmLoader={makeLoader(stub)} errorFallback={null} />,
    );

    // No alert element should appear.
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole('alert')).toBeNull();
    // Stale text output stays visible.
    expect(screen.getByText('TEXT:first')).toBeTruthy();
  });

  test('keeps stale output when a subsequent render errors (text branch)', async () => {
    const stub = makeStub();
    const { rerender } = render(
      <ChordSheet source="one" format="text" wasmLoader={makeLoader(stub)} />,
    );
    await waitFor(() => expect(screen.getByText('TEXT:one')).toBeTruthy());

    stub.render_text.mockImplementation(() => {
      throw new Error('bad');
    });
    rerender(<ChordSheet source="two" format="text" wasmLoader={makeLoader(stub)} />);

    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('bad'));
    // Stale output still rendered alongside the error.
    expect(screen.getByText('TEXT:one')).toBeTruthy();
  });

  test('WASM module is loaded once across rerenders with different sources', async () => {
    const stub = makeStub();
    const loader = makeLoader(stub);
    const { rerender } = render(<ChordSheet source="a" wasmLoader={loader} />);
    await waitFor(() => expect(stub.render_html).toHaveBeenCalledWith('a'));
    rerender(<ChordSheet source="b" wasmLoader={loader} />);
    await waitFor(() => expect(stub.render_html).toHaveBeenCalledWith('b'));

    expect(loader).toHaveBeenCalledTimes(1);
    expect(stub.default).toHaveBeenCalledTimes(1);
  });
});
