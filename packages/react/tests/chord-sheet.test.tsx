import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

import { readStylesheetSource } from './stylesheet-source';

import { ChordSheet } from '../src/index';
import type { ChordWasmLoader } from '../src/use-chord-render';
import type { ChordproWasmLoader } from '../src/use-chordpro-ast';
import { resetSharedAudioContextForTests } from '../src/audio-context';
import type { ChordAudioWasmLoader } from '../src/use-chord-audio';
import { FakeAudioContext } from './fake-audio-context';

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

// A stub returning a single chord-bearing line whose chord has the
// given raw name (e.g. `"Bb"`), so a test can assert how the inspector
// renders that name.
function chordNamedStub(name: string): StubRenderer {
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
          segments: [{ chord: { name, detail: null, display: null }, text: 'hi', spans: [] }],
        },
      },
    ],
  });
  const result = { ast: songAst, warnings: [], transposedKey: undefined };
  return {
    ...makeStub(),
    parseChordproWithWarnings: vi.fn(() => result),
    parseChordproWithWarningsAndOptions: vi.fn(() => result),
  };
}

// A stub returning a `{time}` directive line (rendered as a
// `.meta-inline` chip) followed by a chord-bearing lyrics line, so a
// test can assert that pressing an inline chip does not clear the
// chord selection.
function chordWithChipStub(): StubRenderer {
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
        kind: 'directive',
        value: { name: 'time', value: '4/4', kind: { tag: 'time' }, selector: null },
      },
      {
        kind: 'lyrics',
        value: {
          segments: [{ chord: { name: 'Am', detail: null, display: null }, text: 'hi', spans: [] }],
        },
      },
    ],
  });
  const result = { ast: songAst, warnings: [], transposedKey: undefined };
  return {
    ...makeStub(),
    parseChordproWithWarnings: vi.fn(() => result),
    parseChordproWithWarningsAndOptions: vi.fn(() => result),
  };
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

  // A stub returning a single chord-bearing line `[Am]hi` — the
  // `chordNamedStub('Am')` case (both parse entries return the same
  // chord-bearing AST so the stub works whether or not transpose /
  // config options are passed).
  const chordStub = (): StubRenderer => chordNamedStub('Am');

  test('onChordReposition enables click-to-select + keyboard nudge', async () => {
    // Without onChordEdit, clicking selects (solid badge) and keyboard
    // arrows nudge, but the editor inspector is not shown (it is the
    // chord EDITOR, gated on onChordEdit).
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
    expect(container.querySelector('.chord--selected')).toBeNull();
    expect(container.querySelector('.chordsketch-sheet__cins')).toBeNull();
    const chord = container.querySelector(".chord[role='button']") as HTMLElement;
    fireEvent.click(chord);
    // Selected badge, but no inspector (no onChordEdit wired).
    expect(container.querySelector('.chord--selected')).not.toBeNull();
    expect(container.querySelector('.chordsketch-sheet__cins')).toBeNull();
    // Keyboard ArrowRight moves Am one char into "hi".
    fireEvent.keyDown(
      container.querySelector('.chord--selected') as HTMLElement,
      { key: 'ArrowRight' },
    );
    expect(onChordReposition).toHaveBeenCalledTimes(1);
    expect(onChordReposition.mock.calls[0][0]).toMatchObject({
      fromLine: 1,
      toLine: 1,
      toLyricsOffset: 1,
      chord: 'Am',
      copy: false,
    });
  });

  test('onChordEdit opens the inspector; a type chip emits a ChordEditEvent', async () => {
    const onChordReposition = vi.fn();
    const onChordEdit = vi.fn();
    const { container } = render(
      <ChordSheet
        source="[Am]hi"
        astWasmLoader={makeAstLoader(chordStub())}
        onChordReposition={onChordReposition}
        onChordEdit={onChordEdit}
      />,
    );
    await waitFor(() => {
      expect(container.querySelector(".chord[role='button']")).not.toBeNull();
    });
    fireEvent.click(container.querySelector(".chord[role='button']") as HTMLElement);
    // Inspector appears with the selected chord in the header.
    expect(container.querySelector('.chordsketch-sheet__cins')).not.toBeNull();
    expect(container.querySelector('.chordsketch-sheet__cins-name')?.textContent).toBe('Am');
    // A type chip emits a ChordEditEvent rewriting the chord at its
    // source position. Am is detail-less in the stub, so the editor
    // falls back to raw-name parts (root A, suffix "m"); picking "7"
    // writes "A7" over the original [Am].
    const chips = container.querySelectorAll('.chordsketch-sheet__cins-chip');
    const seven = Array.from(chips).find((c) => c.textContent === '7') as HTMLButtonElement;
    expect(seven).toBeDefined();
    fireEvent.click(seven);
    expect(onChordEdit).toHaveBeenCalledTimes(1);
    expect(onChordEdit.mock.calls[0][0]).toEqual({
      line: 1,
      fromColumn: 0,
      fromLength: 4,
      chord: 'A7',
      expected: 'Am',
    });
  });

  test('the inspector ▶ button moves the chord via the reposition pipeline', async () => {
    const onChordReposition = vi.fn();
    const { container } = render(
      <ChordSheet
        source="[Am]hi"
        astWasmLoader={makeAstLoader(chordStub())}
        onChordReposition={onChordReposition}
        onChordEdit={vi.fn()}
      />,
    );
    await waitFor(() => {
      expect(container.querySelector(".chord[role='button']")).not.toBeNull();
    });
    fireEvent.click(container.querySelector(".chord[role='button']") as HTMLElement);
    const right = container.querySelector(
      '.chordsketch-sheet__cins-move button[aria-label="Move chord right"]',
    ) as HTMLButtonElement;
    fireEvent.click(right);
    expect(onChordReposition).toHaveBeenCalledTimes(1);
    expect(onChordReposition.mock.calls[0][0]).toMatchObject({
      fromLine: 1,
      toLine: 1,
      toLyricsOffset: 1,
      chord: 'Am',
      copy: false,
    });
  });

  test('selecting a chord scrolls it into view; typing in the inspector does not re-scroll (#2631)', async () => {
    // jsdom does not implement scrollIntoView; define it as a spy so the
    // effect's `typeof … === 'function'` guard passes and we can count
    // calls. Restore afterwards so the global stays clean for other tests.
    const original = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView');
    const spy = vi.fn();
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      writable: true,
      value: spy,
    });
    try {
      const { container } = render(
        <ChordSheet
          source="[Am]hi"
          astWasmLoader={makeAstLoader(chordStub())}
          onChordReposition={vi.fn()}
          onChordEdit={vi.fn()}
        />,
      );
      await waitFor(() => {
        expect(container.querySelector(".chord[role='button']")).not.toBeNull();
      });
      // No selection yet → the effect early-returns, nothing scrolled.
      expect(spy).not.toHaveBeenCalled();

      fireEvent.click(container.querySelector(".chord[role='button']") as HTMLElement);
      // Selection set → the selected badge is scrolled into view (rAF).
      await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
      const selected = container.querySelector('.chord--selected');
      expect(spy.mock.instances[0]).toBe(selected);
      expect(spy.mock.calls[0][0]).toMatchObject({ block: 'center' });

      // Typing in the free-form suffix field is an in-place edit: the
      // selection coordinates (line, offset, ordinal) are unchanged, so
      // the scroll effect (keyed on chordSelection) must NOT re-fire.
      const input = container.querySelector(
        '.chordsketch-sheet__cins-row2 .chordsketch-sheet__cins-input',
      ) as HTMLInputElement;
      fireEvent.change(input, { target: { value: 'm7' } });
      await Promise.resolve();
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      if (original) Object.defineProperty(Element.prototype, 'scrollIntoView', original);
      else delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });

  test('the inspector ◀ button is disabled for a chord at the line start', async () => {
    const { container } = render(
      <ChordSheet
        source="[Am]hi"
        astWasmLoader={makeAstLoader(chordStub())}
        onChordReposition={vi.fn()}
        onChordEdit={vi.fn()}
      />,
    );
    await waitFor(() => {
      expect(container.querySelector(".chord[role='button']")).not.toBeNull();
    });
    fireEvent.click(container.querySelector(".chord[role='button']") as HTMLElement);
    const left = container.querySelector(
      '.chordsketch-sheet__cins-move button[aria-label="Move chord left"]',
    ) as HTMLButtonElement;
    const right = container.querySelector(
      '.chordsketch-sheet__cins-move button[aria-label="Move chord right"]',
    ) as HTMLButtonElement;
    expect(left.disabled).toBe(true);
    expect(right.disabled).toBe(false);
  });

  test('edits use the RAW source name, not a transposed detail', async () => {
    // Guards transpose-safety: under a non-zero transpose the AST chord
    // exposes the transposed pitch via `detail`, but `chord.name` stays
    // the raw source token. Editing must rewrite the raw chord. Here the
    // raw name is "Am" while detail claims root B (as if transposed +2);
    // picking the "7" chip must write "A7" (raw root A), never "B7".
    const transposedDetailAst = JSON.stringify({
      metadata: JSON.parse(astFor('x')).metadata,
      lines: [
        {
          kind: 'lyrics',
          value: {
            segments: [
              {
                chord: {
                  name: 'Am',
                  display: 'Bm',
                  detail: {
                    root: 'B',
                    rootAccidental: null,
                    quality: 'minor',
                    extension: null,
                    bassNote: null,
                  },
                },
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
        ast: transposedDetailAst,
        warnings: [],
        transposedKey: undefined,
      })),
    };
    const onChordEdit = vi.fn();
    const { container } = render(
      <ChordSheet
        source="[Am]hi"
        astWasmLoader={makeAstLoader(stub)}
        onChordReposition={vi.fn()}
        onChordEdit={onChordEdit}
      />,
    );
    await waitFor(() => {
      expect(container.querySelector(".chord[role='button']")).not.toBeNull();
    });
    fireEvent.click(container.querySelector(".chord[role='button']") as HTMLElement);
    const chips = container.querySelectorAll('.chordsketch-sheet__cins-chip');
    const seven = Array.from(chips).find((c) => c.textContent === '7') as HTMLButtonElement;
    fireEvent.click(seven);
    expect(onChordEdit.mock.calls[0][0].chord).toBe('A7');
  });

  test('the inspector "Remove chord" button fires onChordDelete and deselects', async () => {
    const onChordDelete = vi.fn();
    const { container } = render(
      <ChordSheet
        source="[Am]hi"
        astWasmLoader={makeAstLoader(chordStub())}
        onChordReposition={vi.fn()}
        onChordEdit={vi.fn()}
        onChordDelete={onChordDelete}
      />,
    );
    await waitFor(() => {
      expect(container.querySelector(".chord[role='button']")).not.toBeNull();
    });
    fireEvent.click(container.querySelector(".chord[role='button']") as HTMLElement);
    const remove = container.querySelector(
      '.chordsketch-sheet__cins-remove',
    ) as HTMLButtonElement;
    fireEvent.click(remove);
    expect(onChordDelete).toHaveBeenCalledWith({
      line: 1,
      fromColumn: 0,
      fromLength: 4,
      expected: 'Am',
    });
    expect(container.querySelector('.chordsketch-sheet__cins')).toBeNull();
  });

  test('the inspector "Remove" button is hidden when onChordDelete is not wired', async () => {
    const { container } = render(
      <ChordSheet
        source="[Am]hi"
        astWasmLoader={makeAstLoader(chordStub())}
        onChordReposition={vi.fn()}
        onChordEdit={vi.fn()}
      />,
    );
    await waitFor(() => {
      expect(container.querySelector(".chord[role='button']")).not.toBeNull();
    });
    fireEvent.click(container.querySelector(".chord[role='button']") as HTMLElement);
    expect(container.querySelector('.chordsketch-sheet__cins')).not.toBeNull();
    expect(container.querySelector('.chordsketch-sheet__cins-remove')).toBeNull();
  });

  test('pressing down outside the sheet clears the chord selection', async () => {
    const { container } = render(
      <ChordSheet
        source="[Am]hi"
        astWasmLoader={makeAstLoader(chordStub())}
        onChordReposition={vi.fn()}
        onChordEdit={vi.fn()}
      />,
    );
    await waitFor(() => {
      expect(container.querySelector(".chord[role='button']")).not.toBeNull();
    });
    fireEvent.click(container.querySelector(".chord[role='button']") as HTMLElement);
    expect(container.querySelector('.chordsketch-sheet__cins')).not.toBeNull();
    // Pointer down on the document body (outside any chord) clears it.
    fireEvent.pointerDown(document.body);
    expect(container.querySelector('.chordsketch-sheet__cins')).toBeNull();
  });

  test('pressing inside the inspector keeps the selection', async () => {
    // The outside-click listener must exclude the inspector itself, or
    // interacting with its controls would deselect mid-edit.
    const { container } = render(
      <ChordSheet
        source="[Am]hi"
        astWasmLoader={makeAstLoader(chordStub())}
        onChordReposition={vi.fn()}
        onChordEdit={vi.fn()}
      />,
    );
    await waitFor(() => {
      expect(container.querySelector(".chord[role='button']")).not.toBeNull();
    });
    fireEvent.click(container.querySelector(".chord[role='button']") as HTMLElement);
    const inspector = container.querySelector('.chordsketch-sheet__cins') as HTMLElement;
    expect(inspector).not.toBeNull();
    fireEvent.pointerDown(inspector);
    expect(container.querySelector('.chordsketch-sheet__cins')).not.toBeNull();
  });

  test('pressing on the chord glyph (text node) does not clear the selection', async () => {
    // A pointer event can target the chord name's Text node, which has
    // no `closest`. The outside-click listener must resolve to the
    // nearest Element before testing membership, otherwise pressing the
    // glyph would clear the selection it is trying to act on.
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
    expect(container.querySelector('.chord--selected')).not.toBeNull();
    // The chord name renders as a direct Text-node child of `.chord`.
    const chordSpan = container.querySelector('.chord--selected') as HTMLElement;
    const textNode = Array.from(chordSpan.childNodes).find(
      (n) => n.nodeType === Node.TEXT_NODE,
    );
    expect(textNode).toBeDefined();
    fireEvent.pointerDown(textNode as Node);
    // Selection survives — the press resolved to the `.chord` element.
    expect(container.querySelector('.chord--selected')).not.toBeNull();
  });

  test('controlled mode: pressing a non-chord part of the preview reports null', async () => {
    // #2654: in controlled mode the shell owns the selection (caret-
    // driven). A press on a non-chord part of the preview must report
    // `null` upward so the shell can move the caret off the chord; a
    // press on the chord, or anywhere outside the preview, must not.
    const onChordSelectionChange = vi.fn();
    const { container } = render(
      <ChordSheet
        source="[Am]hi"
        astWasmLoader={makeAstLoader(chordStub())}
        onChordReposition={vi.fn()}
        chordSelection={{ line: 1, offset: 0, ordinal: 0, nonce: 1 }}
        onChordSelectionChange={onChordSelectionChange}
      />,
    );
    await waitFor(() => {
      expect(container.querySelector('.lyrics')).not.toBeNull();
    });
    // Non-chord part of the preview (the lyrics span) → deselect.
    fireEvent.pointerDown(container.querySelector('.lyrics') as HTMLElement);
    expect(onChordSelectionChange).toHaveBeenLastCalledWith(null);

    // The chord itself → kept (its own click handler re-selects it).
    onChordSelectionChange.mockClear();
    fireEvent.pointerDown(container.querySelector('.chord') as HTMLElement);
    expect(onChordSelectionChange).not.toHaveBeenCalled();

    // Outside the preview entirely (the editor / footer live there) →
    // not this listener's business; the editor caret owns it.
    onChordSelectionChange.mockClear();
    fireEvent.pointerDown(document.body);
    expect(onChordSelectionChange).not.toHaveBeenCalled();
  });

  test('controlled mode: pressing an inline directive chip keeps the selection', async () => {
    // #2654 follow-up: the {tempo} metronome chip (and other
    // `.meta-inline` chips) are interactive controls inside the preview.
    // Pressing one performs its own action; it must NOT report a
    // deselect upward as a side effect.
    const onChordSelectionChange = vi.fn();
    const { container } = render(
      <ChordSheet
        source="{time: 4/4}\n[Am]hi"
        astWasmLoader={makeAstLoader(chordWithChipStub())}
        onChordReposition={vi.fn()}
        chordSelection={{ line: 2, offset: 0, ordinal: 0, nonce: 1 }}
        onChordSelectionChange={onChordSelectionChange}
      />,
    );
    await waitFor(() => {
      expect(container.querySelector('.meta-inline--time')).not.toBeNull();
    });
    fireEvent.pointerDown(container.querySelector('.meta-inline--time') as HTMLElement);
    expect(onChordSelectionChange).not.toHaveBeenCalled();
    // Sanity: a bare-lyrics press still clears, proving the chip path is
    // the exception, not a blanket "never clear".
    fireEvent.pointerDown(container.querySelector('.lyrics') as HTMLElement);
    expect(onChordSelectionChange).toHaveBeenLastCalledWith(null);
  });

  test('uncontrolled mode: pressing an inline directive chip keeps the selection', async () => {
    // Sister-site parity with the controlled-mode chip test: the
    // uncontrolled in-pane listener must keep the selection on a chip
    // press too (the keep-list is shared via PREVIEW_SELECTION_KEEP).
    const { container } = render(
      <ChordSheet
        source="{time: 4/4}\n[Am]hi"
        astWasmLoader={makeAstLoader(chordWithChipStub())}
        onChordReposition={vi.fn()}
        onChordEdit={vi.fn()}
      />,
    );
    await waitFor(() => {
      expect(container.querySelector(".chord[role='button']")).not.toBeNull();
    });
    fireEvent.click(container.querySelector(".chord[role='button']") as HTMLElement);
    expect(container.querySelector('.chordsketch-sheet__cins')).not.toBeNull();
    // Press the inline chip — the selection / inspector must survive.
    fireEvent.pointerDown(container.querySelector('.meta-inline--time') as HTMLElement);
    expect(container.querySelector('.chordsketch-sheet__cins')).not.toBeNull();
  });

  test('controlled mode: no clear is reported when nothing is selected', async () => {
    // The listener is scoped to an active selection; with a null
    // controlled selection a non-chord press must stay silent.
    const onChordSelectionChange = vi.fn();
    const { container } = render(
      <ChordSheet
        source="[Am]hi"
        astWasmLoader={makeAstLoader(chordStub())}
        onChordReposition={vi.fn()}
        chordSelection={null}
        onChordSelectionChange={onChordSelectionChange}
      />,
    );
    await waitFor(() => {
      expect(container.querySelector('.lyrics')).not.toBeNull();
    });
    fireEvent.pointerDown(container.querySelector('.lyrics') as HTMLElement);
    expect(onChordSelectionChange).not.toHaveBeenCalled();
  });

  test('a non-zero transpose disables chord selection + the inspector', async () => {
    // The transposed AST carries transposed chord names, so source-
    // coordinate editing is unsafe and must be gated off.
    const { container } = render(
      <ChordSheet
        source="[Am]hi"
        transpose={2}
        astWasmLoader={makeAstLoader(chordStub())}
        onChordReposition={vi.fn()}
        onChordEdit={vi.fn()}
        onChordDelete={vi.fn()}
      />,
    );
    await waitFor(() => {
      expect(container.querySelector('.chord')).not.toBeNull();
    });
    // Chords are not selectable; no badge / inspector / role=button.
    expect(container.querySelector(".chord[role='button']")).toBeNull();
    fireEvent.click(container.querySelector('.chord') as HTMLElement);
    expect(container.querySelector('.chordsketch-sheet__cins')).toBeNull();
    expect(container.querySelector('.chord--selected')).toBeNull();
  });

  test('a {capo} in the source disables editing (capo folds into transpose)', async () => {
    const { container } = render(
      <ChordSheet
        source={'{capo: 2}\n[Am]hi'}
        astWasmLoader={makeAstLoader(chordStub())}
        onChordReposition={vi.fn()}
        onChordEdit={vi.fn()}
      />,
    );
    await waitFor(() => {
      expect(container.querySelector('.chord')).not.toBeNull();
    });
    expect(container.querySelector(".chord[role='button']")).toBeNull();
  });

  test('transpose that cancels the capo (net zero) keeps editing enabled', async () => {
    // transpose +2 with {capo: 2} → effective 0 → names == source → safe.
    const { container } = render(
      <ChordSheet
        source={'{capo: 2}\n[Am]hi'}
        transpose={2}
        astWasmLoader={makeAstLoader(chordStub())}
        onChordReposition={vi.fn()}
        onChordEdit={vi.fn()}
      />,
    );
    await waitFor(() => {
      expect(container.querySelector('.chord')).not.toBeNull();
    });
    expect(container.querySelector(".chord[role='button']")).not.toBeNull();
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

  test('inspector header shows the chord with Unicode accidentals (B♭, not Bb) (#2638)', async () => {
    const { container } = render(
      <ChordSheet
        source="[Bb]hi"
        astWasmLoader={makeAstLoader(chordNamedStub('Bb'))}
        onChordReposition={vi.fn()}
        onChordEdit={vi.fn()}
      />,
    );
    await waitFor(() => {
      expect(container.querySelector(".chord[role='button']")).not.toBeNull();
    });
    fireEvent.click(container.querySelector(".chord[role='button']") as HTMLElement);
    // Header title matches the rendered chord (♭), not the raw ASCII `b`.
    expect(container.querySelector('.chordsketch-sheet__cins-name')?.textContent).toBe('B♭');
  });

  test('inspector is a footer SIBLING of the song content, not inside it (#2638)', async () => {
    const { container } = render(
      <ChordSheet
        source="[Am]hi"
        astWasmLoader={makeAstLoader(chordStub())}
        onChordReposition={vi.fn()}
        onChordEdit={vi.fn()}
      />,
    );
    await waitFor(() => {
      expect(container.querySelector(".chord[role='button']")).not.toBeNull();
    });
    fireEvent.click(container.querySelector(".chord[role='button']") as HTMLElement);
    const wrapper = container.querySelector('.chordsketch-sheet');
    const content = container.querySelector('.chordsketch-sheet__content');
    const inspector = container.querySelector('.chordsketch-sheet__cins');
    expect(inspector).not.toBeNull();
    // Footer panel: within the sheet wrapper, but NOT inside the
    // scrolling song content (so it sits below the song, not over it).
    expect(wrapper?.contains(inspector ?? null)).toBe(true);
    expect(content?.contains(inspector ?? null)).toBe(false);
  });

  // ---- Chord audio (#2650) ---------------------------------------

  // Web Audio stand-in: the shared minimal fake (`./fake-audio-context`);
  // the hook only needs the constructor for `supported` and a graph that
  // records `play`'s calls without making sound.

  const chordAudioLoader: ChordAudioWasmLoader = () =>
    Promise.resolve({
      default: () => Promise.resolve(),
      chordPitches: (chord: string) =>
        chord === 'Am' ? new Uint8Array([57, 60, 64]) : undefined,
    });

  test('chordAudio prop turns chords into play buttons when Web Audio is supported', async () => {
    const original = (globalThis as { AudioContext?: unknown }).AudioContext;
    (window as unknown as { AudioContext: unknown }).AudioContext = FakeAudioContext;
    resetSharedAudioContextForTests();
    try {
      const { container } = render(
        <ChordSheet
          source="[Am]hi"
          chordAudio
          chordAudioLoader={chordAudioLoader}
          astWasmLoader={makeAstLoader(chordNamedStub('Am'))}
        />,
      );
      await waitFor(() =>
        expect(container.querySelector('.chord--audio')).not.toBeNull(),
      );
      const chord = container.querySelector('.chord--audio') as HTMLElement;
      expect(chord.getAttribute('role')).toBe('button');
      expect(chord.getAttribute('aria-label')).toBe('Play chord Am');
      // Clicking must not throw even before the wasm module resolves.
      fireEvent.click(chord);
    } finally {
      if (original === undefined) {
        delete (window as unknown as { AudioContext?: unknown }).AudioContext;
      } else {
        (window as unknown as { AudioContext: unknown }).AudioContext = original;
      }
      resetSharedAudioContextForTests();
    }
  });

  test('chordAudio degrades to inert chords without Web Audio support', async () => {
    const original = (globalThis as { AudioContext?: unknown }).AudioContext;
    delete (window as unknown as { AudioContext?: unknown }).AudioContext;
    resetSharedAudioContextForTests();
    try {
      const { container } = render(
        <ChordSheet
          source="[Am]hi"
          chordAudio
          chordAudioLoader={chordAudioLoader}
          astWasmLoader={makeAstLoader(chordNamedStub('Am'))}
        />,
      );
      await waitFor(() =>
        expect(container.querySelector('.chord')).not.toBeNull(),
      );
      // No Web Audio ⇒ audio mode is suppressed; chords stay plain.
      expect(container.querySelector('.chord--audio')).toBeNull();
    } finally {
      if (original !== undefined) {
        (window as unknown as { AudioContext: unknown }).AudioContext = original;
      }
      resetSharedAudioContextForTests();
    }
  });

  test('audio is additive: with editing wired, a chord both selects and plays (#2652 follow-up)', async () => {
    const original = (globalThis as { AudioContext?: unknown }).AudioContext;
    (window as unknown as { AudioContext: unknown }).AudioContext = FakeAudioContext;
    resetSharedAudioContextForTests();
    try {
      const { container } = render(
        <ChordSheet
          source="[Am]hi"
          chordAudio
          chordAudioLoader={chordAudioLoader}
          astWasmLoader={makeAstLoader(chordNamedStub('Am'))}
          onChordReposition={vi.fn()}
          onChordEdit={vi.fn()}
        />,
      );
      await waitFor(() =>
        expect(container.querySelector('.chord--audio')).not.toBeNull(),
      );
      const chord = container.querySelector('.chord--audio') as HTMLElement;
      // Both affordances present: the combined label names edit + play,
      // and aria-pressed tracks selection.
      expect(chord.getAttribute('role')).toBe('button');
      expect(chord.getAttribute('aria-pressed')).toBe('false');
      expect(chord.getAttribute('aria-label')).toBe('Edit and play chord Am');
      // Drag is no longer suppressed in audio mode.
      expect(chord.getAttribute('draggable')).toBe('true');

      // Clicking selects it (badge + inspector) so the editing panel
      // stays usable while audio is on.
      fireEvent.click(chord);
      expect(container.querySelector('.chord--selected')).not.toBeNull();
      expect(container.querySelector('.chordsketch-sheet__cins')).not.toBeNull();
    } finally {
      if (original === undefined) {
        delete (window as unknown as { AudioContext?: unknown }).AudioContext;
      } else {
        (window as unknown as { AudioContext: unknown }).AudioContext = original;
      }
      resetSharedAudioContextForTests();
    }
  });

  test('accepts an injected ChordAudioConfig and routes preview clicks through it', async () => {
    // The controlled-host form (e.g. useChordEditor's `chordAudio`
    // field): ChordSheet uses the injected `play` directly rather than
    // its own instance, so a single voice manager backs both surfaces.
    const play = vi.fn();
    const { container } = render(
      <ChordSheet
        source="[Am]hi"
        chordAudio={{ enabled: true, play }}
        astWasmLoader={makeAstLoader(chordNamedStub('Am'))}
      />,
    );
    await waitFor(() =>
      expect(container.querySelector('.chord--audio')).not.toBeNull(),
    );
    fireEvent.click(container.querySelector('.chord--audio') as HTMLElement);
    expect(play).toHaveBeenCalledWith('Am');
  });

  test('audio: a preview keyboard arrow-nudge auditions the moved chord (parity with the panel ◀/▶)', async () => {
    // Regression for the standalone-mode gap: the in-pane panel ◀/▶
    // auditioned a move but the preview arrow-key nudge did not, so the
    // same operation sounded inconsistently. Both now route through one
    // audition wrapper.
    const play = vi.fn();
    const onChordReposition = vi.fn();
    const { container } = render(
      <ChordSheet
        source="[Am]hi"
        chordAudio={{ enabled: true, play }}
        astWasmLoader={makeAstLoader(chordNamedStub('Am'))}
        onChordReposition={onChordReposition}
        onChordEdit={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(container.querySelector('.chord--audio')).not.toBeNull(),
    );
    // Click selects + plays once.
    fireEvent.click(container.querySelector('.chord--audio') as HTMLElement);
    expect(play).toHaveBeenCalledTimes(1);
    // ArrowRight on the now-selected chord nudges it one lyric step and
    // must audition the move.
    const selected = container.querySelector('.chord--selected') as HTMLElement;
    expect(selected).not.toBeNull();
    fireEvent.keyDown(selected, { key: 'ArrowRight' });
    expect(onChordReposition).toHaveBeenCalledTimes(1);
    expect(play).toHaveBeenCalledTimes(2);
    expect(play).toHaveBeenLastCalledWith('Am');
  });

  test('audio chords carry no hover background tint that could clash with the ringing white text', () => {
    // Regression for the bug fixed alongside this test: see the
    // "Chord audio" comment in src/styles.css for the full rationale.
    // In short, a hover rule that paints a light background under a
    // `.chord--audio` element outranks `.chord--ringing` (white text)
    // on specificity, so a just-played chord became white-on-light and
    // looked like it vanished. The fix removes the hover background tint
    // at the root rather than re-scoping it.
    const css = readStylesheetSource();
    // Split on `}` so each fragment spans a single rule (selector +
    // body) — robust to grouped selector lists, whitespace variants,
    // AND `@media` nesting (the wrapper's `@media (…) {` opener lands in
    // the same fragment as the inner rule). Fail any fragment that
    // mentions `.chord--audio`, `:hover`, and `background` together:
    // that is the unreadable-on-ring combination, in whatever form it
    // is reintroduced. The base `.chord--audio` rule sets `background`
    // (in its `transition`) but has no `:hover`, so it is not flagged.
    for (const fragment of css.split('}')) {
      const targetsAudioHover =
        fragment.includes('.chord--audio') && fragment.includes(':hover');
      if (targetsAudioHover) {
        expect(fragment).not.toMatch(/background/);
      }
    }
  });
});
