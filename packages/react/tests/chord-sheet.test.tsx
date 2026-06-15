import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

import { ChordSheet } from '../src/index';
import type { ChordWasmLoader } from '../src/use-chord-render';
import type { ChordproWasmLoader } from '../src/use-chordpro-ast';

// Stub renderer surface — covers BOTH the AST → JSX path
// (parseChordproWithWarnings* used by `format="html"`
// post-#2475) and the legacy text path (render_text* still used
// by `format="text"`). See ADR-0017 for the surface split.
interface StubRenderer {
  default: ReturnType<typeof vi.fn>;
  parseChordproWithWarnings: ReturnType<typeof vi.fn>;
  parseChordproWithWarningsAndOptions: ReturnType<typeof vi.fn>;
  render_text: ReturnType<typeof vi.fn>;
  render_text_with_options: ReturnType<typeof vi.fn>;
}

// Minimal AST shape — one lyrics line carrying the source text
// inside a single chord-block. Captures enough structure for the
// JSX walker to emit `.song > .line > .chord-block > .lyrics`,
// which is what the assertions below key off.
function astFor(source: string, marker = ''): string {
  return JSON.stringify({
    metadata: {
      title: null,
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
    lines: [
      {
        kind: 'lyrics',
        value: {
          segments: [
            {
              chord: null,
              text: marker ? `${marker}:${source}` : source,
              spans: [],
            },
          ],
        },
      },
    ],
  });
}

function makeStub(): StubRenderer {
  return {
    default: vi.fn(async () => undefined),
    parseChordproWithWarnings: vi.fn((src: string) => ({
      ast: astFor(src),
      warnings: [],
      transposedKey: undefined,
    })),
    parseChordproWithWarningsAndOptions: vi.fn(
      (src: string, opts: { transpose?: number; config?: string }) => ({
        ast: astFor(src, JSON.stringify(opts)),
        warnings: [],
        transposedKey: undefined,
      }),
    ),
    render_text: vi.fn((src: string) => `TEXT:${src}`),
    render_text_with_options: vi.fn((src: string) => `TEXT+OPT:${src}`),
  };
}

function makeLoader(stub: StubRenderer): ChordWasmLoader {
  return vi.fn(async () => stub as unknown as Awaited<ReturnType<ChordWasmLoader>>);
}

function makeAstLoader(stub: StubRenderer): ChordproWasmLoader {
  return vi.fn(async () => stub as unknown as Awaited<ReturnType<ChordproWasmLoader>>);
}

describe('<ChordSheet>', () => {
  test('renders HTML output via parseChordpro when no options are set', async () => {
    const stub = makeStub();

    const { container } = render(
      <ChordSheet source="{title: Hi}" astWasmLoader={makeAstLoader(stub)} />,
    );

    await waitFor(() => {
      const lyrics = container.querySelector('.chordsketch-sheet__content .song .lyrics');
      expect(lyrics?.textContent).toBe('{title: Hi}');
    });
    expect(stub.parseChordproWithWarnings).toHaveBeenCalledWith('{title: Hi}');
    expect(stub.parseChordproWithWarningsAndOptions).not.toHaveBeenCalled();
  });

  test('forwards transpose via parseChordproWithOptions', async () => {
    const stub = makeStub();

    render(<ChordSheet source="{title: T}" transpose={2} astWasmLoader={makeAstLoader(stub)} />);

    await waitFor(() =>
      expect(stub.parseChordproWithWarningsAndOptions).toHaveBeenCalledWith('{title: T}', {
        transpose: 2,
        config: undefined,
      }),
    );
    expect(stub.parseChordproWithWarnings).not.toHaveBeenCalled();
  });

  test('forwards config via parseChordproWithOptions', async () => {
    const stub = makeStub();

    render(
      <ChordSheet source="{title: T}" config="ukulele" astWasmLoader={makeAstLoader(stub)} />,
    );

    await waitFor(() =>
      expect(stub.parseChordproWithWarningsAndOptions).toHaveBeenCalledWith('{title: T}', {
        transpose: undefined,
        config: 'ukulele',
      }),
    );
    // Symmetric with the transpose test above — a regression
    // where the options branch silently falls back to
    // `parseChordpro` would otherwise pass this test. #2173.
    expect(stub.parseChordproWithWarnings).not.toHaveBeenCalled();
  });

  test('HTML branch keeps stale output when a subsequent render errors', async () => {
    const stub = makeStub();
    const { rerender, container } = render(
      <ChordSheet source="one" astWasmLoader={makeAstLoader(stub)} />,
    );
    await waitFor(() => {
      const lyrics = container.querySelector('.chordsketch-sheet__content .song .lyrics');
      expect(lyrics?.textContent).toBe('one');
    });

    stub.parseChordproWithWarnings.mockImplementation(() => {
      throw new Error('bad');
    });
    rerender(<ChordSheet source="two" astWasmLoader={makeAstLoader(stub)} />);

    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('bad'));
    // Stale tree from "one" is still rendered alongside the error.
    const lyrics = container.querySelector('.chordsketch-sheet__content .song .lyrics');
    expect(lyrics?.textContent).toBe('one');
  });

  test('format="text" renders into a <pre>', async () => {
    const stub = makeStub();

    render(<ChordSheet source="source-text" format="text" wasmLoader={makeLoader(stub)} />);

    await waitFor(() => {
      expect(screen.getByText('TEXT:source-text').tagName).toBe('PRE');
    });
    expect(stub.render_text).toHaveBeenCalledWith('source-text');
  });

  test('initial state sets aria-busy="true" while WASM loads', () => {
    const stub = makeStub();
    const { container } = render(
      <ChordSheet source="x" astWasmLoader={makeAstLoader(stub)} />,
    );
    // Before the effect resolves, aria-busy should be true.
    const sheet = container.querySelector('.chordsketch-sheet');
    expect(sheet?.getAttribute('aria-busy')).toBe('true');
  });

  test('renders loadingFallback before the first successful render', async () => {
    // Hold the loader open so the loading state is observed.
    let releaseLoader!: (stub: StubRenderer) => void;
    const loader: ChordproWasmLoader = () =>
      new Promise<Awaited<ReturnType<ChordproWasmLoader>>>((resolve) => {
        releaseLoader = (s) => resolve(s as unknown as Awaited<ReturnType<ChordproWasmLoader>>);
      });

    render(
      <ChordSheet
        source="x"
        astWasmLoader={loader}
        loadingFallback={<span data-testid="loading">Loading…</span>}
      />,
    );

    expect(screen.getByTestId('loading').textContent).toBe('Loading…');

    const stub = makeStub();
    releaseLoader(stub);

    await waitFor(() => expect(stub.parseChordproWithWarnings).toHaveBeenCalled());
  });

  test('surfaces renderer errors via the default inline alert', async () => {
    const stub = makeStub();
    stub.parseChordproWithWarnings.mockImplementation(() => {
      throw new Error('parse boom');
    });

    render(<ChordSheet source="broken" astWasmLoader={makeAstLoader(stub)} />);

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
      <ChordSheet
        source="first"
        format="text"
        wasmLoader={makeLoader(stub)}
        errorFallback={null}
      />,
    );
    await waitFor(() => expect(stub.render_text).toHaveBeenCalledWith('first'));

    stub.render_text.mockImplementation(() => {
      throw new Error('ignored');
    });
    rerender(
      <ChordSheet
        source="second"
        format="text"
        wasmLoader={makeLoader(stub)}
        errorFallback={null}
      />,
    );

    await waitFor(() => expect(stub.render_text).toHaveBeenCalledWith('second'));
    expect(screen.queryByRole('alert')).toBeNull();
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
    expect(screen.getByText('TEXT:one')).toBeTruthy();
  });

  test('HTML branch renders custom JSX errorFallback alongside the output', async () => {
    // Regression guard: under `format="html"` the post-2475 path
    // renders errorFallback in a sibling element so arbitrary JSX
    // works under both `format` values. The AST-walker path makes
    // this guarantee structural — no string-injection escape
    // hatch is involved.
    const stub = makeStub();
    stub.parseChordproWithWarnings.mockImplementation(() => {
      throw new Error('html-boom');
    });

    const { container } = render(
      <ChordSheet
        source="bad"
        format="html"
        errorFallback={(err) => (
          <section data-testid="rich-err">
            <strong>Problem:</strong> {err.message}
          </section>
        )}
        astWasmLoader={makeAstLoader(stub)}
      />,
    );

    await waitFor(() => {
      const node = screen.getByTestId('rich-err');
      expect(node.tagName).toBe('SECTION');
      expect(node.textContent).toBe('Problem: html-boom');
    });
    // No content wrapper because `ast` stayed null on every parse.
    expect(container.querySelector('.chordsketch-sheet__content')).toBeNull();
  });

  test('HTML branch with errorFallback=null hides the alert before any successful render', async () => {
    // Pre-#2475 the html branch rendered the error fallback
    // through `dangerouslySetInnerHTML`; the AST → JSX path
    // makes the fallback a sibling React element. Verify
    // `errorFallback={null}` cleanly hides errors on the
    // html branch even when no prior successful render
    // exists to fall back to.
    const stub = makeStub();
    stub.parseChordproWithWarnings.mockImplementation(() => {
      throw new Error('hidden');
    });
    const { container } = render(
      <ChordSheet
        source="bad"
        format="html"
        errorFallback={null}
        astWasmLoader={makeAstLoader(stub)}
      />,
    );
    await waitFor(() => expect(stub.parseChordproWithWarnings).toHaveBeenCalled());
    expect(container.querySelector('[role="alert"]')).toBeNull();
    // No prior successful render means no content wrapper either.
    expect(container.querySelector('.chordsketch-sheet__content')).toBeNull();
  });

  test('WASM module is loaded once across rerenders with different sources', async () => {
    const stub = makeStub();
    const loader = makeAstLoader(stub);
    const { rerender } = render(<ChordSheet source="a" astWasmLoader={loader} />);
    await waitFor(() => expect(stub.parseChordproWithWarnings).toHaveBeenCalledWith('a'));
    rerender(<ChordSheet source="b" astWasmLoader={loader} />);
    await waitFor(() => expect(stub.parseChordproWithWarnings).toHaveBeenCalledWith('b'));

    expect(loader).toHaveBeenCalledTimes(1);
    expect(stub.default).toHaveBeenCalledTimes(1);
  });

  // ---------------------------------------------------------------------
  // chordDiagrams orientation pass-through (#2572). The walker option
  // path was the only way to opt into horizontal mode pre-fix; the new
  // `chordDiagramsOrientation` prop exposes the same knob to host
  // hierarchies that compose via <ChordSheet> / <RendererPreview>
  // instead of calling the walker directly. The AST stub above carries
  // no chord block, so the emitted diagrams grid is empty; the prop's
  // contract is asserted by inspecting the walker option construction
  // directly.
  // ---------------------------------------------------------------------

  test('forwards chordDiagramsOrientation to the walker option', async () => {
    // Build a richer AST so the walker actually emits a diagrams grid
    // and we can read the <ChordDiagram> orientation props back from
    // the DOM. The stub returns this AST instead of `astFor(src)`.
    const songAst = JSON.stringify({
      metadata: {
        title: null,
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
      lines: [
        {
          kind: 'lyrics',
          value: {
            segments: [
              {
                chord: { name: 'Am', detail: null, display: null },
                text: 'hi',
                spans: [],
              },
            ],
          },
        },
      ],
    });
    const stub: StubRenderer = {
      ...makeStub(),
      parseChordproWithWarnings: vi.fn(() => ({
        ast: songAst,
        warnings: [],
        transposedKey: undefined,
      })),
    };

    const { container } = render(
      <ChordSheet
        source="[Am]hi"
        astWasmLoader={makeAstLoader(stub)}
        chordDiagramsInstrument="guitar"
        chordDiagramsOrientation="horizontal"
      />,
    );

    // Wait until the walker has emitted at least one diagram figure.
    await waitFor(() => {
      const cells = container.querySelectorAll('.chord-diagrams-grid .chord-diagram-container');
      expect(cells.length).toBeGreaterThan(0);
    });

    // The <ChordDiagram> wrapper carries aria-label="${chord} chord
    // diagram (${instrument})"; assert the figure mounted (the SVG
    // itself is provided by an async wasm path we don't load in the
    // test). What we actually want to lock in is that the orientation
    // prop reached <ChordDiagram>. The wrapper exposes the active
    // orientation as `data-orientation` so the assertion does not have
    // to inspect the (asynchronously-loaded) SVG payload — a
    // regression that drops the prop on the way from <ChordSheet> to
    // the walker to <ChordDiagram> surfaces as a missing attribute.
    const fig = container.querySelector('.chord-diagrams-grid .chord-diagram-container');
    expect(fig).not.toBeNull();
    const diagramWrappers = container.querySelectorAll(
      '.chord-diagrams-grid .chordsketch-diagram',
    );
    expect(diagramWrappers.length).toBeGreaterThan(0);
    diagramWrappers.forEach((wrapper) => {
      expect(wrapper.getAttribute('data-orientation')).toBe('horizontal');
    });
  });

  // ---------------------------------------------------------------------
  // Click-to-focus + nudge (#2614). End-to-end through <ChordSheet>:
  // the selection state + outside-click clearing live in the AST branch
  // component, which the renderChordproAst-level tests can't exercise.
  // ---------------------------------------------------------------------

  // A stub returning a single chord-bearing line `[Am]hi`.
  function chordStub(): StubRenderer {
    const songAst = JSON.stringify({
      metadata: {
        title: null,
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
      lines: [
        {
          kind: 'lyrics',
          value: {
            segments: [
              { chord: { name: 'Am', detail: null, display: null }, text: 'hi', spans: [] },
            ],
          },
        },
      ],
    });
    return {
      ...makeStub(),
      parseChordproWithWarnings: vi.fn(() => ({
        ast: songAst,
        warnings: [],
        transposedKey: undefined,
      })),
    };
  }

  test('onChordReposition enables click-to-focus nudge controls', async () => {
    const onChordReposition = vi.fn();
    const { container } = render(
      <ChordSheet
        source="[Am]hi"
        astWasmLoader={makeAstLoader(chordStub())}
        onChordReposition={onChordReposition}
      />,
    );
    await waitFor(() => {
      expect(container.querySelector(".chord[role='button']")).not.toBeNull();
    });
    // No controls until the chord is clicked.
    expect(container.querySelector('.chord-nudge')).toBeNull();
    fireEvent.click(container.querySelector(".chord[role='button']") as HTMLElement);
    // Controls appear; the right button moves Am one char into "hi".
    expect(container.querySelector('.chord-nudge')).not.toBeNull();
    fireEvent.click(container.querySelector('.chord-nudge__btn--right') as HTMLElement);
    expect(onChordReposition).toHaveBeenCalledTimes(1);
    expect(onChordReposition.mock.calls[0][0]).toMatchObject({
      fromLine: 1,
      toLine: 1,
      toLyricsOffset: 1,
      chord: 'Am',
      copy: false,
    });
  });

  test('pressing down outside the sheet clears the chord selection', async () => {
    const { container } = render(
      <ChordSheet
        source="[Am]hi"
        astWasmLoader={makeAstLoader(chordStub())}
        onChordReposition={vi.fn()}
      />,
    );
    await waitFor(() => {
      expect(container.querySelector(".chord[role='button']")).not.toBeNull();
    });
    fireEvent.click(container.querySelector(".chord[role='button']") as HTMLElement);
    expect(container.querySelector('.chord-nudge')).not.toBeNull();
    // Pointer down on the document body (outside any chord) clears it.
    fireEvent.pointerDown(document.body);
    expect(container.querySelector('.chord-nudge')).toBeNull();
  });

  test('chords stay inert when onChordReposition is not provided', async () => {
    const { container } = render(
      <ChordSheet source="[Am]hi" astWasmLoader={makeAstLoader(chordStub())} />,
    );
    await waitFor(() => {
      expect(container.querySelector('.chord')).not.toBeNull();
    });
    const chord = container.querySelector('.chord') as HTMLElement;
    expect(chord.getAttribute('role')).toBeNull();
    expect(chord.getAttribute('draggable')).toBeNull();
  });

  test('omits chordDiagrams option when chordDiagramsInstrument is unset', async () => {
    // Pinning the existing behaviour: passing orientation alone without
    // chordDiagramsInstrument must NOT cause the walker to emit a grid.
    const stub = makeStub();
    const { container } = render(
      <ChordSheet
        source="[Am]hi"
        astWasmLoader={makeAstLoader(stub)}
        chordDiagramsOrientation="horizontal"
      />,
    );
    await waitFor(() => {
      // The walker rendered SOMETHING (or at least mounted) — assert
      // grid stays absent.
      expect(stub.parseChordproWithWarnings).toHaveBeenCalled();
    });
    expect(container.querySelector('.chord-diagrams-grid')).toBeNull();
  });
});
