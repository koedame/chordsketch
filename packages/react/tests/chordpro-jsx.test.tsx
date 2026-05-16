import { fireEvent, render } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

import { renderChordproAst } from '../src/chordpro-jsx';
import type { ChordproSong } from '../src/chordpro-ast';

// Empty metadata helper — every metadata field has to be present
// to satisfy the strict ChordproMetadata shape, even on tests that
// only care about line-level rendering.
const EMPTY_META: ChordproSong['metadata'] = {
  title: null,
  subtitles: [],
  artists: [],
  composers: [],
  lyricists: [],
  album: null,
  year: null,
  key: null,
  keys: [],
  tempo: null,
  tempos: [],
  time: null,
  times: [],
  capo: null,
  sortTitle: null,
  sortArtist: null,
  arrangers: [],
  copyright: null,
  duration: null,
  tags: [],
  custom: [],
};

describe('renderChordproAst', () => {
  test('emits an empty `<div class="song">` for an empty AST', () => {
    const { container } = render(renderChordproAst({ metadata: EMPTY_META, lines: [] }));
    const song = container.querySelector('.song');
    expect(song).not.toBeNull();
    expect(song?.children.length).toBe(0);
  });

  test('reserves the chord row on chord-less segments so lyric baselines align', () => {
    // Regression guard for the baseline-misalignment surfaced in
    // PR #2455. When ANY segment on a `.line` carries a chord,
    // chord-less segments must emit a non-empty `.chord`
    // placeholder so the inline-flex `.chord-block` column
    // reserves the chord row. Without the placeholder the
    // chordless segment's `.lyrics` floats up by one row and
    // lines up with the CHORD row of its neighbours.
    // Sister-site to `chordsketch-render-html`'s `render_lyrics_line`
    // (#2142).
    const { container } = render(
      renderChordproAst({
        metadata: EMPTY_META,
        lines: [
          {
            kind: 'lyrics',
            value: {
              segments: [
                { chord: null, text: 'no chord here ', spans: [] },
                {
                  chord: { name: 'G', detail: null, display: null },
                  text: 'finally',
                  spans: [],
                },
              ],
            },
          },
        ],
      }),
    );
    const blocks = container.querySelectorAll('.line .chord-block');
    expect(blocks.length).toBe(2);
    // First (chordless) block: `.chord` placeholder present + aria-hidden
    const placeholder = blocks[0]?.querySelector('.chord');
    expect(placeholder).not.toBeNull();
    expect(placeholder?.getAttribute('aria-hidden')).toBe('true');
    // NBSP (U+00A0) inside — guarantees a line box even when CSS
    // `min-height: 1em` would otherwise be ignored on empty spans.
    expect(placeholder?.textContent).toBe(' ');
    // Second block: real chord text, no aria-hidden
    const realChord = blocks[1]?.querySelector('.chord');
    expect(realChord?.textContent).toBe('G');
    expect(realChord?.getAttribute('aria-hidden')).toBeNull();
  });

  test('skips the chord placeholder on chord-less lines', () => {
    // Inverse of the test above — when NO segment on the line
    // has a chord, the placeholder is wasteful (no alignment to
    // protect) and the chord row should disappear entirely so
    // lyric-only lines render flush.
    const { container } = render(
      renderChordproAst({
        metadata: EMPTY_META,
        lines: [
          {
            kind: 'lyrics',
            value: {
              segments: [
                { chord: null, text: 'plain text only ', spans: [] },
                { chord: null, text: 'no chords here', spans: [] },
              ],
            },
          },
        ],
      }),
    );
    expect(container.querySelectorAll('.line .chord-block .chord').length).toBe(0);
  });

  test('emits a chord-diagrams grid when the option is set, suppressing on {no_diagrams}', () => {
    // Diagrams visible by default
    const visible = render(
      renderChordproAst(
        {
          metadata: EMPTY_META,
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
                  {
                    chord: { name: 'G', detail: null, display: null },
                    text: 'world',
                    spans: [],
                  },
                ],
              },
            },
          ],
        },
        { chordDiagrams: { instrument: 'guitar' } },
      ),
    );
    const grid = visible.container.querySelector('.chord-diagrams .chord-diagrams-grid');
    expect(grid).not.toBeNull();
    // One `<div class="chord-diagram-container">` per unique
    // chord name in source order — Am then G.
    const cells = grid?.querySelectorAll('.chord-diagram-container');
    expect(cells?.length).toBe(2);

    // {no_diagrams} suppresses the grid even when the option is set
    const suppressed = render(
      renderChordproAst(
        {
          metadata: EMPTY_META,
          lines: [
            {
              kind: 'directive',
              value: {
                name: 'no_diagrams',
                value: null,
                kind: { tag: 'noDiagrams' },
                selector: null,
              },
            },
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
        },
        { chordDiagrams: { instrument: 'guitar' } },
      ),
    );
    expect(suppressed.container.querySelector('.chord-diagrams')).toBeNull();
  });

  // Position-aware diagram-placement tests (#2466 follow-up). Each
  // case constructs a one-line song that uses `Am`, sets the
  // position directive, and asserts on the emitted markup. Visual
  // layout (right column, page-bottom pin) is owned by styles.css
  // and not exercised here — these tests only enforce the
  // walker's AST → DOM contract.

  function songWithDiagramsValue(value: string | null): ChordproSong {
    return {
      metadata: EMPTY_META,
      lines: [
        {
          kind: 'directive',
          value: {
            name: 'diagrams',
            value,
            kind: { tag: 'diagrams' },
            selector: null,
          },
        },
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
    };
  }

  test('defaults `{diagrams}` without value to position=bottom', () => {
    const { container } = render(
      renderChordproAst(songWithDiagramsValue(null), {
        chordDiagrams: { instrument: 'guitar' },
      }),
    );
    const section = container.querySelector('.chord-diagrams');
    expect(section?.getAttribute('data-position')).toBe('bottom');
    const wrapper = container.querySelector('.song');
    expect(wrapper?.classList.contains('song--diagrams-bottom')).toBe(true);
    // Default placement is tail-of-body: the section is the LAST
    // child of `.song`, not the first.
    expect(wrapper?.lastElementChild).toBe(section);
  });

  test('{diagrams: top} splices the section between header and body', () => {
    const ast = songWithDiagramsValue('top');
    // Add a title so headEnd > 0 — splice has to land BEFORE the
    // first body element (`.line`) but AFTER the title node.
    ast.metadata = { ...EMPTY_META, title: 'Demo' };
    const { container } = render(
      renderChordproAst(ast, { chordDiagrams: { instrument: 'guitar' } }),
    );
    const section = container.querySelector('.chord-diagrams');
    expect(section?.getAttribute('data-position')).toBe('top');
    expect(container.querySelector('.song')?.classList.contains('song--diagrams-top')).toBe(true);
    // `.song > <header>` precedes the diagrams; the body line
    // (`.line`) follows. The header now wraps title / subtitle /
    // meta — query for the `<header>` rather than the `<h1>` so
    // the test is robust to that wrapper landing in the song
    // tree (see semantic-HTML refactor in this PR).
    const wrapper = container.querySelector('.song');
    const children = Array.from(wrapper?.children ?? []);
    const headerIdx = children.findIndex((c) => c.tagName === 'HEADER');
    const sectionIdx = children.indexOf(section as Element);
    const lineIdx = children.findIndex((c) => c.classList.contains('line'));
    expect(headerIdx).toBeGreaterThanOrEqual(0);
    expect(sectionIdx).toBeGreaterThan(headerIdx);
    expect(lineIdx).toBeGreaterThan(sectionIdx);
  });

  test('{diagrams: right} flags the wrapper for the side-column layout', () => {
    const { container } = render(
      renderChordproAst(songWithDiagramsValue('right'), {
        chordDiagrams: { instrument: 'guitar' },
      }),
    );
    expect(container.querySelector('.chord-diagrams')?.getAttribute('data-position')).toBe('right');
    expect(container.querySelector('.song')?.classList.contains('song--diagrams-right')).toBe(true);
  });

  test('{diagrams: right} wraps the body flow in `.song__body` so flex layout works', () => {
    // Regression guard for the side-column gap surfaced in #2466
    // follow-up review: when the section sat as a sibling of every
    // body line inside a CSS-Grid `.song`, the section's intrinsic
    // height inflated row 1 and pushed all `.line` rows beneath
    // it. The fix wraps the body in a single flex item so the
    // section sits beside the entire body flow, not above it.
    const { container } = render(
      renderChordproAst(songWithDiagramsValue('right'), {
        chordDiagrams: { instrument: 'guitar' },
      }),
    );
    const wrapper = container.querySelector('.song');
    expect(wrapper).not.toBeNull();
    // Two direct children: the body flow + the diagram section.
    const directChildren = Array.from(wrapper?.children ?? []);
    expect(directChildren).toHaveLength(2);
    expect(directChildren[0]?.className).toBe('song__body');
    expect(directChildren[1]?.classList.contains('chord-diagrams')).toBe(true);
    // The body line lives inside `.song__body`, NOT as a direct
    // child of `.song`.
    const bodyLine = wrapper?.querySelector('.song__body > .line');
    expect(bodyLine).not.toBeNull();
    expect(wrapper?.querySelector(':scope > .line')).toBeNull();
  });

  test('{diagrams: below} places the section at the tail and tags below', () => {
    const { container } = render(
      renderChordproAst(songWithDiagramsValue('below'), {
        chordDiagrams: { instrument: 'guitar' },
      }),
    );
    const section = container.querySelector('.chord-diagrams');
    expect(section?.getAttribute('data-position')).toBe('below');
    expect(container.querySelector('.song')?.classList.contains('song--diagrams-below')).toBe(true);
    // `below` shares the tail-of-body placement with `bottom` —
    // the difference is purely the CSS hook.
    expect(container.querySelector('.song')?.lastElementChild).toBe(section);
  });

  test('case-insensitive position values are recognised', () => {
    const { container } = render(
      renderChordproAst(songWithDiagramsValue('TOP'), {
        chordDiagrams: { instrument: 'guitar' },
      }),
    );
    expect(container.querySelector('.chord-diagrams')?.getAttribute('data-position')).toBe('top');
  });

  test('AST instrument value overrides the consumer prop', () => {
    // `<ChordDiagram>` calls into the wasm chord-diagram-svg helper,
    // which is mocked away in the test environment by a fallback
    // "no voicing" panel. Assert on the DOM shape regardless:
    // the wrapper's class plus the section's `data-position`
    // confirm the walker reached the same code path as the
    // baseline `guitar` case. The actual `instrument="piano"`
    // forwarding is covered by `chord-diagram.test.tsx` — this
    // test only proves the AST → walker → prop chain wires up.
    const { container } = render(
      renderChordproAst(songWithDiagramsValue('piano'), {
        chordDiagrams: { instrument: 'guitar' },
      }),
    );
    // `piano` is an instrument keyword, not a position keyword —
    // the section therefore stays at default position `bottom`.
    expect(container.querySelector('.chord-diagrams')?.getAttribute('data-position')).toBe('bottom');
    // Visibility intact: the section did render.
    expect(container.querySelector('.chord-diagrams')).not.toBeNull();
  });

  test('multiple {diagrams: …} lines apply last-wins for position', () => {
    const ast: ChordproSong = {
      metadata: EMPTY_META,
      lines: [
        {
          kind: 'directive',
          value: {
            name: 'diagrams',
            value: 'top',
            kind: { tag: 'diagrams' },
            selector: null,
          },
        },
        {
          kind: 'directive',
          value: {
            name: 'diagrams',
            value: 'right',
            kind: { tag: 'diagrams' },
            selector: null,
          },
        },
        {
          kind: 'lyrics',
          value: {
            segments: [
              {
                chord: { name: 'C', detail: null, display: null },
                text: 'hi',
                spans: [],
              },
            ],
          },
        },
      ],
    };
    const { container } = render(
      renderChordproAst(ast, { chordDiagrams: { instrument: 'guitar' } }),
    );
    expect(container.querySelector('.chord-diagrams')?.getAttribute('data-position')).toBe('right');
  });

  // Editor↔preview active-line sync (#2466 follow-up). The walker
  // tags every body element with `data-source-line` = the line's
  // 1-indexed position in the AST's `lines` array, and additionally
  // applies a `line--active` modifier when the line number matches
  // `options.activeSourceLine`.
  test('tags every body element with data-source-line', () => {
    const { container } = render(
      renderChordproAst({
        metadata: EMPTY_META,
        lines: [
          { kind: 'comment', style: 'normal', text: 'first' },
          {
            kind: 'lyrics',
            value: {
              segments: [
                {
                  chord: { name: 'C', detail: null, display: null },
                  text: 'hello',
                  spans: [],
                },
              ],
            },
          },
          { kind: 'empty' },
        ],
      }),
    );
    const lines = container.querySelectorAll('[data-source-line]');
    expect(lines.length).toBe(3);
    expect(lines[0]?.getAttribute('data-source-line')).toBe('1');
    expect(lines[1]?.getAttribute('data-source-line')).toBe('2');
    expect(lines[2]?.getAttribute('data-source-line')).toBe('3');
    // Without activeSourceLine, no element gets the `line--active`
    // modifier — the attribute alone is the inert "mapping" payload.
    expect(container.querySelectorAll('.line--active').length).toBe(0);
  });

  test('applies .line--active to the line matching activeSourceLine', () => {
    const { container } = render(
      renderChordproAst(
        {
          metadata: EMPTY_META,
          lines: [
            { kind: 'comment', style: 'normal', text: 'first' },
            {
              kind: 'lyrics',
              value: {
                segments: [
                  {
                    chord: { name: 'C', detail: null, display: null },
                    text: 'hello',
                    spans: [],
                  },
                ],
              },
            },
            { kind: 'empty' },
          ],
        },
        { activeSourceLine: 2 },
      ),
    );
    const active = container.querySelector('.line--active');
    expect(active).not.toBeNull();
    // The active element is line 2 — the lyrics row, NOT the
    // comment above or the empty line below.
    expect(active?.getAttribute('data-source-line')).toBe('2');
    expect(active?.classList.contains('line')).toBe(true);
    // Only one active element at a time.
    expect(container.querySelectorAll('.line--active').length).toBe(1);
  });

  test('activeSourceLine pointing at a comment line activates that comment', () => {
    const { container } = render(
      renderChordproAst(
        {
          metadata: EMPTY_META,
          lines: [
            { kind: 'comment', style: 'highlight', text: 'on me' },
            {
              kind: 'lyrics',
              value: {
                segments: [
                  {
                    chord: { name: 'C', detail: null, display: null },
                    text: 'hi',
                    spans: [],
                  },
                ],
              },
            },
          ],
        },
        { activeSourceLine: 1 },
      ),
    );
    const active = container.querySelector('.line--active');
    expect(active).not.toBeNull();
    // Highlight is rendered as `<p class="comment comment--highlight">` —
    // the modifier must coexist with the existing class list.
    expect(active?.classList.contains('comment')).toBe(true);
    expect(active?.classList.contains('comment--highlight')).toBe(true);
    expect(active?.getAttribute('data-source-line')).toBe('1');
  });

  test('activeSourceLine out of range produces no active marker', () => {
    const { container } = render(
      renderChordproAst(
        {
          metadata: EMPTY_META,
          lines: [
            {
              kind: 'lyrics',
              value: {
                segments: [
                  {
                    chord: { name: 'C', detail: null, display: null },
                    text: 'hi',
                    spans: [],
                  },
                ],
              },
            },
          ],
        },
        { activeSourceLine: 9999 },
      ),
    );
    // No line matches the bogus value — fall through to "nothing
    // highlighted". The tagging attribute is still emitted on the
    // one line that exists.
    expect(container.querySelectorAll('.line--active').length).toBe(0);
    expect(container.querySelector('[data-source-line]')?.getAttribute('data-source-line')).toBe(
      '1',
    );
  });

  // Section-wide active highlight: the `start_of_*` / `end_of_*`
  // directives apply `line--active` to the entire `<section>`, not
  // just one row, so the user editing the open or close tag sees
  // the full section as the contextual highlight.
  test('activeSourceLine on a start_of_verse directive highlights the whole section', () => {
    const ast: ChordproSong = {
      metadata: EMPTY_META,
      lines: [
        {
          kind: 'directive',
          value: {
            name: 'start_of_verse',
            value: 'Verse 1',
            kind: { tag: 'startOfVerse' },
            selector: null,
          },
        },
        {
          kind: 'lyrics',
          value: {
            segments: [
              { chord: { name: 'C', detail: null, display: null }, text: 'a', spans: [] },
            ],
          },
        },
        {
          kind: 'directive',
          value: {
            name: 'end_of_verse',
            value: null,
            kind: { tag: 'endOfVerse' },
            selector: null,
          },
        },
      ],
    };
    // Caret on line 1 — the start_of_verse directive.
    const { container } = render(
      renderChordproAst(ast, { activeSourceLine: 1 }),
    );
    const section = container.querySelector('section.verse');
    expect(section).not.toBeNull();
    expect(section?.classList.contains('line--active')).toBe(true);
    expect(section?.getAttribute('data-source-line')).toBe('1');
    // Inner lyric line is NOT separately marked active — only the
    // wrapper picks up the modifier when the caret is on the start
    // / end directive. (Click into the body would activate the row.)
    const innerLine = section?.querySelector('.line');
    expect(innerLine?.classList.contains('line--active')).toBe(false);
  });

  test('activeSourceLine on end_of_verse highlights the same section', () => {
    const ast: ChordproSong = {
      metadata: EMPTY_META,
      lines: [
        {
          kind: 'directive',
          value: {
            name: 'start_of_verse',
            value: null,
            kind: { tag: 'startOfVerse' },
            selector: null,
          },
        },
        {
          kind: 'lyrics',
          value: {
            segments: [
              { chord: { name: 'C', detail: null, display: null }, text: 'a', spans: [] },
            ],
          },
        },
        {
          kind: 'directive',
          value: {
            name: 'end_of_verse',
            value: null,
            kind: { tag: 'endOfVerse' },
            selector: null,
          },
        },
      ],
    };
    // Line 3 is the end_of_verse — the section closes on flushSection,
    // which receives line 3 as the `key` argument.
    const { container } = render(
      renderChordproAst(ast, { activeSourceLine: 3 }),
    );
    const section = container.querySelector('section.verse');
    expect(section?.classList.contains('line--active')).toBe(true);
    // start_of_verse line attribute is preserved on the wrapper —
    // navigation back to the source still resolves via the start
    // line, not the end line.
    expect(section?.getAttribute('data-source-line')).toBe('1');
  });

  // Metadata header highlight: caret on a `{tempo: 80}` directive
  // marks the "80 BPM" span in the meta strip as active, leaving
  // every other metadata cell unstyled.
  test('activeSourceLine on tempo directive highlights the BPM span', () => {
    const ast: ChordproSong = {
      metadata: {
        ...EMPTY_META,
        title: 'Test',
        artists: ['Demo'],
        tempo: '80',
        tempos: ['80'],
        key: 'G',
        keys: ['G'],
      },
      lines: [
        {
          kind: 'directive',
          value: {
            name: 'title',
            value: 'Test',
            kind: { tag: 'title' },
            selector: null,
          },
        },
        {
          kind: 'directive',
          value: {
            name: 'artist',
            value: 'Demo',
            kind: { tag: 'artist' },
            selector: null,
          },
        },
        {
          kind: 'directive',
          value: {
            name: 'key',
            value: 'G',
            kind: { tag: 'key' },
            selector: null,
          },
        },
        {
          kind: 'directive',
          value: {
            name: 'tempo',
            value: '80',
            kind: { tag: 'tempo' },
            selector: null,
          },
        },
      ],
    };
    // Caret on line 4 — the tempo directive.
    const { container } = render(
      renderChordproAst(ast, { activeSourceLine: 4 }),
    );
    // The tempo value is no longer in the header chip strip —
    // it surfaces as a positional inline marker
    // (`<p class="meta-inline meta-inline--tempo">`). When
    // `activeSourceLine` matches that directive's line, the
    // marker itself picks up `line--active`.
    const activeMarker = container.querySelector('.meta-inline--tempo.line--active');
    expect(activeMarker).not.toBeNull();
    expect(activeMarker?.getAttribute('data-source-line')).toBe('4');
    // h1.title is on a different line — not active.
    expect(container.querySelector('h1')?.classList.contains('line--active')).toBe(false);
  });

  // Caret-marker overlay: when activeSourceLine is paired with
  // caretColumn + caretLineLength, the walker injects a
  // <span class="caret-marker"> child positioned by the ratio.
  //
  // For a chord-LESS lyrics line the rendered column == the
  // source column, so the marker lands at the naive
  // `column / lineLength` ratio.
  test('caret-marker on chord-less lyrics uses the source-column ratio', () => {
    const { container } = render(
      renderChordproAst(
        {
          metadata: EMPTY_META,
          lines: [
            {
              kind: 'lyrics',
              value: {
                // 10-char chord-less lyrics text — for chord-less
                // lines the lyrics length equals the source line
                // length the editor reports, so `lyricsCaretRatio`
                // and the naive `column / lineLength` agree.
                segments: [{ chord: null, text: 'hello-text', spans: [] }],
              },
            },
          ],
        },
        { activeSourceLine: 1, caretColumn: 5, caretLineLength: 10 },
      ),
    );
    const marker = container.querySelector('.line--active .caret-marker');
    expect(marker).not.toBeNull();
    // 5 / 10 = 50% — the marker should land at the midpoint.
    expect((marker as HTMLElement).style.left).toBe('50%');
    expect(marker?.getAttribute('aria-hidden')).toBe('true');
  });

  // Chord-bearing lyrics line — the caret marker lives in the
  // upper `.chord` row when the editor caret sits inside the
  // `[chord]` source bracket, and in the lower `.lyrics` row
  // when the caret sits in the lyric text. This is what a
  // singer / transcriber expects when looking at the preview;
  // collapsing both rows into a single line-level horizontal
  // bar (the previous behaviour) lost the upper-vs-lower
  // distinction.
  test('chord-bearing line places caret on upper chord row vs lower lyrics row', () => {
    // Source: `[Am]Hello World` — 15 chars (4 bracket + 11 text).
    const ast: ChordproSong = {
      metadata: EMPTY_META,
      lines: [
        {
          kind: 'lyrics',
          value: {
            segments: [
              {
                chord: { name: 'Am', detail: null, display: null },
                text: 'Hello World',
                spans: [],
              },
            ],
          },
        },
      ],
    };
    // For an inline caret marker inside `.lyrics`, the marker
    // sits BETWEEN `.lyric-char` spans. "Caret offset N" means
    // exactly N `.lyric-char` spans precede the marker. The
    // helper makes that count explicit so the tests read as
    // "between character 0 and 1" instead of opaque CSS%
    // arithmetic.
    const lyricCharsBeforeCaret = (root: ParentNode): number => {
      const marker = root.querySelector('.chord-block .lyrics > .caret-marker');
      if (!marker) return -1;
      let count = 0;
      let sib = marker.previousElementSibling;
      while (sib) {
        if (sib.classList.contains('lyric-char')) count++;
        sib = sib.previousElementSibling;
      }
      return count;
    };

    // Caret at source col 2 (inside the `[Am]` bracket between
    // "A" and "m") → chord row, 50% across the rendered "Am".
    let r = render(
      renderChordproAst(ast, {
        activeSourceLine: 1,
        caretColumn: 2,
        caretLineLength: 15,
      }),
    );
    let chordMarker = r.container.querySelector(
      '.chord-block .chord .caret-marker',
    ) as HTMLElement | null;
    let lyricsMarker = r.container.querySelector(
      '.chord-block .lyrics .caret-marker',
    ) as HTMLElement | null;
    expect(chordMarker?.style.left).toBe('50%');
    expect(lyricsMarker).toBeNull();
    // No line-level duplicate.
    expect(r.container.querySelectorAll('.caret-marker').length).toBe(1);

    // Caret just past the chord bracket (source col 4 = start of
    // "H") → lyrics row, BEFORE the first lyric char (0 chars
    // precede the caret marker).
    r = render(
      renderChordproAst(ast, {
        activeSourceLine: 1,
        caretColumn: 4,
        caretLineLength: 15,
      }),
    );
    chordMarker = r.container.querySelector(
      '.chord-block .chord .caret-marker',
    ) as HTMLElement | null;
    lyricsMarker = r.container.querySelector(
      '.chord-block .lyrics .caret-marker',
    ) as HTMLElement | null;
    expect(chordMarker).toBeNull();
    expect(lyricsMarker).not.toBeNull();
    expect(lyricCharsBeforeCaret(r.container)).toBe(0);

    // Caret inside the lyrics (source col 9 = between "Hello"
    // and " World") → lyrics row, between char 4 ("o") and 5
    // (" ") — i.e. 5 lyric chars precede the marker.
    r = render(
      renderChordproAst(ast, {
        activeSourceLine: 1,
        caretColumn: 9,
        caretLineLength: 15,
      }),
    );
    expect(lyricCharsBeforeCaret(r.container)).toBe(5);

    // Caret at end of source (col 15) → lyrics row, AFTER all
    // 11 chars in "Hello World" (so 11 lyric chars precede the
    // marker).
    r = render(
      renderChordproAst(ast, {
        activeSourceLine: 1,
        caretColumn: 15,
        caretLineLength: 15,
      }),
    );
    expect(lyricCharsBeforeCaret(r.container)).toBe(11);
  });

  // Drag-to-reposition wiring — when `onChordReposition` is
  // passed, `.chord` spans become draggable and `.lyrics` spans
  // become drop targets. Without the option, both stay inert.
  test('chord drag/drop affordances are off by default', () => {
    const ast: ChordproSong = {
      metadata: EMPTY_META,
      lines: [
        {
          kind: 'lyrics',
          value: {
            segments: [
              {
                chord: { name: 'Am', detail: null, display: null },
                text: 'Hello',
                spans: [],
              },
            ],
          },
        },
      ],
    };
    const { container } = render(renderChordproAst(ast, {}));
    const chord = container.querySelector('.chord');
    // No `onChordReposition` → not draggable.
    expect(chord?.getAttribute('draggable')).toBeNull();
  });

  test('passing onChordReposition turns chord spans into drag sources', () => {
    const repo = vi.fn();
    const ast: ChordproSong = {
      metadata: EMPTY_META,
      lines: [
        {
          kind: 'lyrics',
          value: {
            segments: [
              {
                chord: { name: 'Am', detail: null, display: null },
                text: 'Hello',
                spans: [],
              },
            ],
          },
        },
      ],
    };
    const { container } = render(
      renderChordproAst(ast, { onChordReposition: repo }),
    );
    const chord = container.querySelector('.chord') as HTMLElement | null;
    expect(chord?.getAttribute('draggable')).toBe('true');
  });

  // Drop indicator: while a chord is being dragged over a
  // specific lyric character, that character's `.lyric-char`
  // span picks up `lyric-char--drop-target` (dashed crimson
  // outline) so the user sees WHICH character the chord will
  // land above. The highlight clears on drop / dragleave.
  test('drop indicator outlines the targeted lyric character', () => {
    const repo = vi.fn();
    const ast: ChordproSong = {
      metadata: EMPTY_META,
      lines: [
        {
          kind: 'lyrics',
          value: {
            segments: [
              {
                chord: { name: 'Am', detail: null, display: null },
                text: 'Hello',
                spans: [],
              },
              {
                chord: { name: 'G', detail: null, display: null },
                text: 'World',
                spans: [],
              },
            ],
          },
        },
      ],
    };
    const { container } = render(
      renderChordproAst(ast, { onChordReposition: repo }),
    );
    const line = container.querySelector('.line') as HTMLElement;
    const blocks = container.querySelectorAll('.chord-block');
    const targetLyrics = blocks[1].querySelector('.lyrics') as HTMLElement;
    // Build a DataTransfer mock with our custom mime — testing-
    // library's fireEvent passes the event data through to React.
    // jsdom doesn't implement the `DataTransfer` constructor, so
    // hand-roll the minimal surface React's drag handlers read:
    // `types`, `getData`, plus `dropEffect` / `effectAllowed`
    // setters (which we don't observe).
    const dtStore = new Map<string, string>();
    dtStore.set(
      'application/x-chordsketch-chord',
      JSON.stringify({ fromLine: 1, fromColumn: 0, fromLength: 4, chord: 'Am' }),
    );
    const dt = {
      types: [...dtStore.keys()],
      getData: (k: string) => dtStore.get(k) ?? '',
      setData: (k: string, v: string) => dtStore.set(k, v),
      dropEffect: 'none' as DataTransfer['dropEffect'],
      effectAllowed: 'all' as DataTransfer['effectAllowed'],
    };
    // dragover on the lyrics span (bubbles to `.line`)
    fireEvent.dragOver(targetLyrics, { dataTransfer: dt, clientX: 100, clientY: 50 });
    // Single-character drop highlight on the targeted lyric
    // char. The CSS `::before` pseudo extends the highlight
    // upward through the chord row so the user dragging in the
    // chord row can still see it — that's CSS-only behaviour
    // and not asserted here (jsdom doesn't render pseudos);
    // the JS contract is that exactly one `.lyric-char` gets
    // the `--drop-target` class.
    let highlighted = container.querySelectorAll('.lyric-char--drop-target');
    expect(highlighted.length).toBe(1);
    expect(highlighted[0].closest('.chord-block')).toBe(blocks[1]);
    // drop clears the highlight and fires the callback
    fireEvent.drop(targetLyrics, { dataTransfer: dt, clientX: 100, clientY: 50 });
    highlighted = container.querySelectorAll('.lyric-char--drop-target');
    expect(highlighted.length).toBe(0);
    expect(repo).toHaveBeenCalledTimes(1);
    // `copy` is derived from `event.altKey`; jsdom's synthetic
    // drop event leaves it `undefined` (not `false`). Both values
    // mean "move semantics" — assert truthiness instead of exact
    // equality.
    expect(repo.mock.calls[0][0]).toMatchObject({
      fromLine: 1,
      fromColumn: 0,
      fromLength: 4,
      toLine: 1,
      chord: 'Am',
    });
    expect(repo.mock.calls[0][0].copy).toBeFalsy();
  });

  // Dropping on the CHORD row (not just the lyrics row) must
  // also work — the user expects to be able to drop the dragged
  // chord on top of another chord's row. The drop coordinate is
  // computed from the pointer's X position mapped against the
  // chord-block's `.lyrics` (the chord row and lyrics row sit at
  // the same X, just different Y).
  test('drop on chord row maps to the underlying lyrics character', () => {
    const repo = vi.fn();
    const ast: ChordproSong = {
      metadata: EMPTY_META,
      lines: [
        {
          kind: 'lyrics',
          value: {
            segments: [
              {
                chord: { name: 'Am', detail: null, display: null },
                text: 'Hello',
                spans: [],
              },
              {
                chord: { name: 'G', detail: null, display: null },
                text: 'World',
                spans: [],
              },
            ],
          },
        },
      ],
    };
    const { container } = render(
      renderChordproAst(ast, { onChordReposition: repo }),
    );
    const blocks = container.querySelectorAll('.chord-block');
    const targetChord = blocks[1].querySelector('.chord') as HTMLElement;
    // jsdom doesn't implement the `DataTransfer` constructor, so
    // hand-roll the minimal surface React's drag handlers read:
    // `types`, `getData`, plus `dropEffect` / `effectAllowed`
    // setters (which we don't observe).
    const dtStore = new Map<string, string>();
    dtStore.set(
      'application/x-chordsketch-chord',
      JSON.stringify({ fromLine: 1, fromColumn: 0, fromLength: 4, chord: 'Am' }),
    );
    const dt = {
      types: [...dtStore.keys()],
      getData: (k: string) => dtStore.get(k) ?? '',
      setData: (k: string, v: string) => dtStore.set(k, v),
      dropEffect: 'none' as DataTransfer['dropEffect'],
      effectAllowed: 'all' as DataTransfer['effectAllowed'],
    };
    fireEvent.dragOver(targetChord, { dataTransfer: dt, clientX: 100, clientY: 5 });
    // The drop-target highlight should still land in the
    // matching lyrics span — the chord-row hit walks down to the
    // `.lyrics` of the same chord-block.
    const highlighted = container.querySelector('.lyric-char--drop-target');
    expect(highlighted).not.toBeNull();
    expect(highlighted?.closest('.chord-block')).toBe(blocks[1]);
    fireEvent.drop(targetChord, { dataTransfer: dt, clientX: 100, clientY: 5 });
    expect(repo).toHaveBeenCalledTimes(1);
  });

  // Multi-segment chord-bearing line — the marker must land in
  // the right segment's row, not just somewhere on the line.
  test('multi-segment line: caret picks the matching segment', () => {
    // Source: `[Am]Hello [G]world` — 18 chars total.
    // segments[0]: chord="Am" (cols 0..3), text="Hello " (cols 4..9)
    // segments[1]: chord="G"  (cols 10..12), text="world" (cols 13..17)
    const ast: ChordproSong = {
      metadata: EMPTY_META,
      lines: [
        {
          kind: 'lyrics',
          value: {
            segments: [
              {
                chord: { name: 'Am', detail: null, display: null },
                text: 'Hello ',
                spans: [],
              },
              {
                chord: { name: 'G', detail: null, display: null },
                text: 'world',
                spans: [],
              },
            ],
          },
        },
      ],
    };
    // Caret at col 11 — inside the `[G]` bracket of segment 1
    // (cols 10..12). Should land in segment 1's chord row.
    const r = render(
      renderChordproAst(ast, {
        activeSourceLine: 1,
        caretColumn: 11,
        caretLineLength: 18,
      }),
    );
    const blocks = r.container.querySelectorAll('.chord-block');
    expect(blocks.length).toBe(2);
    expect(blocks[0].querySelector('.caret-marker')).toBeNull();
    const seg1ChordMarker = blocks[1].querySelector(
      '.chord .caret-marker',
    ) as HTMLElement | null;
    expect(seg1ChordMarker).not.toBeNull();
    // Caret col 11, chord bracket "[G]" spans cols 10..12, name
    // length 1, inside-bracket position = 11 - 10 - 1 = 0,
    // ratio = 0/1 = 0%.
    expect(seg1ChordMarker?.style.left).toBe('0%');
  });

  test('caret-marker omitted when caretColumn / caretLineLength are absent', () => {
    const { container } = render(
      renderChordproAst(
        {
          metadata: EMPTY_META,
          lines: [
            {
              kind: 'lyrics',
              value: {
                segments: [
                  {
                    chord: { name: 'C', detail: null, display: null },
                    text: 'hi',
                    spans: [],
                  },
                ],
              },
            },
          ],
        },
        { activeSourceLine: 1 },
      ),
    );
    expect(container.querySelector('.caret-marker')).toBeNull();
  });

  test('caret-marker ratio clamps to 0..1 on overrun', () => {
    const { container } = render(
      renderChordproAst(
        {
          metadata: EMPTY_META,
          lines: [
            {
              kind: 'lyrics',
              value: {
                segments: [
                  { chord: null, text: 'ab', spans: [] },
                ],
              },
            },
          ],
        },
        { activeSourceLine: 1, caretColumn: 999, caretLineLength: 2 },
      ),
    );
    const marker = container.querySelector('.caret-marker');
    expect((marker as HTMLElement).style.left).toBe('100%');
  });

  test('activeSourceLine on title directive highlights the h1 itself', () => {
    const ast: ChordproSong = {
      metadata: { ...EMPTY_META, title: 'Hello' },
      lines: [
        {
          kind: 'directive',
          value: {
            name: 'title',
            value: 'Hello',
            kind: { tag: 'title' },
            selector: null,
          },
        },
      ],
    };
    const { container } = render(
      renderChordproAst(ast, { activeSourceLine: 1 }),
    );
    const h1 = container.querySelector('h1');
    expect(h1?.classList.contains('line--active')).toBe(true);
    expect(h1?.getAttribute('data-source-line')).toBe('1');
  });

  // `{key}` / `{tempo}` / `{time}` render as narrow `.meta-inline`
  // chips whose visual width has no relationship to the source
  // line's character count. A `caret-marker` positioned at
  // `left: ratio%` inside the chip lands somewhere meaningless —
  // typically pinned to the chip's right edge for any caret
  // column past the chip's narrow span. The walker must skip the
  // in-chip marker; the `line--active` background highlight
  // alone is the affordance for "caret is on this directive".
  test('inline meta-chip skips the in-chip caret-marker but keeps line--active', () => {
    const cases: Array<{ name: 'key' | 'tempo' | 'time'; value: string; selector: 'meta-inline--key' | 'meta-inline--tempo' | 'meta-inline--time' }> = [
      { name: 'key', value: 'G', selector: 'meta-inline--key' },
      { name: 'tempo', value: '80', selector: 'meta-inline--tempo' },
      { name: 'time', value: '4/4', selector: 'meta-inline--time' },
    ];
    for (const c of cases) {
      const ast: ChordproSong = {
        metadata: EMPTY_META,
        lines: [
          {
            kind: 'directive',
            value: {
              name: c.name,
              value: c.value,
              kind: { tag: c.name },
              selector: null,
            },
          },
        ],
      };
      const { container } = render(
        renderChordproAst(ast, {
          activeSourceLine: 1,
          caretColumn: 10,
          caretLineLength: 10,
        }),
      );
      const chip = container.querySelector(`.${c.selector}`);
      expect(chip).not.toBeNull();
      expect(chip?.classList.contains('line--active')).toBe(true);
      expect(chip?.querySelector('.caret-marker')).toBeNull();
    }
  });

  test('renders a chord+lyric pair as `.chord-block`', () => {
    const { container } = render(
      renderChordproAst({
        metadata: EMPTY_META,
        lines: [
          {
            kind: 'lyrics',
            value: {
              segments: [
                {
                  chord: { name: 'Am', detail: null, display: null },
                  text: 'Hello ',
                  spans: [],
                },
                {
                  chord: { name: 'G', detail: null, display: null },
                  text: 'world',
                  spans: [],
                },
              ],
            },
          },
        ],
      }),
    );
    const blocks = container.querySelectorAll('.line .chord-block');
    expect(blocks.length).toBe(2);
    expect(blocks[0]?.querySelector('.chord')?.textContent).toBe('Am');
    expect(blocks[0]?.querySelector('.lyrics')?.textContent).toBe('Hello ');
    expect(blocks[1]?.querySelector('.chord')?.textContent).toBe('G');
    expect(blocks[1]?.querySelector('.lyrics')?.textContent).toBe('world');
  });

  // `{key}` no longer surfaces in the header chip strip — every
  // declaration is shown inline at the directive's source
  // position via `<KeySignatureGlyph>` + the
  // `meta-inline--key` / `--key-pair` markers. The header
  // strip keeps only the metadata values that have no
  // positional inline display: `{capo}` and `{duration}`.
  test('key value is omitted from the header chip strip', () => {
    const ast: ChordproSong = {
      metadata: { ...EMPTY_META, title: 'My Song', key: 'G', keys: ['G'] },
      lines: [
        {
          kind: 'directive',
          value: { name: 'key', value: 'G', kind: { tag: 'key' }, selector: null },
        },
      ],
    };
    for (const opts of [{}, { transposedKey: 'A' }, { transposedKey: null }, { transposedKey: 'G' }]) {
      const { container } = render(renderChordproAst(ast, opts));
      const params = container.querySelector('.meta--params');
      const chipText = Array.from(params?.querySelectorAll('.meta__chip') ?? [])
        .map((c) => c.textContent)
        .join('|');
      expect(chipText).not.toContain('Key');
      // The inline marker is still present.
      expect(container.querySelector('.meta-inline--key')).not.toBeNull();
    }
  });

  // Attribution rows ship with role icons so the eye can pick out
  // "performer / composer / lyricist / tag" without parsing the
  // textual labels.
  test('header attribution rows carry role icons', () => {
    const ast: ChordproSong = {
      metadata: {
        ...EMPTY_META,
        title: 'Demo',
        artists: ['ChordSketch'],
        composers: ['J. Composer'],
        lyricists: ['J. Lyricist'],
        tags: ['demo'],
      },
      lines: [],
    };
    const { container } = render(renderChordproAst(ast));
    expect(container.querySelector('.role-icon--artist')).not.toBeNull();
    expect(container.querySelector('.role-icon--composer')).not.toBeNull();
    expect(container.querySelector('.role-icon--lyricist')).not.toBeNull();
    expect(container.querySelector('.role-icon--tag')).not.toBeNull();
    // Each tag chip ships its own icon (one per tag).
    expect(container.querySelectorAll('.meta--tags .role-icon--tag').length).toBe(1);
  });

  // `{start_of_grid}` body lines render through the structured
  // grid layout (bars + barlines + chord cells) instead of as
  // plain monospace text.
  test('grid-section lyrics line renders structured iReal-style bars', () => {
    const ast: ChordproSong = {
      metadata: EMPTY_META,
      lines: [
        {
          kind: 'directive',
          value: {
            name: 'start_of_grid',
            value: 'Outro',
            kind: { tag: 'startOfGrid' },
            selector: null,
          },
        },
        {
          kind: 'lyrics',
          value: {
            segments: [
              { chord: null, text: '|: G  .  .  . | C  .  .  . :|', spans: [] },
            ],
          },
        },
        {
          kind: 'directive',
          value: {
            name: 'end_of_grid',
            value: null,
            kind: { tag: 'endOfGrid' },
            selector: null,
          },
        },
      ],
    };
    const { container } = render(renderChordproAst(ast));
    const gridLine = container.querySelector('.grid-line');
    expect(gridLine).not.toBeNull();
    // Repeat-start at the beginning.
    expect(gridLine?.querySelector('.grid-barline--repeat-start')).not.toBeNull();
    // Repeat-end at the end.
    expect(gridLine?.querySelector('.grid-barline--repeat-end')).not.toBeNull();
    // Two equal-width bar cells (one per bar in the source).
    const bars = gridLine?.querySelectorAll('.grid-bar') ?? [];
    expect(bars.length).toBe(2);
    // Source `|: G  .  .  . | C  .  .  . :|` → each bar has 4
    // beat slots (1 chord + 3 continuations) with the chord
    // anchored in slot 1.
    expect(bars[0]?.getAttribute('data-beats')).toBe('4');
    expect(bars[1]?.getAttribute('data-beats')).toBe('4');
    expect(bars[0]?.querySelector('.grid-chord')?.textContent).toBe('G');
    expect(bars[1]?.querySelector('.grid-chord')?.textContent).toBe('C');
    // No standalone `.grid-continuation` elements survive — beat
    // slots carry the continuation by being empty.
    expect(gridLine?.querySelectorAll('.grid-continuation').length).toBe(0);
  });

  test('grid bar with multiple chords places each on its own beat slot', () => {
    // `| G . C . |` → 4 slots, G in slot 1, C in slot 3.
    const ast: ChordproSong = {
      metadata: EMPTY_META,
      lines: [
        {
          kind: 'directive',
          value: {
            name: 'start_of_grid',
            value: null,
            kind: { tag: 'startOfGrid' },
            selector: null,
          },
        },
        {
          kind: 'lyrics',
          value: { segments: [{ chord: null, text: '| G . C . |', spans: [] }] },
        },
        {
          kind: 'directive',
          value: {
            name: 'end_of_grid',
            value: null,
            kind: { tag: 'endOfGrid' },
            selector: null,
          },
        },
      ],
    };
    const { container } = render(renderChordproAst(ast));
    const bar = container.querySelector('.grid-bar');
    expect(bar?.getAttribute('data-beats')).toBe('4');
    const slots = bar?.querySelectorAll('.grid-beat') ?? [];
    expect(slots.length).toBe(4);
    expect(slots[0]?.querySelector('.grid-chord')?.textContent).toBe('G');
    expect(slots[1]?.querySelector('.grid-chord')).toBeNull();
    expect(slots[2]?.querySelector('.grid-chord')?.textContent).toBe('C');
    expect(slots[3]?.querySelector('.grid-chord')).toBeNull();
  });

  test('grid bars survive a volta + final barline source', () => {
    // `|: G | C | D | G | |1 Em | C :| |2 Am | G |.`
    const ast: ChordproSong = {
      metadata: EMPTY_META,
      lines: [
        {
          kind: 'directive',
          value: {
            name: 'start_of_grid',
            value: null,
            kind: { tag: 'startOfGrid' },
            selector: null,
          },
        },
        {
          kind: 'lyrics',
          value: {
            segments: [
              {
                chord: null,
                text: '|: G | C | D | G | |1 Em | C :| |2 Am | G |.',
                spans: [],
              },
            ],
          },
        },
        {
          kind: 'directive',
          value: {
            name: 'end_of_grid',
            value: null,
            kind: { tag: 'endOfGrid' },
            selector: null,
          },
        },
      ],
    };
    const { container } = render(renderChordproAst(ast));
    const gridLine = container.querySelector('.grid-line');
    expect(gridLine).not.toBeNull();
    // Volta marker + final barline.
    expect(gridLine?.querySelectorAll('.grid-volta').length).toBe(2);
    expect(gridLine?.querySelector('.grid-barline--final')).not.toBeNull();
    // 8 bars (each chord lands in its own bar cell).
    expect(gridLine?.querySelectorAll('.grid-bar').length).toBe(8);
    // Chord names appear in order, all normalised to Unicode
    // accidentals (none of these have flats/sharps so the test
    // just checks the chord-name sequence).
    const chords = Array.from(gridLine?.querySelectorAll('.grid-chord') ?? []).map(
      (c) => c.textContent,
    );
    expect(chords).toEqual(['G', 'C', 'D', 'G', 'Em', 'C', 'Am', 'G']);
  });

  // Grid row label (`A` / `Coda` before the first barline) is
  // surfaced as a left-side `.grid-row__label` cell rendered
  // outside the bar grid proper.
  test('grid row label is rendered in a `.grid-row__label` cell', () => {
    const ast: ChordproSong = {
      metadata: EMPTY_META,
      lines: [
        {
          kind: 'directive',
          value: { name: 'start_of_grid', value: null, kind: { tag: 'startOfGrid' }, selector: null },
        },
        {
          kind: 'lyrics',
          value: {
            segments: [{ chord: null, text: 'Coda | D7 . . . |.', spans: [] }],
          },
        },
        {
          kind: 'directive',
          value: { name: 'end_of_grid', value: null, kind: { tag: 'endOfGrid' }, selector: null },
        },
      ],
    };
    const { container } = render(renderChordproAst(ast));
    expect(container.querySelector('.grid-row__label')?.textContent).toBe('Coda');
  });

  // Grid row trailing comment (any text after the last barline)
  // surfaces as a right-side `.grid-row__comment` cell.
  test('grid row trailing comment renders in a `.grid-row__comment` cell', () => {
    const ast: ChordproSong = {
      metadata: EMPTY_META,
      lines: [
        {
          kind: 'directive',
          value: { name: 'start_of_grid', value: null, kind: { tag: 'startOfGrid' }, selector: null },
        },
        {
          kind: 'lyrics',
          value: {
            segments: [{ chord: null, text: '|: G . . . :| repeat 4 times', spans: [] }],
          },
        },
        {
          kind: 'directive',
          value: { name: 'end_of_grid', value: null, kind: { tag: 'endOfGrid' }, selector: null },
        },
      ],
    };
    const { container } = render(renderChordproAst(ast));
    expect(container.querySelector('.grid-row__comment')?.textContent).toBe('repeat 4 times');
  });

  // `%` / `%%` measure-repeat cells render as dedicated beat
  // slots with `--percent1` / `--percent2` modifier classes.
  test('grid measure-repeat markers `%` and `%%` render as percent beats', () => {
    const ast: ChordproSong = {
      metadata: EMPTY_META,
      lines: [
        {
          kind: 'directive',
          value: { name: 'start_of_grid', value: null, kind: { tag: 'startOfGrid' }, selector: null },
        },
        {
          kind: 'lyrics',
          value: { segments: [{ chord: null, text: '| G . | % . | %% . |', spans: [] }] },
        },
        {
          kind: 'directive',
          value: { name: 'end_of_grid', value: null, kind: { tag: 'endOfGrid' }, selector: null },
        },
      ],
    };
    const { container } = render(renderChordproAst(ast));
    expect(container.querySelectorAll('.grid-beat--percent1').length).toBe(1);
    expect(container.querySelectorAll('.grid-beat--percent2').length).toBe(1);
  });

  // Cell-internal `~` puts multiple chords in one beat slot
  // (`C~G` → both chords share a `.grid-beat--multi`).
  test('grid multi-chord cell (`C~G`) renders in a `.grid-beat--multi` slot', () => {
    const ast: ChordproSong = {
      metadata: EMPTY_META,
      lines: [
        {
          kind: 'directive',
          value: { name: 'start_of_grid', value: null, kind: { tag: 'startOfGrid' }, selector: null },
        },
        {
          kind: 'lyrics',
          value: { segments: [{ chord: null, text: '| C~G . . . |', spans: [] }] },
        },
        {
          kind: 'directive',
          value: { name: 'end_of_grid', value: null, kind: { tag: 'endOfGrid' }, selector: null },
        },
      ],
    };
    const { container } = render(renderChordproAst(ast));
    const multi = container.querySelector('.grid-beat--multi');
    expect(multi).not.toBeNull();
    const chordNames = Array.from(multi?.querySelectorAll('.grid-chord') ?? []).map(
      (c) => c.textContent,
    );
    expect(chordNames).toEqual(['C', 'G']);
    expect(multi?.querySelector('.grid-chord__sep')?.textContent).toBe('~');
  });

  // Combined `:|:` barline renders as a single `.grid-barline--repeat-both`
  // marker (not as repeat-end followed by repeat-start).
  test('combined `:|:` barline renders as a single `--repeat-both` marker', () => {
    const ast: ChordproSong = {
      metadata: EMPTY_META,
      lines: [
        {
          kind: 'directive',
          value: { name: 'start_of_grid', value: null, kind: { tag: 'startOfGrid' }, selector: null },
        },
        {
          kind: 'lyrics',
          value: { segments: [{ chord: null, text: '| G . :|: C . |', spans: [] }] },
        },
        {
          kind: 'directive',
          value: { name: 'end_of_grid', value: null, kind: { tag: 'endOfGrid' }, selector: null },
        },
      ],
    };
    const { container } = render(renderChordproAst(ast));
    expect(container.querySelectorAll('.grid-barline--repeat-both').length).toBe(1);
    // The `:|:` glyph should NOT decompose into separate
    // repeat-end + repeat-start barlines.
    expect(container.querySelectorAll('.grid-barline--repeat-end').length).toBe(0);
    expect(container.querySelectorAll('.grid-barline--repeat-start').length).toBe(0);
  });

  // Strum row: a leading `s` after the first barline switches
  // the row to strum mode. Tokens like `dn` / `up` / `d+` / `u+`
  // get arrow glyphs and modifier classes; dialect tokens
  // (`dn~up`, `~ux`) survive verbatim under `--custom`.
  test('strum row detects leading `s` and emits arrow glyphs', () => {
    const ast: ChordproSong = {
      metadata: EMPTY_META,
      lines: [
        {
          kind: 'directive',
          value: { name: 'start_of_grid', value: null, kind: { tag: 'startOfGrid' }, selector: null },
        },
        {
          kind: 'lyrics',
          value: { segments: [{ chord: null, text: '|s dn up d+ u+ ~up ~ux |', spans: [] }] },
        },
        {
          kind: 'directive',
          value: { name: 'end_of_grid', value: null, kind: { tag: 'endOfGrid' }, selector: null },
        },
      ],
    };
    const { container } = render(renderChordproAst(ast));
    const line = container.querySelector('.grid-line--strum');
    expect(line).not.toBeNull();
    // Strum cells with modifier classes per token shape.
    expect(line?.querySelector('.grid-strum--down')).not.toBeNull();
    expect(line?.querySelector('.grid-strum--up')).not.toBeNull();
    expect(line?.querySelector('.grid-strum--down-accent')).not.toBeNull();
    expect(line?.querySelector('.grid-strum--up-accent')).not.toBeNull();
    expect(line?.querySelector('.grid-strum--anticipated')).not.toBeNull();
    expect(line?.querySelector('.grid-strum--custom')).not.toBeNull();
  });

  // Chord names and key values are typeset with proper Unicode
  // musical accidentals (`♭` / `♯`) so a `{key: Bb}` reads as
  // "B♭" and a chord `[Bb]` shows as "B♭" in the chord row.
  test('chord and key displays use ♭ / ♯ Unicode accidentals', () => {
    const ast: ChordproSong = {
      metadata: { ...EMPTY_META, key: 'Bb', keys: ['Bb'] },
      lines: [
        {
          kind: 'directive',
          value: { name: 'key', value: 'Bb', kind: { tag: 'key' }, selector: null },
        },
        {
          kind: 'lyrics',
          value: {
            segments: [
              { chord: { name: 'Bb', detail: null, display: null }, text: 'flat ', spans: [] },
              { chord: { name: 'F#m7', detail: null, display: null }, text: 'sharp', spans: [] },
            ],
          },
        },
      ],
    };
    const { container } = render(renderChordproAst(ast));
    // Inline `{key}` marker carries the value (the header chip
    // for `{key}` was retired in favour of the inline marker).
    const inlineValue = container.querySelector('.meta-inline--key .meta-inline__value');
    expect(inlineValue?.textContent).toBe('B♭');
    // Chord-block chords show `B♭` and `F♯m7`.
    const chords = Array.from(container.querySelectorAll('.chord')).map((el) => el.textContent);
    expect(chords).toEqual(['B♭', 'F♯m7']);
  });

  // Inline `{key}` marker — when transpose is active AND the
  // directive matches the song-primary key, the marker shows
  // both the written (notated) and sounding (concert) key with
  // their respective key-signature glyphs.
  test('inline {key} marker shows Original + Playing when transpose is active', () => {
    const ast: ChordproSong = {
      metadata: { ...EMPTY_META, key: 'G', keys: ['G'] },
      lines: [
        {
          kind: 'directive',
          value: { name: 'key', value: 'G', kind: { tag: 'key' }, selector: null },
        },
      ],
    };
    const { container } = render(renderChordproAst(ast, { transposedKey: 'A' }));
    const marker = container.querySelector('.meta-inline--key-pair');
    expect(marker).not.toBeNull();
    const groups = marker?.querySelectorAll('.meta-inline__group');
    expect(groups?.length).toBe(2);
    // Written half = original.
    expect(groups?.[0]?.querySelector('.meta-inline__label')?.textContent).toBe('Original:');
    expect(groups?.[0]?.querySelector('.meta-inline__value')?.textContent).toBe('G');
    expect(groups?.[0]?.querySelector('.music-glyph--key')).not.toBeNull();
    // Sounding half = transposed.
    expect(groups?.[1]?.querySelector('.meta-inline__label')?.textContent).toBe('Playing:');
    expect(groups?.[1]?.querySelector('.meta-inline__value')?.textContent).toBe('A');
    expect(groups?.[1]?.querySelector('.music-glyph--key')).not.toBeNull();
  });

  test('inline {key} marker stays single when transpose is null or matches written key', () => {
    const ast: ChordproSong = {
      metadata: { ...EMPTY_META, key: 'G', keys: ['G'] },
      lines: [
        {
          kind: 'directive',
          value: { name: 'key', value: 'G', kind: { tag: 'key' }, selector: null },
        },
      ],
    };
    for (const opts of [{ transposedKey: null }, { transposedKey: 'G' }, {}]) {
      const { container } = render(renderChordproAst(ast, opts));
      expect(container.querySelector('.meta-inline--key-pair')).toBeNull();
      // Single marker has just one label, "Key:".
      expect(container.querySelector('.meta-inline--key .meta-inline__label')?.textContent).toBe(
        'Key:',
      );
    }
  });

  test('mid-song {key} that does not match the primary key stays single even under transpose', () => {
    // Host's `transposedKey` is computed against the primary key
    // (last `metadata.key`); applying it to an unrelated mid-song
    // `{key}` would be incorrect, so those markers fall through to
    // the single chip.
    const ast: ChordproSong = {
      metadata: { ...EMPTY_META, key: 'D', keys: ['G', 'D'] },
      lines: [
        {
          kind: 'directive',
          value: { name: 'key', value: 'G', kind: { tag: 'key' }, selector: null },
        },
        {
          kind: 'directive',
          value: { name: 'key', value: 'D', kind: { tag: 'key' }, selector: null },
        },
      ],
    };
    const { container } = render(renderChordproAst(ast, { transposedKey: 'E' }));
    const markers = container.querySelectorAll('.meta-inline--key');
    expect(markers).toHaveLength(2);
    // First `{key: G}` — not the primary, so single chip.
    expect(markers[0]?.classList.contains('meta-inline--key-pair')).toBe(false);
    // Second `{key: D}` — primary, gets the Written + Sounding pair.
    expect(markers[1]?.classList.contains('meta-inline--key-pair')).toBe(true);
  });

  test('extended metadata lands in tiered rows: attribution / params / supplementary / tags', () => {
    // Mirrors the ChordPro spec's conceptual grouping. Each tier
    // is its own `<p>` so the visual hierarchy is robust to CSS
    // changes:
    //   Tier 1: attribution (artists primary, composers/lyricists/arrangers secondary)
    //   Tier 2: musical params (Key / Capo / BPM / Time / Duration chips)
    //   Tier 3: supplementary (album / year / copyright)
    //   Tier 4: tags (separate row with pill chips)
    const { container } = render(
      renderChordproAst({
        metadata: {
          ...EMPTY_META,
          title: 'Tour',
          artists: ['Demo'],
          composers: ['JC'],
          lyricists: ['JL'],
          arrangers: ['JA'],
          album: 'Reference',
          year: '2026',
          key: 'G',
          keys: ['G'],
          capo: '2',
          tempo: '120',
          tempos: ['120'],
          time: '4/4',
          times: ['4/4'],
          duration: '3:30',
          copyright: '© 2026',
          tags: ['demo', 'reference'],
        },
        lines: [],
      }),
    );
    // Tier 1 — attribution.
    const attribution = container.querySelector('.meta--attribution');
    expect(attribution?.textContent).toContain('Demo');
    const secondaryAttribution = container.querySelector(
      '.meta--attribution-secondary',
    );
    expect(secondaryAttribution?.textContent).toContain('Composer JC');
    expect(secondaryAttribution?.textContent).toContain('Lyrics JL');
    expect(secondaryAttribution?.textContent).toContain('Arranger JA');
    // Tier 2 — chips. `{key}` / `{tempo}` / `{time}` are now
    // surfaced inline (positional `.meta-inline` markers), so
    // only `{capo}` and `{duration}` remain in the chip row.
    const chips = container.querySelectorAll('.meta--params .meta__chip');
    const chipTexts = Array.from(chips).map((c) => c.textContent);
    expect(chipTexts).toEqual(['Capo 2', '3:30']);
    // Tier 3 — supplementary.
    const supp = container.querySelector('.meta--supplementary');
    expect(supp?.textContent).toContain('Reference');
    expect(supp?.textContent).toContain('2026');
    expect(supp?.textContent).toContain('© 2026');
    // Tier 4 — tags.
    const tagRow = container.querySelector('.meta--tags');
    expect(tagRow).not.toBeNull();
    const tags = tagRow?.querySelectorAll('.tag');
    expect(tags?.length).toBe(2);
    expect(tags?.[0]?.textContent).toBe('demo');
    expect(tags?.[1]?.textContent).toBe('reference');
  });

  test('renders the metadata header in tiered rows', () => {
    const { container } = render(
      renderChordproAst({
        metadata: {
          ...EMPTY_META,
          title: 'My Song',
          subtitles: ['A subtitle'],
          artists: ['Artist'],
          key: 'G',
          keys: ['G'],
          capo: '2',
        },
        lines: [],
      }),
    );
    expect(container.querySelector('h1')?.textContent).toBe('My Song');
    expect(container.querySelector('h2')?.textContent).toBe('A subtitle');
    // Attribution row lives in `.meta--attribution`; the
    // `.meta--params` row keeps only chips for metadata that
    // doesn't have a positional inline marker (Capo / Duration).
    // `{key}` is surfaced inline at its source position.
    expect(container.querySelector('.meta--attribution')?.textContent).toContain('Artist');
    const chipTexts = Array.from(
      container.querySelectorAll('.meta--params .meta__chip'),
    ).map((c) => c.textContent);
    expect(chipTexts).toEqual(['Capo 2']);
  });

  // Multi-value `{key}` / `{tempo}` / `{time}` are no longer
  // shown in the header chip strip — each declaration surfaces
  // at its source position via the `.meta-inline` marker.
  // Capo / Duration (no inline marker) stay in the chip row.
  test('multi-value {key} / {tempo} / {time} produce no header chips', () => {
    const { container } = render(
      renderChordproAst({
        metadata: {
          ...EMPTY_META,
          title: 'Multi-meter song',
          key: 'D',
          keys: ['G', 'D'],
          tempo: '140',
          tempos: ['120', '140'],
          time: '6/8',
          times: ['4/4', '6/8'],
          capo: '2',
          duration: '3:30',
        },
        lines: [],
      }),
    );
    const chipTexts = Array.from(
      container.querySelectorAll('.meta--params .meta__chip'),
    ).map((c) => c.textContent);
    // Only the no-inline-marker metadata (Capo, Duration) shows.
    expect(chipTexts).toEqual(['Capo 2', '3:30']);
  });

  // (Test removed: the joined key chip no longer exists — each
  // `{key}` declaration surfaces as its own positional inline
  // marker, and the marker's caret-highlight is covered by
  // other tests in this file.)

  // Phase B of #2454 — every `{key}` / `{tempo}` / `{time}`
  // declaration is rendered as a positional inline marker so a
  // reader can see *where* mid-song meta changes happen. Sister-
  // site to `crates/render-html/src/lib.rs::render_song_body_into`.
  test('renders inline meta markers at the source position of {key} / {tempo} / {time}', () => {
    const { container } = render(
      renderChordproAst({
        metadata: {
          ...EMPTY_META,
          keys: ['D'],
          tempos: ['140'],
          times: ['6/8'],
        },
        lines: [
          { kind: 'lyrics', value: { segments: [{ chord: null, text: 'before', spans: [] }] } },
          {
            kind: 'directive',
            value: { name: 'key', value: 'D', kind: { tag: 'key' }, selector: null },
          },
          { kind: 'lyrics', value: { segments: [{ chord: null, text: 'mid-1', spans: [] }] } },
          {
            kind: 'directive',
            value: { name: 'tempo', value: '140', kind: { tag: 'tempo' }, selector: null },
          },
          { kind: 'lyrics', value: { segments: [{ chord: null, text: 'mid-2', spans: [] }] } },
          {
            kind: 'directive',
            value: { name: 'time', value: '6/8', kind: { tag: 'time' }, selector: null },
          },
          { kind: 'lyrics', value: { segments: [{ chord: null, text: 'after', spans: [] }] } },
        ],
      }),
    );
    const markers = Array.from(container.querySelectorAll('.meta-inline'));
    expect(markers).toHaveLength(3);
    // Order matches source order. Each marker carries its
    // music-notation glyph next to the textual label + value;
    // assertions target the structural pieces (label / value
    // spans) rather than the concatenated `textContent` so the
    // glyph's own labels (stacked digits, aria text) don't leak
    // into the equality check.
    expect(markers[0]?.classList.contains('meta-inline--key')).toBe(true);
    expect(markers[0]?.querySelector('.music-glyph--key')).not.toBeNull();
    expect(markers[0]?.querySelector('.meta-inline__label')?.textContent).toBe('Key:');
    expect(markers[0]?.querySelector('.meta-inline__value')?.textContent).toBe('D');

    expect(markers[1]?.classList.contains('meta-inline--tempo')).toBe(true);
    expect(markers[1]?.querySelector('.music-glyph--metronome')).not.toBeNull();
    // The "Tempo:" textual label was removed — the metronome glyph
    // carries the signal on its own. The value carries both the
    // numeric BPM and the conventional Italian marking in parens
    // (140 BPM ≈ Allegro).
    expect(markers[1]?.querySelector('.meta-inline__label')).toBeNull();
    expect(markers[1]?.querySelector('.meta-inline__value')?.textContent).toBe(
      '140 BPM (Allegro)',
    );
    expect(markers[1]?.querySelector('.meta-inline__marking')?.textContent?.trim()).toBe(
      '(Allegro)',
    );

    expect(markers[2]?.classList.contains('meta-inline--time')).toBe(true);
    expect(markers[2]?.querySelector('.music-glyph--time')).not.toBeNull();
    expect(markers[2]?.querySelector('.meta-inline__label')?.textContent).toBe('Time:');
    // The time-signature marker uses the icon as its value — the
    // stacked 6 / 8 glyph IS the "6/8" display, so no redundant
    // textual `meta-inline__value` is emitted alongside.
    expect(markers[2]?.querySelector('.meta-inline__value')).toBeNull();
    // Numerator / denominator both reachable via the glyph DOM.
    expect(markers[2]?.querySelector('.music-glyph--time__num')?.textContent).toBe('6');
    expect(markers[2]?.querySelector('.music-glyph--time__den')?.textContent).toBe('8');
  });

  test('drops the inline meta marker when the directive value is empty', () => {
    const { container } = render(
      renderChordproAst({
        metadata: EMPTY_META,
        lines: [
          {
            kind: 'directive',
            value: { name: 'key', value: '', kind: { tag: 'key' }, selector: null },
          },
          {
            kind: 'directive',
            value: { name: 'key', value: '   ', kind: { tag: 'key' }, selector: null },
          },
        ],
      }),
    );
    expect(container.querySelector('.meta-inline')).toBeNull();
  });

  test('wraps section directives in a `<section>` with the section-label', () => {
    const { container } = render(
      renderChordproAst({
        metadata: EMPTY_META,
        lines: [
          {
            kind: 'directive',
            value: {
              name: 'start_of_chorus',
              value: null,
              kind: { tag: 'startOfChorus' },
              selector: null,
            },
          },
          {
            kind: 'lyrics',
            value: {
              segments: [{ chord: null, text: 'In the chorus', spans: [] }],
            },
          },
          {
            kind: 'directive',
            value: {
              name: 'end_of_chorus',
              value: null,
              kind: { tag: 'endOfChorus' },
              selector: null,
            },
          },
        ],
      }),
    );
    const section = container.querySelector('section.chorus');
    expect(section).not.toBeNull();
    expect(section?.querySelector('.section-label')?.textContent).toBe('Chorus');
    expect(section?.querySelector('.line .lyrics')?.textContent).toBe('In the chorus');
  });

  test('{chorus} recall replays the most-recent chorus body', () => {
    // Mirrors `chordsketch-render-html`'s `{chorus}` directive
    // behaviour: a bodyless `{chorus}` emits a
    // `<div class="chorus-recall">` containing a label + a fresh
    // copy of the previously declared chorus's children. The
    // walker tracks `lastChorusBody` per song so multiple
    // recalls on the same song reuse the same source.
    const { container } = render(
      renderChordproAst({
        metadata: EMPTY_META,
        lines: [
          // First, declare the chorus
          {
            kind: 'directive',
            value: {
              name: 'start_of_chorus',
              value: 'Chorus',
              kind: { tag: 'startOfChorus' },
              selector: null,
            },
          },
          {
            kind: 'lyrics',
            value: {
              segments: [{ chord: null, text: 'chorus body line', spans: [] }],
            },
          },
          {
            kind: 'directive',
            value: {
              name: 'end_of_chorus',
              value: null,
              kind: { tag: 'endOfChorus' },
              selector: null,
            },
          },
          // Then a bodyless recall
          {
            kind: 'directive',
            value: {
              name: 'chorus',
              value: null,
              kind: { tag: 'chorus' },
              selector: null,
            },
          },
        ],
      }),
    );
    const recall = container.querySelector('.chorus-recall');
    expect(recall).not.toBeNull();
    expect(recall?.querySelector('.section-label')?.textContent).toBe('Chorus');
    // The replayed body should land inside the recall wrapper as
    // a `.line` containing the chorus body's text.
    expect(recall?.querySelector('.line .lyrics')?.textContent).toBe('chorus body line');
  });

  test('{chorus} recall with no prior chorus emits a label-only placeholder', () => {
    // Edge case — a `{chorus}` directive that appears before any
    // chorus has been declared. The walker has nothing to replay
    // and falls back to the label-only form.
    const { container } = render(
      renderChordproAst({
        metadata: EMPTY_META,
        lines: [
          {
            kind: 'directive',
            value: {
              name: 'chorus',
              value: 'Refrain',
              kind: { tag: 'chorus' },
              selector: null,
            },
          },
        ],
      }),
    );
    const recall = container.querySelector('.chorus-recall');
    expect(recall).not.toBeNull();
    expect(recall?.querySelector('.section-label')?.textContent).toBe('Refrain');
    expect(recall?.querySelector('.line')).toBeNull();
  });

  test('renders comment lines with the right classes', () => {
    const { container } = render(
      renderChordproAst({
        metadata: EMPTY_META,
        lines: [
          { kind: 'comment', style: 'normal', text: 'plain comment' },
          { kind: 'comment', style: 'italic', text: 'italic comment' },
          { kind: 'comment', style: 'boxed', text: 'boxed comment' },
          { kind: 'comment', style: 'highlight', text: 'highlight comment' },
        ],
      }),
    );
    // `.comment` selector covers normal, italic, and highlight (boxed
    // uses `<div class="comment-box">` instead).
    const comments = container.querySelectorAll('p.comment');
    expect(comments.length).toBe(3);
    expect(comments[0]?.textContent).toBe('plain comment');
    expect(comments[1]?.querySelector('em')?.textContent).toBe('italic comment');
    expect(container.querySelector('.comment-box')?.textContent).toBe('boxed comment');
    // `{highlight}` is the spec sibling of `{comment}` — same `<p>`
    // shape but with a `comment--highlight` modifier so consumer
    // stylesheets paint it distinctly.
    const highlight = container.querySelector('p.comment--highlight');
    expect(highlight).not.toBeNull();
    expect(highlight?.textContent).toBe('highlight comment');
    // Make sure it doesn't carry the italic wrapper or the boxed
    // class — visually it should be its own treatment.
    expect(highlight?.querySelector('em')).toBeNull();
    expect(highlight?.classList.contains('comment-box')).toBe(false);
  });

  function renderImageWithSrc(src: string): HTMLElement {
    const { container } = render(
      renderChordproAst({
        metadata: EMPTY_META,
        lines: [
          {
            kind: 'directive',
            value: {
              name: 'image',
              value: null,
              kind: {
                tag: 'image',
                value: {
                  src,
                  width: null,
                  height: null,
                  scale: null,
                  title: null,
                  anchor: null,
                },
              },
              selector: null,
            },
          },
        ],
      }),
    );
    return container as HTMLElement;
  }

  // Sister-site coverage to
  // `crates/render-html/src/lib.rs::has_dangerous_uri_scheme` —
  // each entry in the walker's `DANGEROUS_URI_SCHEMES` MUST have
  // a rejection test (`.claude/rules/sanitizer-security.md`
  // §"Testing completeness"). Adding a new entry to the Rust
  // list requires the same here.
  test.each([
    ['javascript:alert(1)'],
    ['vbscript:msgbox(1)'],
    ['data:text/html,<script>alert(1)</script>'],
    ['file:///etc/passwd'],
    ['blob:http://evil.example/abc'],
    ['mhtml:file://C:/page.mhtml'],
  ])('blocks dangerous URI scheme: %s', (src) => {
    const container = renderImageWithSrc(src);
    expect(container.querySelector('img')).toBeNull();
  });

  // Mixed-case + obfuscation regression guard — the Rust
  // sanitiser strips ASCII whitespace / control / Unicode
  // invisible-format chars before the prefix check; the JS port
  // must too. A regression that drops the obfuscation filter
  // would otherwise let `JAVA<ZWSP>SCRIPT:` through.
  test.each([
    ['JAVASCRIPT:alert(1)'],
    ['  javascript:alert(1)'],
    ['java​script:alert(1)'], // ZWSP between java and script
    ['java\tscript:alert(1)'],
    ['java‮script:alert(1)'], // RLO override
  ])('blocks obfuscated dangerous URI: %s', (src) => {
    const container = renderImageWithSrc(src);
    expect(container.querySelector('img')).toBeNull();
  });

  // Unicode-whitespace prefix bypass — `str::trim_start` on the
  // Rust side strips the full `White_Space` property, not just
  // ASCII. A regression in the JS port that only `.trim()`-ed or
  // only stripped ASCII whitespace would let these through.
  test.each([
    [' javascript:alert(1)'], // NBSP
    [' vbscript:msgbox(1)'], // LSEP
    ['　data:text/html,<script>x</script>'], // ideographic space
    ['﻿javascript:alert(1)'], // BOM (handled by invisible-format strip)
    ['javascript:alert(1)'], // VT — in `char::is_whitespace`, not `is_ascii_whitespace`
  ])('blocks Unicode-whitespace-prefixed dangerous URI: %s', (src) => {
    const container = renderImageWithSrc(src);
    expect(container.querySelector('img')).toBeNull();
  });

  test('lets safe URI schemes through (https, relative, fragment)', () => {
    for (const src of ['https://example.com/cover.png', 'photo.jpg', '#chord-diagrams']) {
      const container = renderImageWithSrc(src);
      const img = container.querySelector('img');
      expect(img).not.toBeNull();
      expect(img?.getAttribute('src')).toBe(src);
    }
  });

  // Sister-site to `crates/render-html/src/lib.rs::render_image`,
  // which writes `width="64" height="64"` as HTML attributes. The
  // walker MUST do the same — passing unit-less numeric strings to
  // React's `style.width` produces invalid CSS the browser drops,
  // so the rendered image ignored the requested box.
  test('width/height land on the <img> as HTML attributes', () => {
    const { container } = render(
      renderChordproAst({
        metadata: EMPTY_META,
        lines: [
          {
            kind: 'directive',
            value: {
              name: 'image',
              value: null,
              kind: {
                tag: 'image',
                value: {
                  src: 'https://example.com/logo.svg',
                  width: '64',
                  height: '64',
                  scale: null,
                  title: 'Logo',
                  anchor: null,
                },
              },
              selector: null,
            },
          },
        ],
      }),
    );
    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    expect(img?.getAttribute('width')).toBe('64');
    expect(img?.getAttribute('height')).toBe('64');
    // Inline style must NOT be set — the previous path that set
    // `style.width="64"` (no unit) silently broke sizing.
    expect(img?.getAttribute('style')).toBeNull();
  });

  test('omits width/height attributes when not provided', () => {
    const container = renderImageWithSrc('https://example.com/cover.png');
    const img = container.querySelector('img');
    expect(img?.hasAttribute('width')).toBe(false);
    expect(img?.hasAttribute('height')).toBe(false);
  });

  test('renders highlight / inline-comment / styled span variants', () => {
    const { container } = render(
      renderChordproAst({
        metadata: EMPTY_META,
        lines: [
          {
            kind: 'lyrics',
            value: {
              segments: [
                {
                  chord: null,
                  text: 'sample',
                  spans: [
                    { kind: 'highlight', children: [{ kind: 'plain', value: 'h!' }] },
                    { kind: 'comment', children: [{ kind: 'plain', value: 'cmt' }] },
                    {
                      kind: 'span',
                      attributes: {
                        fontFamily: 'Courier New',
                        size: '14pt',
                        foreground: '#f00',
                        background: '#ff0',
                        weight: 'bold',
                        style: 'italic',
                      },
                      children: [{ kind: 'plain', value: 'styled' }],
                    },
                  ],
                },
              ],
            },
          },
        ],
      }),
    );
    expect(container.querySelector('mark')?.textContent).toBe('h!');
    // Inline comment renders as `<span class="comment">`, mirroring
    // `chordsketch-render-html`'s `TextSpan::Comment` arm.
    const comment = container.querySelector('.lyrics span.comment');
    expect(comment?.textContent).toBe('cmt');
    const styled = container.querySelector('.lyrics span[style]') as HTMLElement | null;
    expect(styled?.textContent).toBe('styled');
    // jsdom lowercases generic font-family idents (`Serif` →
    // `serif`), so use a non-generic family that survives the
    // round-trip.
    expect(styled?.style.fontFamily).toBe('Courier New');
    expect(styled?.style.fontWeight).toBe('bold');
    expect(styled?.style.fontStyle).toBe('italic');
  });

  test('wraps custom-section directives in `<section class="section-<sanitized>">`', () => {
    const { container } = render(
      renderChordproAst({
        metadata: EMPTY_META,
        lines: [
          {
            kind: 'directive',
            value: {
              name: 'start_of_my custom!section',
              value: null,
              kind: { tag: 'startOfSection', value: 'my custom!section' },
              selector: null,
            },
          },
          {
            kind: 'lyrics',
            value: {
              segments: [{ chord: null, text: 'inside', spans: [] }],
            },
          },
          {
            kind: 'directive',
            value: {
              name: 'end_of_section',
              value: null,
              kind: { tag: 'endOfSection', value: 'my custom!section' },
              selector: null,
            },
          },
        ],
      }),
    );
    // Class prefix `section-` + non-alphanumeric chars (space, `!`)
    // replaced by `-`. Mirrors `sanitize_css_class` in
    // `chordsketch-render-html`.
    const section = container.querySelector('section.section-my-custom-section');
    expect(section).not.toBeNull();
    expect(section?.querySelector('.line .lyrics')?.textContent).toBe('inside');
  });

  test('delegate-section directives wrap content with the documented default label', () => {
    const { container } = render(
      renderChordproAst({
        metadata: EMPTY_META,
        lines: [
          {
            kind: 'directive',
            value: {
              name: 'start_of_abc',
              value: null,
              kind: { tag: 'startOfAbc' },
              selector: null,
            },
          },
          {
            kind: 'lyrics',
            value: {
              segments: [{ chord: null, text: 'C: tune', spans: [] }],
            },
          },
          {
            kind: 'directive',
            value: {
              name: 'end_of_abc',
              value: null,
              kind: { tag: 'endOfAbc' },
              selector: null,
            },
          },
        ],
      }),
    );
    const section = container.querySelector('section.abc');
    expect(section).not.toBeNull();
    // Mirrors `chordsketch-render-html`'s `render_section_open("abc", "ABC", …)` —
    // sister-site parity per `.claude/rules/renderer-parity.md`.
    expect(section?.querySelector('.section-label')?.textContent).toBe('ABC');
    expect(section?.querySelector('.line .lyrics')?.textContent).toBe('C: tune');
  });

  test('renders empty lines as `.empty-line`', () => {
    const { container } = render(
      renderChordproAst({
        metadata: EMPTY_META,
        lines: [{ kind: 'empty' }, { kind: 'empty' }],
      }),
    );
    expect(container.querySelectorAll('.empty-line').length).toBe(2);
  });

  test('renders inline span markup as nested HTML', () => {
    const { container } = render(
      renderChordproAst({
        metadata: EMPTY_META,
        lines: [
          {
            kind: 'lyrics',
            value: {
              segments: [
                {
                  chord: null,
                  text: 'Hello world',
                  spans: [
                    {
                      kind: 'bold',
                      children: [{ kind: 'plain', value: 'Hello ' }],
                    },
                    {
                      kind: 'italic',
                      children: [{ kind: 'plain', value: 'world' }],
                    },
                  ],
                },
              ],
            },
          },
        ],
      }),
    );
    const lyrics = container.querySelector('.lyrics');
    // Walker emits `<b>` / `<i>` to mirror
    // `chordsketch-render-html`'s element choice byte-for-byte
    // (sister-site parity per `.claude/rules/renderer-parity.md`).
    expect(lyrics?.querySelector('b')?.textContent).toBe('Hello ');
    expect(lyrics?.querySelector('i')?.textContent).toBe('world');
  });

  test('uses the chord display override when set', () => {
    const { container } = render(
      renderChordproAst({
        metadata: EMPTY_META,
        lines: [
          {
            kind: 'lyrics',
            value: {
              segments: [
                {
                  chord: { name: 'Am', detail: null, display: 'A−' },
                  text: 'x',
                  spans: [],
                },
              ],
            },
          },
        ],
      }),
    );
    expect(container.querySelector('.chord')?.textContent).toBe('A−');
  });

  // ---- Group D: font / size / colour directives ------------------------
  //
  // The walker mirrors `chordsketch-render-html`'s `FormattingState`
  // state machine — a `{textfont}` / `{chordsize}` / etc. directive
  // mutates the running style, and every line emitted afterwards
  // picks up an inline style on the matching element. Sister-site
  // parity per `.claude/rules/renderer-parity.md` and
  // `.claude/rules/fix-propagation.md`.

  test('{textfont} / {textsize} / {textcolour} apply to lyric .lyrics spans', () => {
    const { container } = render(
      renderChordproAst({
        metadata: EMPTY_META,
        lines: [
          {
            kind: 'directive',
            value: {
              name: 'textfont',
              value: 'Courier New',
              kind: { tag: 'textFont' },
              selector: null,
            },
          },
          {
            kind: 'directive',
            value: {
              name: 'textsize',
              value: '14',
              kind: { tag: 'textSize' },
              selector: null,
            },
          },
          {
            kind: 'directive',
            value: {
              name: 'textcolour',
              value: 'red',
              kind: { tag: 'textColour' },
              selector: null,
            },
          },
          {
            kind: 'lyrics',
            value: {
              segments: [{ chord: null, text: 'styled', spans: [] }],
            },
          },
        ],
      }),
    );
    const lyrics = container.querySelector('.lyrics') as HTMLElement | null;
    expect(lyrics).not.toBeNull();
    expect(lyrics?.style.fontFamily).toBe('Courier New');
    // Bare numeric values clamp into the [0.5, 200] band and emit
    // as point sizes — matches the Rust renderer's
    // `sanitize_css_value` + bare-number fallback.
    expect(lyrics?.style.fontSize).toBe('14pt');
    expect(lyrics?.style.color).toBe('red');
  });

  test('{chordfont} / {chordsize} / {chordcolour} apply to .chord spans', () => {
    const { container } = render(
      renderChordproAst({
        metadata: EMPTY_META,
        lines: [
          {
            kind: 'directive',
            value: {
              name: 'chordfont',
              value: 'Courier New',
              kind: { tag: 'chordFont' },
              selector: null,
            },
          },
          {
            kind: 'directive',
            value: {
              name: 'chordcolour',
              value: 'blue',
              kind: { tag: 'chordColour' },
              selector: null,
            },
          },
          {
            kind: 'lyrics',
            value: {
              segments: [
                {
                  chord: { name: 'G', detail: null, display: null },
                  text: 'hi',
                  spans: [],
                },
              ],
            },
          },
        ],
      }),
    );
    const chord = container.querySelector('.chord') as HTMLElement | null;
    expect(chord).not.toBeNull();
    expect(chord?.style.fontFamily).toBe('Courier New');
    expect(chord?.style.color).toBe('blue');
  });

  test('{titlefont} / {titlesize} / {titlecolour} apply to the <h1> title', () => {
    const { container } = render(
      renderChordproAst({
        metadata: { ...EMPTY_META, title: 'Styled Song' },
        lines: [
          {
            kind: 'directive',
            value: {
              name: 'titlefont',
              value: 'Courier New',
              kind: { tag: 'titleFont' },
              selector: null,
            },
          },
          {
            kind: 'directive',
            value: {
              name: 'titlesize',
              value: '32',
              kind: { tag: 'titleSize' },
              selector: null,
            },
          },
        ],
      }),
    );
    const h1 = container.querySelector('h1') as HTMLElement | null;
    expect(h1).not.toBeNull();
    expect(h1?.textContent).toBe('Styled Song');
    expect(h1?.style.fontFamily).toBe('Courier New');
    expect(h1?.style.fontSize).toBe('32pt');
  });

  test('title style is pinned at file start — post-lyrics directives do not affect <h1>', () => {
    // `computeHeaderFormattingState` only consumes directives that
    // appear BEFORE the first lyric / section / comment line. This
    // mirrors the Rust renderer's emit order — the header lands
    // first, before any in-body directive has had a chance to fire.
    const { container } = render(
      renderChordproAst({
        metadata: { ...EMPTY_META, title: 'Song' },
        lines: [
          {
            kind: 'lyrics',
            value: { segments: [{ chord: null, text: 'lyric', spans: [] }] },
          },
          {
            kind: 'directive',
            value: {
              name: 'titlecolour',
              value: 'red',
              kind: { tag: 'titleColour' },
              selector: null,
            },
          },
        ],
      }),
    );
    const h1 = container.querySelector('h1') as HTMLElement | null;
    expect(h1?.style.color).toBe('');
  });

  test('{labelfont} / {labelcolour} apply to .section-label inside <section>', () => {
    const { container } = render(
      renderChordproAst({
        metadata: EMPTY_META,
        lines: [
          {
            kind: 'directive',
            value: {
              name: 'labelcolour',
              value: 'green',
              kind: { tag: 'labelColour' },
              selector: null,
            },
          },
          {
            kind: 'directive',
            value: {
              name: 'start_of_verse',
              value: 'Verse',
              kind: { tag: 'startOfVerse' },
              selector: null,
            },
          },
          {
            kind: 'lyrics',
            value: { segments: [{ chord: null, text: 'v', spans: [] }] },
          },
          {
            kind: 'directive',
            value: {
              name: 'end_of_verse',
              value: null,
              kind: { tag: 'endOfVerse' },
              selector: null,
            },
          },
        ],
      }),
    );
    const label = container.querySelector('section.verse .section-label') as HTMLElement | null;
    expect(label).not.toBeNull();
    expect(label?.style.color).toBe('green');
  });

  test('{choruscolour} applies to the chorus <section> wrapper', () => {
    const { container } = render(
      renderChordproAst({
        metadata: EMPTY_META,
        lines: [
          {
            kind: 'directive',
            value: {
              name: 'choruscolour',
              value: 'orange',
              kind: { tag: 'chorusColour' },
              selector: null,
            },
          },
          {
            kind: 'directive',
            value: {
              name: 'start_of_chorus',
              value: null,
              kind: { tag: 'startOfChorus' },
              selector: null,
            },
          },
          {
            kind: 'lyrics',
            value: { segments: [{ chord: null, text: 'c', spans: [] }] },
          },
          {
            kind: 'directive',
            value: {
              name: 'end_of_chorus',
              value: null,
              kind: { tag: 'endOfChorus' },
              selector: null,
            },
          },
        ],
      }),
    );
    const section = container.querySelector('section.chorus') as HTMLElement | null;
    expect(section).not.toBeNull();
    expect(section?.style.color).toBe('orange');
  });

  test('{tabfont} applies to lyrics inside section.tab; .grid mirrors {gridfont}', () => {
    // Inside a `section.tab`, the body picks up the `.tab`
    // element style (not `.text`). Same shape for `section.grid` /
    // `.grid`. Mirrors `chordsketch-render-html`'s per-section
    // style override.
    const { container } = render(
      renderChordproAst({
        metadata: EMPTY_META,
        lines: [
          {
            kind: 'directive',
            value: {
              name: 'tabfont',
              value: 'Courier New',
              kind: { tag: 'tabFont' },
              selector: null,
            },
          },
          {
            kind: 'directive',
            value: {
              name: 'start_of_tab',
              value: null,
              kind: { tag: 'startOfTab' },
              selector: null,
            },
          },
          {
            kind: 'lyrics',
            value: { segments: [{ chord: null, text: 'tabbed', spans: [] }] },
          },
          {
            kind: 'directive',
            value: {
              name: 'end_of_tab',
              value: null,
              kind: { tag: 'endOfTab' },
              selector: null,
            },
          },
        ],
      }),
    );
    const lyrics = container.querySelector('section.tab .lyrics') as HTMLElement | null;
    expect(lyrics).not.toBeNull();
    expect(lyrics?.style.fontFamily).toBe('Courier New');
  });

  test('in-chorus formatting directives are scoped — restored on {end_of_chorus}', () => {
    // The walker captures `ctx.fmt` on `{start_of_chorus}` and
    // restores on `{end_of_chorus}` so in-chorus style overrides
    // don't leak into subsequent verses. Sister-site parity with
    // the Rust renderer's save/restore.
    const { container } = render(
      renderChordproAst({
        metadata: EMPTY_META,
        lines: [
          {
            kind: 'directive',
            value: {
              name: 'start_of_chorus',
              value: null,
              kind: { tag: 'startOfChorus' },
              selector: null,
            },
          },
          {
            kind: 'directive',
            value: {
              name: 'textcolour',
              value: 'red',
              kind: { tag: 'textColour' },
              selector: null,
            },
          },
          {
            kind: 'lyrics',
            value: { segments: [{ chord: null, text: 'inside', spans: [] }] },
          },
          {
            kind: 'directive',
            value: {
              name: 'end_of_chorus',
              value: null,
              kind: { tag: 'endOfChorus' },
              selector: null,
            },
          },
          {
            kind: 'lyrics',
            value: { segments: [{ chord: null, text: 'after', spans: [] }] },
          },
        ],
      }),
    );
    const inside = container.querySelector(
      'section.chorus .lyrics',
    ) as HTMLElement | null;
    expect(inside?.style.color).toBe('red');
    // The trailing lyric line lives outside the section — pick it
    // up from the top-level `.song` body, not from the chorus
    // section.
    const after = container.querySelectorAll(
      '.song > .line .lyrics',
    )[0] as HTMLElement | undefined;
    expect(after).toBeDefined();
    expect(after?.textContent).toBe('after');
    expect(after?.style.color).toBe('');
  });

  test('font-size directive value clamps into the [0.5, 200] band', () => {
    // `clampSize` mirrors the Rust renderer's clamp — 99999 falls
    // back to 200, -42 to 0.5. Both end up as point sizes via the
    // bare-numeric path in `elementStyleToCss`.
    const { container } = render(
      renderChordproAst({
        metadata: EMPTY_META,
        lines: [
          {
            kind: 'directive',
            value: {
              name: 'textsize',
              value: '99999',
              kind: { tag: 'textSize' },
              selector: null,
            },
          },
          {
            kind: 'lyrics',
            value: { segments: [{ chord: null, text: 'huge', spans: [] }] },
          },
        ],
      }),
    );
    const lyrics = container.querySelector('.lyrics') as HTMLElement | null;
    expect(lyrics?.style.fontSize).toBe('200pt');
  });

  test('CSS-value sanitiser drops unsafe characters from directive payloads', () => {
    // Sister-site to `sanitize_css_value` in the Rust renderer —
    // a payload like `red;background:url(x)` must NOT smuggle the
    // `;` or `(` through to the inline style. Anything outside
    // `[A-Za-z0-9# . - <space> , % +]` is stripped.
    const { container } = render(
      renderChordproAst({
        metadata: EMPTY_META,
        lines: [
          {
            kind: 'directive',
            value: {
              name: 'textcolour',
              value: 'red;background:url(x)',
              kind: { tag: 'textColour' },
              selector: null,
            },
          },
          {
            kind: 'lyrics',
            value: { segments: [{ chord: null, text: 'x', spans: [] }] },
          },
        ],
      }),
    );
    const lyrics = container.querySelector('.lyrics') as HTMLElement | null;
    // After sanitisation `;`, `:`, `(`, `)` are dropped — the
    // surviving payload contains only safe characters. The
    // browser may or may not accept it as a colour, but the
    // sanitiser's job is to keep the inline-style string syntax
    // intact; what we assert here is that the dangerous tokens
    // never reach the DOM.
    const color = lyrics?.style.color ?? '';
    expect(color).not.toContain(';');
    expect(color).not.toContain(':');
    expect(color).not.toContain('(');
    expect(color).not.toContain(')');
  });
});
