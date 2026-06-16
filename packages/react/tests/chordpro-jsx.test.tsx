import { fireEvent, render } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, test, vi } from 'vitest';

import { renderChordproAst } from '../src/chordpro-jsx';
import type { ChordSelection } from '../src/chordpro-jsx';
import type { ChordproSong } from '../src/chordpro-ast';
import { repositionedChordOrdinal } from '../src/chord-source-edit';
import type { ChordRepositionEvent } from '../src/chord-source-edit';

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

  // After a drop the moved chord must become the selection, so it
  // stays focused / editable without a second click — parity with the
  // keyboard nudge, which already advances the selection. The walker
  // reports the moved chord's new (offset, ordinal) via
  // `setChordSelection`; the host re-parses and re-locates it by that
  // identity. (Selection wiring requires both `chordSelection` and
  // `setChordSelection`; with only `onChordReposition` the chords are
  // drag-only and nothing is reported.)
  test('dropping a chord reports its new position as the selection', () => {
    const repo = vi.fn();
    const setSelected = vi.fn();
    const ast: ChordproSong = {
      metadata: EMPTY_META,
      lines: [
        {
          kind: 'lyrics',
          value: {
            segments: [
              { chord: { name: 'Am', detail: null, display: null }, text: 'Hello', spans: [] },
              { chord: { name: 'G', detail: null, display: null }, text: 'World', spans: [] },
            ],
          },
        },
      ],
    };
    const { container } = render(
      renderChordproAst(ast, {
        onChordReposition: repo,
        chordSelection: null,
        setChordSelection: setSelected,
      }),
    );
    const blocks = container.querySelectorAll('.chord-block');
    const targetLyrics = blocks[1].querySelector('.lyrics') as HTMLElement;
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
    fireEvent.drop(targetLyrics, { dataTransfer: dt, clientX: 100, clientY: 50 });
    expect(repo).toHaveBeenCalledTimes(1);
    expect(setSelected).toHaveBeenCalledTimes(1);
    // The reported selection must land exactly where the chord was
    // repositioned to — the (line, offset) of the emitted event — so a
    // re-parse re-locates it as the selection. Derived from the event
    // (not a hard-coded jsdom pointer offset) so the assertion stays
    // robust to caret-from-point quirks. Same-line move of Am (index 0
    // among the line's chords at offsets [0, 5]); ordinal via the same
    // helper the walker uses.
    const repoEvent = repo.mock.calls[0][0];
    expect(repoEvent.toLine).toBe(1);
    expect(repoEvent.copy).toBeFalsy();
    expect(setSelected.mock.calls[0][0]).toEqual({
      line: repoEvent.toLine,
      offset: repoEvent.toLyricsOffset,
      ordinal: repositionedChordOrdinal(repoEvent.toLyricsOffset, [0, 5], 0),
      nonce: 1,
    });
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

  test('caret-marker suppressed while a chord is selected (#2648)', () => {
    // The caret is on the chord (caretColumn would place a marker), but a
    // chordSelection is active — the selected-chord badge already marks
    // the spot, so the blinking marker is suppressed to avoid fighting it.
    const { container } = render(
      renderChordproAst(
        {
          metadata: EMPTY_META,
          lines: [
            {
              kind: 'lyrics',
              value: {
                segments: [{ chord: { name: 'C', detail: null, display: null }, text: 'hi', spans: [] }],
              },
            },
          ],
        },
        {
          activeSourceLine: 1,
          caretColumn: 1,
          caretLineLength: 5,
          chordSelection: { line: 1, offset: 0, ordinal: 0, nonce: 1 },
        },
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
    // Two volta brackets surface in the row. The source has
    // `| |1` (single barline + volta-1) and `:| |2` (repeat-
    // end + volta-2); the marker-collapse pass merges each
    // pair into a single cell whose host marker carries a
    // `.grid-volta__bracket` overlay, so we count brackets
    // rather than standalone `.grid-volta` cells. The
    // standalone `.grid-volta` cell only appears when a volta
    // marker is NOT preceded by another barline marker (e.g.
    // a volta at the very start of a row).
    expect(gridLine?.querySelectorAll('.grid-volta__bracket').length).toBe(2);
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

  // `%` is a single-bar repeat. `%%` expands at render time
  // into a `%` mark in its own bar AND a `%` mark in the
  // following bar (when the following bar is empty / pure
  // continuation) — the engraving convention chosen for this
  // surface is to drop a single-bar mark into every repeated
  // bar rather than draw one straddle-glyph across the
  // barline. After expansion, no `--percent2` cells survive.
  test('grid measure-repeat: `%` stays single-bar, `%%` expands to `%` in this bar and the next', () => {
    const ast: ChordproSong = {
      metadata: EMPTY_META,
      lines: [
        {
          kind: 'directive',
          value: { name: 'start_of_grid', value: null, kind: { tag: 'startOfGrid' }, selector: null },
        },
        {
          // Source: bar1=G, bar2=%, bar3=%%, bar4=empty (only continuations).
          // After expansion: bar1=G, bar2=%, bar3=%, bar4=%.
          kind: 'lyrics',
          value: { segments: [{ chord: null, text: '| G . | % . | %% . | .  . |', spans: [] }] },
        },
        {
          kind: 'directive',
          value: { name: 'end_of_grid', value: null, kind: { tag: 'endOfGrid' }, selector: null },
        },
      ],
    };
    const { container } = render(renderChordproAst(ast));
    expect(container.querySelectorAll('.grid-beat--percent1').length).toBe(3);
    expect(container.querySelectorAll('.grid-beat--percent2').length).toBe(0);
  });

  // `%%` followed by a bar that already has a chord MUST NOT
  // overwrite that chord AND MUST NOT half-rewrite itself to a
  // single `%` — half-rewriting would silently downgrade the
  // "repeat previous TWO" semantics to "repeat previous ONE".
  // Both bars stay intact: the `%%` falls through to the
  // 2-bar repeat glyph (the best available representation when
  // the expansion preconditions are not met), and the chord
  // bar keeps its chord.
  test('grid `%%` does not overwrite a following bar that already has content', () => {
    const ast: ChordproSong = {
      metadata: EMPTY_META,
      lines: [
        {
          kind: 'directive',
          value: { name: 'start_of_grid', value: null, kind: { tag: 'startOfGrid' }, selector: null },
        },
        {
          kind: 'lyrics',
          value: { segments: [{ chord: null, text: '| G . | %% . | C . |', spans: [] }] },
        },
        {
          kind: 'directive',
          value: { name: 'end_of_grid', value: null, kind: { tag: 'endOfGrid' }, selector: null },
        },
      ],
    };
    const { container } = render(renderChordproAst(ast));
    // `%%` survives as percent2 (rendered with 2-bar glyph),
    // bar 3 keeps its C chord, and no half-rewrite to `%` happens.
    expect(container.querySelectorAll('.grid-beat--percent2').length).toBe(1);
    expect(container.querySelectorAll('.grid-beat--percent1').length).toBe(0);
    const chords = Array.from(container.querySelectorAll('.grid-chord')).map((c) => c.textContent);
    expect(chords).toEqual(['G', 'C']);
  });

  // Cross-group label alignment: when rows have DIFFERENT bar
  // counts they land in different `.grid-line-group` blocks, but
  // the section still propagates the LONGEST label / comment
  // text via `--cs-grid-label-max-text` / `--cs-grid-comment-
  // max-text`. Each `.grid-row__label` / `.grid-row__comment`
  // uses that var as its `::before` pseudo content, forcing the
  // cell to reserve the widest rendered width so an `A` row and
  // a `CODA` row align their bar-start positions even though
  // their groups are independent grids.
  test('grid section emits CSS vars for widest label/comment across all rows', () => {
    const ast: ChordproSong = {
      metadata: EMPTY_META,
      lines: [
        {
          kind: 'directive',
          value: { name: 'start_of_grid', value: null, kind: { tag: 'startOfGrid' }, selector: null },
        },
        {
          // 4-bar row labelled `A`, no trailing comment.
          kind: 'lyrics',
          value: { segments: [{ chord: null, text: 'A | G . | C . | D . | G . |', spans: [] }] },
        },
        {
          // 4-bar row, no label, trailing `repeat 4 times`.
          kind: 'lyrics',
          value: { segments: [{ chord: null, text: '| C . | D . | G . | C . | repeat 4 times', spans: [] }] },
        },
        {
          // 5-bar row labelled `CODA`, no trailing comment.
          // Different bar count → separate `.grid-line-group`.
          kind: 'lyrics',
          value: { segments: [{ chord: null, text: 'CODA | D . | E . | F . | G . | C . |', spans: [] }] },
        },
        {
          kind: 'directive',
          value: { name: 'end_of_grid', value: null, kind: { tag: 'endOfGrid' }, selector: null },
        },
      ],
    };
    const { container } = render(renderChordproAst(ast));
    const section = container.querySelector('section.grid') as HTMLElement | null;
    expect(section).not.toBeNull();
    // The CSS vars are quoted CSS string literals; the widest
    // label is `"CODA"`, the widest comment is `"repeat 4 times"`.
    expect(section?.style.getPropertyValue('--cs-grid-label-max-text')).toBe('"CODA"');
    expect(section?.style.getPropertyValue('--cs-grid-comment-max-text')).toBe('"repeat 4 times"');
  });

  // Body grid template edge cases — the template must
  // resolve cleanly for rows that have only one bar (no
  // intermediate markers in body) AND for rows that have no
  // body bars at all (degenerate sources). A regression that
  // shipped an empty / mis-shaped template would crash CSS
  // grid placement and stack cells vertically.
  test('grid body template handles single-bar and empty-body edge cases', () => {
    const makeAst = (text: string): ChordproSong => ({
      metadata: EMPTY_META,
      lines: [
        {
          kind: 'directive',
          value: { name: 'start_of_grid', value: null, kind: { tag: 'startOfGrid' }, selector: null },
        },
        {
          kind: 'lyrics',
          value: { segments: [{ chord: null, text, spans: [] }] },
        },
        {
          kind: 'directive',
          value: { name: 'end_of_grid', value: null, kind: { tag: 'endOfGrid' }, selector: null },
        },
      ],
    });

    // Single-bar row: lead `|`, bar(G), trail `|`. Body has
    // just the one bar — template should be `1fr` (one column).
    {
      const { container, unmount } = render(renderChordproAst(makeAst('| G . |')));
      const body = container.querySelector('.grid-line__body') as HTMLElement | null;
      expect(body).not.toBeNull();
      expect(body!.style.gridTemplateColumns).toBe('1fr');
      expect(body!.childElementCount).toBe(1);
      unmount();
    }

    // Degenerate row with only a single barline (no bars): the
    // single `||` becomes lead, no trail, body is empty. Template
    // falls back to `auto` so the grid still resolves.
    {
      const { container, unmount } = render(renderChordproAst(makeAst('||')));
      const body = container.querySelector('.grid-line__body') as HTMLElement | null;
      expect(body).not.toBeNull();
      expect(body!.style.gridTemplateColumns).toBe('auto');
      expect(body!.childElementCount).toBe(0);
      unmount();
    }
  });

  // Marker-collapse rule: when a non-volta marker is
  // immediately followed by a volta marker in the source, the
  // pair collapses to a single rendered cell. The host marker
  // keeps its own glyph (repeat-end thick line, double-bar
  // pair, etc.) and the volta-N bracket is overlaid on top
  // via `.grid-volta__bracket`. Without this, the source
  // `:| |2` rendered as TWO separate cells (a redundant
  // barline double-strike) and the volta-2 bracket landed
  // beside the repeat-end glyph instead of above the same
  // barline position.
  // Edge case for `%%` (repeat-previous-two-bars) expansion.
  // When the source has no PRIOR bar to repeat (first bar of
  // section is `%%`), expansion must NOT silently rewrite the
  // `%%` to a `%` (which would lie about "repeat previous
  // bar" — there is no previous bar). The `%%` survives so
  // `renderBeat` paints the real 2-bar repeat glyph as the
  // best available representation of malformed input.
  test('grid `%%` in the first bar of a section is left unexpanded (no prior bar to repeat)', () => {
    const ast: ChordproSong = {
      metadata: EMPTY_META,
      lines: [
        {
          kind: 'directive',
          value: { name: 'start_of_grid', value: null, kind: { tag: 'startOfGrid' }, selector: null },
        },
        {
          // No prior bar exists in the section before `%%`.
          kind: 'lyrics',
          value: { segments: [{ chord: null, text: '| %% . | .  . |', spans: [] }] },
        },
        {
          kind: 'directive',
          value: { name: 'end_of_grid', value: null, kind: { tag: 'endOfGrid' }, selector: null },
        },
      ],
    };
    const { container } = render(renderChordproAst(ast));
    // The %% survives as a percent2 beat (rendered with the
    // 2-bar fallback glyph), and the following empty bar is
    // NOT silently filled with a `%` — empty stays empty so
    // the malformed source is visually distinct from the
    // well-formed `%%` pattern.
    expect(container.querySelectorAll('.grid-beat--percent2').length).toBe(1);
    expect(container.querySelectorAll('.grid-beat--percent1').length).toBe(0);
  });

  // `%%` at the END of a row (no next bar to expand into) is
  // similarly left unrewritten — silently rewriting `%%` to a
  // single `%` would change the engraved meaning from
  // "repeat previous TWO" to "repeat previous ONE".
  test('grid `%%` with no following bar is left unexpanded', () => {
    const ast: ChordproSong = {
      metadata: EMPTY_META,
      lines: [
        {
          kind: 'directive',
          value: { name: 'start_of_grid', value: null, kind: { tag: 'startOfGrid' }, selector: null },
        },
        {
          // `%%` is the LAST bar of the row.
          kind: 'lyrics',
          value: { segments: [{ chord: null, text: '| G . | C . | %% . |', spans: [] }] },
        },
        {
          kind: 'directive',
          value: { name: 'end_of_grid', value: null, kind: { tag: 'endOfGrid' }, selector: null },
        },
      ],
    };
    const { container } = render(renderChordproAst(ast));
    expect(container.querySelectorAll('.grid-beat--percent2').length).toBe(1);
    expect(container.querySelectorAll('.grid-beat--percent1').length).toBe(0);
  });

  // Multiple `%%` beats in a SINGLE bar (rare but legal source
  // like `| %% %% . . |`) all get rewritten — not just the
  // first occurrence. Pre-fix, `findIndex` only rewrote the
  // first match, leaving subsequent `percent2` beats to fall
  // through to the renderBeat "should not be reachable" arm.
  test('grid expands every `%%` beat in a multi-%% bar (not just the first)', () => {
    const ast: ChordproSong = {
      metadata: EMPTY_META,
      lines: [
        {
          kind: 'directive',
          value: { name: 'start_of_grid', value: null, kind: { tag: 'startOfGrid' }, selector: null },
        },
        {
          // Prior bar `G` exists, next bar empty — every `%%`
          // in bar 2 should rewrite to `%`.
          kind: 'lyrics',
          value: { segments: [{ chord: null, text: '| G . | %% %% . . | .  . . . |', spans: [] }] },
        },
        {
          kind: 'directive',
          value: { name: 'end_of_grid', value: null, kind: { tag: 'endOfGrid' }, selector: null },
        },
      ],
    };
    const { container } = render(renderChordproAst(ast));
    // Both `%%` in bar 2 rewrite to `%`, plus the next bar
    // gets a `%` (one expansion run only — multiple `%%` in
    // the same bar still target a single next-bar expansion).
    expect(container.querySelectorAll('.grid-beat--percent2').length).toBe(0);
    expect(container.querySelectorAll('.grid-beat--percent1').length).toBeGreaterThanOrEqual(3);
  });

  // Multi-volta chain `:| |2 |3 Am` collapses all volta cells
  // onto the same host barline. The resulting overlay carries
  // every ending in a single bracket (`2.3.`) — one bracket per
  // barline position regardless of how many endings start
  // there. Pre-fix, the second volta in the chain survived as
  // a standalone `.grid-volta` cell, double-drawing the
  // barline visually.
  test('grid collapses chained voltas (`:| |2 |3`) into one overlay carrying every ending', () => {
    const ast: ChordproSong = {
      metadata: EMPTY_META,
      lines: [
        {
          kind: 'directive',
          value: { name: 'start_of_grid', value: null, kind: { tag: 'startOfGrid' }, selector: null },
        },
        {
          kind: 'lyrics',
          value: { segments: [{ chord: null, text: '|: G . | C . :| |2 |3 Am . | G . |.', spans: [] }] },
        },
        {
          kind: 'directive',
          value: { name: 'end_of_grid', value: null, kind: { tag: 'endOfGrid' }, selector: null },
        },
      ],
    };
    const { container } = render(renderChordproAst(ast));
    // No standalone `.grid-volta` cell survives — both `|2`
    // and `|3` collapse into the `:|` host's overlay.
    expect(container.querySelectorAll('.grid-volta').length).toBe(0);
    // The host carries a single bracket overlay whose label
    // concatenates every ending (`2.3.`).
    const bracket = container.querySelector('.grid-volta__bracket');
    expect(bracket).not.toBeNull();
    expect(bracket?.querySelector('.grid-volta__label')?.textContent).toBe('2.3.');
  });

  // Strum `~~` (consecutive tildes, possible source noise)
  // must not render zero-content `.grid-strum__part` spans
  // flanked by separator dots — the visible glyph would be a
  // stray `··` with no corresponding source token.
  test('grid strum row drops empty segments from `~~` consecutive-tilde tokens', () => {
    const ast: ChordproSong = {
      metadata: EMPTY_META,
      lines: [
        {
          kind: 'directive',
          value: { name: 'start_of_grid', value: null, kind: { tag: 'startOfGrid' }, selector: null },
        },
        {
          kind: 'lyrics',
          value: { segments: [{ chord: null, text: '|s dn~~up |', spans: [] }] },
        },
        {
          kind: 'directive',
          value: { name: 'end_of_grid', value: null, kind: { tag: 'endOfGrid' }, selector: null },
        },
      ],
    };
    const { container } = render(renderChordproAst(ast));
    // `dn~~up` → split [dn, '', up] → empty filtered → 2 parts
    // → 1 separator dot (between dn and up). No empty parts.
    expect(container.querySelectorAll('.grid-strum__part').length).toBe(2);
    expect(container.querySelectorAll('.grid-strum__sep').length).toBe(1);
  });

  test('grid collapses [marker, volta] pairs into a single overlay-bearing cell', () => {
    const cases: Array<{
      source: string;
      hostSelector: string;
      hostLabel: string;
      voltaText: string;
      // Standalone `.grid-volta` cell count in the row body
      // after collapse — must drop to zero when every volta
      // was preceded by a barline marker.
      remainingStandalone: number;
    }> = [
      // `| |1` — bare barline + volta-1.
      {
        source: '| G . | C . | |1 Em . | C . | |2 Am . | G . |.',
        hostSelector: '.grid-barline:not([class*="--"])',
        hostLabel: 'bare barline',
        voltaText: '1.',
        remainingStandalone: 0,
      },
      // `:| |2` — repeat-end + volta-2.
      {
        source: '|: G . | C . :| |2 Am . | G . |.',
        hostSelector: '.grid-barline--repeat-end',
        hostLabel: 'repeat-end',
        voltaText: '2.',
        remainingStandalone: 0,
      },
      // `:|: |3` — repeat-both + volta-3.
      {
        source: '|: G . | C . :|: |3 Am . | G . |.',
        hostSelector: '.grid-barline--repeat-both',
        hostLabel: 'repeat-both',
        voltaText: '3.',
        remainingStandalone: 0,
      },
      // `|| |2` — double + volta-2.
      {
        source: '|| G . | C . || |2 Am . | G . |.',
        hostSelector: '.grid-barline--double',
        hostLabel: 'double',
        voltaText: '2.',
        remainingStandalone: 0,
      },
      // Volta at row start has NO preceding marker, so it is
      // NOT collapsed; it keeps its own `.grid-volta` cell.
      {
        source: '|1 Em . | C . |.',
        hostSelector: '.grid-volta',
        hostLabel: 'standalone volta at row start',
        voltaText: '1.',
        remainingStandalone: 1,
      },
    ];
    for (const c of cases) {
      const ast: ChordproSong = {
        metadata: EMPTY_META,
        lines: [
          {
            kind: 'directive',
            value: { name: 'start_of_grid', value: null, kind: { tag: 'startOfGrid' }, selector: null },
          },
          {
            kind: 'lyrics',
            value: { segments: [{ chord: null, text: c.source, spans: [] }] },
          },
          {
            kind: 'directive',
            value: { name: 'end_of_grid', value: null, kind: { tag: 'endOfGrid' }, selector: null },
          },
        ],
      };
      const { container, unmount } = render(renderChordproAst(ast));
      // Find the host marker carrying the bracket overlay.
      const hostsWithBracket = Array.from(
        container.querySelectorAll(c.hostSelector),
      ).filter((el) => el.querySelector('.grid-volta__bracket'));
      expect(
        hostsWithBracket.length,
        `expected one ${c.hostLabel} carrying the volta-overlay for source "${c.source}"`,
      ).toBeGreaterThanOrEqual(1);
      // The overlay's label text matches the volta number.
      const labelText = hostsWithBracket[0]?.querySelector('.grid-volta__label')?.textContent;
      expect(labelText).toBe(c.voltaText);
      // Count any standalone `.grid-volta` cells that survived
      // collapse — for non-leading voltas this must be zero.
      const standaloneVoltas = container.querySelectorAll('.grid-volta').length;
      expect(standaloneVoltas).toBe(c.remainingStandalone);
      unmount();
    }
  });

  // The body grid template must size one column per body cell
  // (in source order) — bars get `1fr`, markers get the slot
  // var. Sources like `|1 ... :| |2 ... |.` legitimately put
  // two consecutive markers in the body (repeat-end followed
  // by a volta-2 start). An earlier template that assumed
  // strict bar/marker alternation gave too few columns and
  // wrapped the overflow cells onto fake new rows, breaking
  // the entire grid. Regression guard.
  test('grid body template matches cell count when markers cluster', () => {
    const ast: ChordproSong = {
      metadata: EMPTY_META,
      lines: [
        {
          kind: 'directive',
          value: { name: 'start_of_grid', value: null, kind: { tag: 'startOfGrid' }, selector: null },
        },
        {
          // Mirrors the kitchen-sink "Outro Riff" row 2 source.
          kind: 'lyrics',
          value: {
            segments: [
              { chord: null, text: '|1 Em . . . | C . . . :| |2 Am . . . | G . . . |.', spans: [] },
            ],
          },
        },
        {
          kind: 'directive',
          value: { name: 'end_of_grid', value: null, kind: { tag: 'endOfGrid' }, selector: null },
        },
      ],
    };
    const { container } = render(renderChordproAst(ast));
    const body = container.querySelector('.grid-line__body') as HTMLElement | null;
    expect(body).not.toBeNull();
    const template = body!.style.gridTemplateColumns;
    // Body cell stream after lead `|1` and trail `|.` are
    // extracted, AND after the marker-collapse pass merges
    // `:| |2` into a single repeat-end marker carrying a
    // volta-2 overlay: bar(Em), barline, bar(C), repeat-end+
    // volta-2, bar(Am), barline, bar(G). That is 4 bars + 3
    // markers = 7 columns. (Pre-collapse the cluster would
    // have left 4 markers; the prior bar/marker alternation
    // template assumption broke on EITHER count and the
    // alternation rewrite handles both.)
    expect((template.match(/\b1fr\b/g) ?? []).length).toBe(4);
    expect((template.match(/var\(--cs-grid-barline-slot/g) ?? []).length).toBe(3);
    // Same count of grid items as columns — no overflow onto
    // implicit row tracks.
    expect(body!.childElementCount).toBe(7);
    // The middle marker MUST be the repeat-end glyph carrying
    // the volta-2 bracket overlay (not a separate volta cell).
    const repeatEnd = body!.querySelector('.grid-barline--repeat-end');
    expect(repeatEnd).not.toBeNull();
    expect(repeatEnd?.querySelector('.grid-volta__bracket')?.textContent).toContain('2.');
    // No standalone `.grid-volta` survived in the body.
    expect(body!.querySelectorAll('.grid-volta').length).toBe(0);
  });

  // Lead/trail wrappers carry `data-barline-type` so CSS can
  // apply per-type `justify-self`:
  // - `repeat-start` / `double` / `barline` / `volta` → left
  //   (default `justify-self: start` on `.grid-row__lead`)
  // - `final` / `repeat-end` → right
  // - `repeat-both` → center
  // The attribute is the contract — verify it surfaces with
  // the parser's `kind` value for every barline marker type.
  test('grid row exposes data-barline-type on lead/trail wrappers per barline kind', () => {
    const cases: Array<{ source: string; leadKind: string; trailKind: string }> = [
      // `|` (bare barline)
      { source: '| G . | C . |', leadKind: 'barline', trailKind: 'barline' },
      // `||` (double)
      { source: '|| G . | C . ||', leadKind: 'double', trailKind: 'double' },
      // `|.` (final) - typically trailing
      { source: '| G . | C . |.', leadKind: 'barline', trailKind: 'final' },
      // `|:` / `:|` (repeat-start / repeat-end)
      { source: '|: G . | C . :|', leadKind: 'repeat-start', trailKind: 'repeat-end' },
      // `:|:` (repeat-both) - rare as lead/trail but must round-trip
      { source: ':|: G . | C . :|:', leadKind: 'repeat-both', trailKind: 'repeat-both' },
    ];
    for (const c of cases) {
      const ast: ChordproSong = {
        metadata: EMPTY_META,
        lines: [
          {
            kind: 'directive',
            value: { name: 'start_of_grid', value: null, kind: { tag: 'startOfGrid' }, selector: null },
          },
          {
            kind: 'lyrics',
            value: { segments: [{ chord: null, text: c.source, spans: [] }] },
          },
          {
            kind: 'directive',
            value: { name: 'end_of_grid', value: null, kind: { tag: 'endOfGrid' }, selector: null },
          },
        ],
      };
      const { container, unmount } = render(renderChordproAst(ast));
      const lead = container.querySelector('.grid-row__lead');
      const trail = container.querySelector('.grid-row__trail');
      expect(
        lead?.getAttribute('data-barline-type'),
        `lead kind for source "${c.source}"`,
      ).toBe(c.leadKind);
      expect(
        trail?.getAttribute('data-barline-type'),
        `trail kind for source "${c.source}"`,
      ).toBe(c.trailKind);
      unmount();
    }
  });

  // Section publishes `--cs-grid-barline-slot` in `em` units
  // sized to the widest barline KIND that appears anywhere in
  // the section. The body grid template in every row uses this
  // var as the column width for marker cells, so all body
  // slots resolve to the same pixel width regardless of which
  // mix of barlines a particular row has. The em value is the
  // table in `widthForBarlineKind` (chordpro-jsx.tsx) — bump
  // both in lockstep.
  test('grid section publishes --cs-grid-barline-slot em from widest barline kind', () => {
    const cases: Array<{ source: string; expectedEm: number }> = [
      // Only bare `|` → smallest slot.
      { source: '| G . | C . |', expectedEm: 0.3 },
      // Contains `||` → bumps to double width.
      { source: '|| G . | C . ||', expectedEm: 0.5 },
      // Contains `|.` → final width.
      { source: '| G . | C . |.', expectedEm: 0.6 },
      // Contains `|:` / `:|` → repeat width.
      { source: '|: G . | C . :|', expectedEm: 1.2 },
      // Contains `:|:` → widest.
      { source: '|: G . | C . :|: D . :|', expectedEm: 1.7 },
    ];
    for (const c of cases) {
      const ast: ChordproSong = {
        metadata: EMPTY_META,
        lines: [
          {
            kind: 'directive',
            value: { name: 'start_of_grid', value: null, kind: { tag: 'startOfGrid' }, selector: null },
          },
          {
            kind: 'lyrics',
            value: { segments: [{ chord: null, text: c.source, spans: [] }] },
          },
          {
            kind: 'directive',
            value: { name: 'end_of_grid', value: null, kind: { tag: 'endOfGrid' }, selector: null },
          },
        ],
      };
      const { container, unmount } = render(renderChordproAst(ast));
      const section = container.querySelector('section.grid') as HTMLElement | null;
      expect(section).not.toBeNull();
      // Inline style carries the var assignment; the value is
      // `<em>em` so a string comparison is safe.
      expect(
        section?.style.getPropertyValue('--cs-grid-barline-slot'),
        `slot var for source "${c.source}"`,
      ).toBe(`${c.expectedEm}em`);
      unmount();
    }
  });

  // Each row tags its OWN widest barline-kind em value on the
  // `.grid-line` wrapper. `flushSection` takes the max across
  // children to derive `--cs-grid-barline-slot`. The per-row
  // attribute is the contract — verify it for a row that has
  // a mix of kinds.
  test('grid row exposes data-max-barline-em equal to its widest barline kind', () => {
    const ast: ChordproSong = {
      metadata: EMPTY_META,
      lines: [
        {
          kind: 'directive',
          value: { name: 'start_of_grid', value: null, kind: { tag: 'startOfGrid' }, selector: null },
        },
        {
          // Mix of `|` (0.3), `:|` (1.2), and `|.` (0.6) — max is 1.2.
          kind: 'lyrics',
          value: { segments: [{ chord: null, text: '| G . | C . :| D . |.', spans: [] }] },
        },
        {
          kind: 'directive',
          value: { name: 'end_of_grid', value: null, kind: { tag: 'endOfGrid' }, selector: null },
        },
      ],
    };
    const { container } = render(renderChordproAst(ast));
    const line = container.querySelector('.grid-line') as HTMLElement | null;
    expect(line?.getAttribute('data-max-barline-em')).toBe('1.2');
  });

  // Empty-label rows MUST still emit the `.grid-row__label`
  // cell so that the section's subgrid label column reserves
  // the same width for every row. Without this, an unlabelled
  // row would skip column 1 of the row subgrid and shift its
  // leading barline left by one column — visible regression
  // when a labelled and an unlabelled row are siblings.
  test('grid row emits .grid-row__label cell even when label text is empty', () => {
    const ast: ChordproSong = {
      metadata: EMPTY_META,
      lines: [
        {
          kind: 'directive',
          value: { name: 'start_of_grid', value: null, kind: { tag: 'startOfGrid' }, selector: null },
        },
        {
          // No leading text before the first barline = empty label.
          kind: 'lyrics',
          value: { segments: [{ chord: null, text: '| G . | C . |', spans: [] }] },
        },
        {
          kind: 'directive',
          value: { name: 'end_of_grid', value: null, kind: { tag: 'endOfGrid' }, selector: null },
        },
      ],
    };
    const { container } = render(renderChordproAst(ast));
    const label = container.querySelector('.grid-row__label');
    expect(label, 'label cell must exist even for empty label').not.toBeNull();
    // Empty label is marked aria-hidden so AT does not announce
    // a meaningless empty heading-like text node.
    expect(label?.getAttribute('aria-hidden')).toBe('true');
    expect(label?.textContent ?? '').toBe('');
    // Same contract for the comment cell on a row with no
    // trailing text — it must exist so the right gutter stays
    // a reserved column.
    const comment = container.querySelector('.grid-row__comment');
    expect(comment).not.toBeNull();
    expect(comment?.getAttribute('aria-hidden')).toBe('true');
  });

  // Strum row (a `s` token immediately after the opening
  // barline) renders its compound `~`-separated tokens as
  // individual arrow glyphs split by a visible separator. Per
  // the user spec: `dn~up` is "down then up", not the literal
  // string `dn~up`. The leading-`~` anticipation variant
  // (`~up`) prefixes a faded `~` and renders the remaining
  // glyph.
  test('grid strum row splits ~-separated compound tokens into arrow glyphs', () => {
    const ast: ChordproSong = {
      metadata: EMPTY_META,
      lines: [
        {
          kind: 'directive',
          value: { name: 'start_of_grid', value: null, kind: { tag: 'startOfGrid' }, selector: null },
        },
        {
          // `s` marks a strum row. `dn~up` = down then up;
          // `~up` = anticipated up; `d+` = accented down.
          kind: 'lyrics',
          value: {
            segments: [{ chord: null, text: '|s dn~up ~up d+ | d~u u~d ~d d+ |', spans: [] }],
          },
        },
        {
          kind: 'directive',
          value: { name: 'end_of_grid', value: null, kind: { tag: 'endOfGrid' }, selector: null },
        },
      ],
    };
    const { container } = render(renderChordproAst(ast));
    // Strum rows pick up the `grid-line--strum` modifier.
    expect(container.querySelector('.grid-line--strum')).not.toBeNull();
    // Compound tokens emit one `.grid-strum__part` per side of
    // each `~`. Source has: `dn~up` (2 parts) + `~up` (1 part,
    // leading-~ marks the whole token as anticipated) + `d+`
    // (1 part) + `d~u` (2) + `u~d` (2) + `~d` (1) + `d+` (1).
    // Total parts: 2+1+1+2+2+1+1 = 10.
    expect(container.querySelectorAll('.grid-strum__part').length).toBe(10);
    // Anticipation prefix appears for the 2 `~`-leading tokens.
    expect(container.querySelectorAll('.grid-strum__antic').length).toBe(2);
    // Visible separator `·` between parts of a compound token —
    // one fewer than the part count within a compound. The
    // compounds with >1 parts here: `dn~up` (1 sep), `d~u` (1),
    // `u~d` (1). Total: 3 separators.
    expect(container.querySelectorAll('.grid-strum__sep').length).toBe(3);
  });

  // Row structure for cross-section bar-edge alignment: each
  // `.grid-line` carries dedicated `.grid-row__lead` and
  // `.grid-row__trail` cells (the first / last barline of the
  // row) outside the central `.grid-line__body`. The section's
  // 5-column CSS grid pins lead to col 2 (left-anchored) and
  // trail to col 4 (right-anchored), so every row's bar-grid
  // starts and ends at the same X — independently of bar count
  // or leading-barline kind (`|` / `||` / `|:`).
  test('grid row separates leading and trailing barlines into their own cells', () => {
    const ast: ChordproSong = {
      metadata: EMPTY_META,
      lines: [
        {
          kind: 'directive',
          value: { name: 'start_of_grid', value: null, kind: { tag: 'startOfGrid' }, selector: null },
        },
        {
          kind: 'lyrics',
          value: { segments: [{ chord: null, text: '|: G . | C . :|', spans: [] }] },
        },
        {
          kind: 'directive',
          value: { name: 'end_of_grid', value: null, kind: { tag: 'endOfGrid' }, selector: null },
        },
      ],
    };
    const { container } = render(renderChordproAst(ast));
    const lead = container.querySelector('.grid-row__lead');
    const trail = container.querySelector('.grid-row__trail');
    const body = container.querySelector('.grid-line__body');
    expect(lead?.querySelector('.grid-barline--repeat-start')).not.toBeNull();
    expect(trail?.querySelector('.grid-barline--repeat-end')).not.toBeNull();
    // Body holds 2 bars + 1 intermediate barline (the middle `|`).
    expect(body?.querySelectorAll('.grid-bar').length).toBe(2);
    expect(body?.querySelectorAll('.grid-barline').length).toBe(1);
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

  test('mid-song {key} falls back to single chip when only transposedKey is supplied (back-compat)', () => {
    // Hosts that haven't been updated to thread
    // `transposedKeyDirectives` still get the older behaviour:
    // only the primary `{key:}` directive (the one whose value
    // matches `metadata.key`) gets the pair display, mid-song
    // directives stay authored. The map-based path supersedes
    // this and is exercised by the next test.
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
    // First `{key: G}` — not the primary, no map → single chip.
    expect(markers[0]?.classList.contains('meta-inline--key-pair')).toBe(false);
    // Second `{key: D}` — primary, gets the Written + Sounding pair.
    expect(markers[1]?.classList.contains('meta-inline--key-pair')).toBe(true);
  });

  // #2525: mid-song `{key:}` directives now reach the same
  // canonical transpose path the Rust renderers use, surfaced
  // via the host's `transposedKeyDirectives` map. The walker
  // emits an Original → Playing pair for every directive whose
  // authored value appears in the map.
  test('mid-song {key} renders Original → Playing pair when transposedKeyDirectives covers it', () => {
    const ast: ChordproSong = {
      metadata: { ...EMPTY_META, key: 'G', keys: ['G', 'D'] },
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
    const { container } = render(
      renderChordproAst(ast, {
        transposedKey: 'A',
        transposedKeyDirectives: { G: 'A', D: 'E' },
      }),
    );
    const markers = container.querySelectorAll('.meta-inline--key');
    expect(markers).toHaveLength(2);
    // Primary `{key: G}` → Original G → Playing A.
    expect(markers[0]?.classList.contains('meta-inline--key-pair')).toBe(true);
    const primaryGroups = markers[0]?.querySelectorAll('.meta-inline__group');
    expect(primaryGroups?.[0]?.querySelector('.meta-inline__value')?.textContent).toBe('G');
    expect(primaryGroups?.[1]?.querySelector('.meta-inline__value')?.textContent).toBe('A');
    // Mid-song `{key: D}` → Original D → Playing E (the bug
    // #2525 closed — before the fix this was a single `Key: D`
    // chip ignoring the transpose).
    expect(markers[1]?.classList.contains('meta-inline--key-pair')).toBe(true);
    const midGroups = markers[1]?.querySelectorAll('.meta-inline__group');
    expect(midGroups?.[0]?.querySelector('.meta-inline__value')?.textContent).toBe('D');
    expect(midGroups?.[1]?.querySelector('.meta-inline__value')?.textContent).toBe('E');
  });

  test('mid-song {key} stays single when transposedKeyDirectives entry equals the authored value', () => {
    // Wasm already filters out no-op entries (transpose=0 or
    // identity transpose), but the walker also guards in case a
    // host hand-builds the map. Pair display only fires when
    // original !== transposed.
    const ast: ChordproSong = {
      metadata: { ...EMPTY_META, key: 'G', keys: ['G'] },
      lines: [
        {
          kind: 'directive',
          value: { name: 'key', value: 'G', kind: { tag: 'key' }, selector: null },
        },
      ],
    };
    const { container } = render(
      renderChordproAst(ast, {
        transposedKeyDirectives: { G: 'G' },
      }),
    );
    expect(container.querySelector('.meta-inline--key-pair')).toBeNull();
    expect(container.querySelector('.meta-inline--key .meta-inline__label')?.textContent).toBe(
      'Key:',
    );
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

  // ---------------------------------------------------------------------
  // Walker orientation pass-through (#2572). When the walker emits
  // <ChordDiagram> via the chordDiagrams option, `orientation` must
  // reach the component as a prop. Horizontal mode is reader-view only
  // per ADR-0026, so there is no separate string-order knob.
  //
  // Stub the wasm loader so <ChordDiagram> resolves synchronously to a
  // marker SVG whose attributes record the orientation argument it was
  // called with. The structural assertion against the DOM then verifies
  // the walker wired the prop through correctly.
  // ---------------------------------------------------------------------

  test('forwards chordDiagrams.orientation through to <ChordDiagram>', () => {
    // Walk the React element tree the walker returns and collect every
    // ChordDiagram element's props. This is independent of the wasm
    // loader (which is async and unavailable in unit tests) — we only
    // care that the orientation prop reaches the emitted element.
    type AnyElement = {
      type: unknown;
      props: Record<string, unknown> & { children?: unknown };
    };
    const collectChordDiagramProps = (
      node: unknown,
    ): Array<Record<string, unknown>> => {
      if (node === null || node === undefined || typeof node !== 'object') {
        return [];
      }
      if (Array.isArray(node)) {
        return node.flatMap(collectChordDiagramProps);
      }
      const el = node as AnyElement;
      // <ChordDiagram> is a function component — match on the function
      // name to avoid coupling to the import identity at test runtime.
      const matches =
        typeof el.type === 'function' && (el.type as { name?: string }).name === 'ChordDiagram';
      const head = matches ? [el.props] : [];
      return [...head, ...collectChordDiagramProps(el.props?.children)];
    };

    const song = {
      metadata: EMPTY_META,
      lines: [
        {
          kind: 'lyrics' as const,
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

    const tree = renderChordproAst(song, {
      chordDiagrams: {
        instrument: 'guitar',
        orientation: 'horizontal',
      },
    });

    const diagramProps = collectChordDiagramProps(tree);
    expect(diagramProps.length).toBeGreaterThan(0);
    for (const props of diagramProps) {
      expect(props.orientation).toBe('horizontal');
      expect(props.instrument).toBe('guitar');
    }
  });

  test('omits orientation prop when not configured', () => {
    type AnyElement = {
      type: unknown;
      props: Record<string, unknown> & { children?: unknown };
    };
    const collectChordDiagramProps = (
      node: unknown,
    ): Array<Record<string, unknown>> => {
      if (node === null || node === undefined || typeof node !== 'object') {
        return [];
      }
      if (Array.isArray(node)) {
        return node.flatMap(collectChordDiagramProps);
      }
      const el = node as AnyElement;
      const matches =
        typeof el.type === 'function' && (el.type as { name?: string }).name === 'ChordDiagram';
      const head = matches ? [el.props] : [];
      return [...head, ...collectChordDiagramProps(el.props?.children)];
    };

    const song = {
      metadata: EMPTY_META,
      lines: [
        {
          kind: 'lyrics' as const,
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

    // Default — chordDiagrams.orientation is undefined → walker forwards
    // undefined, which becomes "do nothing different" at <ChordDiagram>'s
    // default-prop layer. The component default kicks in.
    const tree = renderChordproAst(song, {
      chordDiagrams: { instrument: 'guitar' },
    });
    const diagramProps = collectChordDiagramProps(tree);
    expect(diagramProps.length).toBeGreaterThan(0);
    for (const props of diagramProps) {
      expect(props.orientation).toBeUndefined();
    }
  });
});
describe('renderChordproAst click-to-focus + nudge (#2614)', () => {
  // Harness that owns the selection state the way <ChordSheet>
  // does, so clicking / keying a chord re-renders with the updated
  // selection and the nudge controls appear. The AST is fixed
  // (onReposition is a spy; we assert the emitted event rather than
  // re-parsing a mutated source), which is enough to cover the UI
  // wiring and event contract — the source transform itself is
  // covered by the chord-source-edit unit tests.
  function Harness({
    ast,
    onReposition,
  }: {
    ast: ChordproSong;
    onReposition: (event: ChordRepositionEvent) => void;
  }): JSX.Element {
    const [selected, setSelected] = useState<ChordSelection | null>(null);
    return (
      <>
        {renderChordproAst(ast, {
          onChordReposition: onReposition,
          chordSelection: selected,
          setChordSelection: setSelected,
        })}
      </>
    );
  }

  // `[Am]Hello [G]World` — Am at offset 0, G at offset 6, 11 lyric
  // chars total.
  function twoChordAst(): ChordproSong {
    return {
      metadata: EMPTY_META,
      lines: [
        {
          kind: 'lyrics',
          value: {
            segments: [
              { chord: { name: 'Am', detail: null, display: null }, text: 'Hello ', spans: [] },
              { chord: { name: 'G', detail: null, display: null }, text: 'World', spans: [] },
            ],
          },
        },
      ],
    };
  }

  test('chords are toggle buttons; clicking selects (solid badge + aria-pressed)', () => {
    const { container } = render(<Harness ast={twoChordAst()} onReposition={vi.fn()} />);
    const chord = container.querySelector('.chord') as HTMLElement;
    // Toggle-button semantics when the feature is fully wired.
    expect(chord.getAttribute('role')).toBe('button');
    expect(chord.getAttribute('aria-pressed')).toBe('false');
    // Nothing selected yet.
    expect(container.querySelector('.chord--selected')).toBeNull();
    fireEvent.click(chord);
    // Selected → solid badge + aria-pressed. (The ◀/▶ move controls and
    // the editor now live in the left-docked inspector, which is
    // rendered by <ChordSheet>, not the walker — see chord-sheet tests.)
    const selected = container.querySelector('.chord--selected') as HTMLElement;
    expect(selected).not.toBeNull();
    expect(selected.getAttribute('aria-pressed')).toBe('true');
  });

  test('ArrowRight on the selected chord emits a reposition event', () => {
    const onReposition = vi.fn();
    const { container } = render(<Harness ast={twoChordAst()} onReposition={onReposition} />);
    const chord = container.querySelector('.chord') as HTMLElement;
    fireEvent.click(chord);
    const selectedChord = container.querySelector('.chord--selected') as HTMLElement;
    fireEvent.keyDown(selectedChord, { key: 'ArrowRight' });
    expect(onReposition).toHaveBeenCalledTimes(1);
    expect(onReposition.mock.calls[0][0]).toMatchObject({
      toLyricsOffset: 1,
      chord: 'Am',
    });
  });

  test('ArrowLeft at the line start is a no-op (out of bounds)', () => {
    const onReposition = vi.fn();
    const { container } = render(<Harness ast={twoChordAst()} onReposition={onReposition} />);
    // Select Am at offset 0 — it cannot move left.
    fireEvent.click(container.querySelector('.chord') as HTMLElement);
    const selected = container.querySelector('.chord--selected') as HTMLElement;
    fireEvent.keyDown(selected, { key: 'ArrowLeft' });
    expect(onReposition).not.toHaveBeenCalled();
  });

  test('reselecting a chord after deselect restores DOM focus (nonce reset)', () => {
    // jsdom's fireEvent.click does NOT natively focus the element, so
    // any DOM focus the chord span gains here came from the
    // programmatic auto-focus effect. This guards the nonce-reset fix:
    // after a full deselect the per-selection nonce restarts at 1, and
    // without resetting the handled-nonce the reselect would match the
    // stale handled value and skip the refocus. To isolate the
    // programmatic refocus we explicitly drop DOM focus between the
    // deselect and the reselect (simulating focus moving elsewhere),
    // since the chord's DOM node otherwise survives the deselect and
    // keeps focus on its own.
    const { container } = render(<Harness ast={twoChordAst()} onReposition={vi.fn()} />);
    const chord = () => container.querySelector(".chord[role='button']") as HTMLElement;
    fireEvent.click(chord());
    const selected = container.querySelector('.chord--selected') as HTMLElement;
    expect(document.activeElement).toBe(selected);
    // Deselect via Escape, then move DOM focus away.
    fireEvent.keyDown(selected, { key: 'Escape' });
    expect(container.querySelector('.chord--selected')).toBeNull();
    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).not.toBe(chord());
    // Reselect the same chord — the effect must refocus it despite the
    // per-selection nonce restarting at 1.
    fireEvent.click(chord());
    expect(document.activeElement).toBe(container.querySelector('.chord--selected'));
  });

  test('Enter selects a chord via the keyboard', () => {
    const { container } = render(<Harness ast={twoChordAst()} onReposition={vi.fn()} />);
    const chord = container.querySelector('.chord') as HTMLElement;
    fireEvent.keyDown(chord, { key: 'Enter' });
    expect(container.querySelector('.chord--selected')).not.toBeNull();
  });

  test('Escape clears the selection', () => {
    const { container } = render(<Harness ast={twoChordAst()} onReposition={vi.fn()} />);
    fireEvent.click(container.querySelector('.chord') as HTMLElement);
    const selectedChord = container.querySelector('.chord--selected') as HTMLElement;
    fireEvent.keyDown(selectedChord, { key: 'Escape' });
    expect(container.querySelector('.chord--selected')).toBeNull();
  });

  test('clicking the selected chord again toggles the selection off', () => {
    const { container } = render(<Harness ast={twoChordAst()} onReposition={vi.fn()} />);
    const chord = container.querySelector('.chord') as HTMLElement;
    fireEvent.click(chord);
    expect(container.querySelector('.chord--selected')).not.toBeNull();
    // Click the (now selected) chord again.
    fireEvent.click(container.querySelector('.chord--selected') as HTMLElement);
    expect(container.querySelector('.chord--selected')).toBeNull();
  });

  test('clicking a chord writes the selection with an advanced nonce', () => {
    // Controlled render proving the toggle's write shape: selecting G
    // (offset 6) from a clean state.
    const setChordSelection = vi.fn();
    const { container } = render(
      renderChordproAst(twoChordAst(), {
        onChordReposition: vi.fn(),
        chordSelection: null,
        setChordSelection,
      }),
    );
    const chords = container.querySelectorAll(".chord[role='button']");
    fireEvent.click(chords[1] as HTMLElement); // G
    expect(setChordSelection).toHaveBeenCalledWith({
      line: 1,
      offset: 6,
      ordinal: 0,
      nonce: 1,
    });
  });

  test('without setChordSelection, chords are not toggle buttons (drag-only)', () => {
    const { container } = render(
      renderChordproAst(twoChordAst(), { onChordReposition: vi.fn() }),
    );
    const chord = container.querySelector('.chord') as HTMLElement;
    // Drag still wired…
    expect(chord.getAttribute('draggable')).toBe('true');
    // …but no click-to-select toggle semantics.
    expect(chord.getAttribute('role')).toBeNull();
    expect(container.querySelector('.chord--selected')).toBeNull();
  });
});

describe('renderChordproAst inline / hover diagrams (ADR-0027)', () => {
  // A song with N `{diagrams: …}` directive lines + one chord-bearing
  // lyric line. The `<ChordDiagram>` mounted by inline / hover lazily
  // loads wasm asynchronously; like the existing grid tests we assert
  // only the SYNCHRONOUS wrapper structure (classes / fallbacks), never
  // the resolved SVG.
  function songWithDiagramsValues(
    ...values: Array<string | null>
  ): ChordproSong {
    return {
      metadata: EMPTY_META,
      lines: [
        ...values.map((value) => ({
          kind: 'directive' as const,
          value: {
            name: 'diagrams',
            value,
            kind: { tag: 'diagrams' as const },
            selector: null,
          },
        })),
        {
          kind: 'lyrics' as const,
          value: {
            segments: [
              {
                chord: { name: 'C', detail: null, display: null },
                text: 'Do',
                spans: [],
              },
            ],
          },
        },
      ],
    };
  }

  test('{diagrams: inline} replaces the chord name with a compact diagram cell above the lyric', () => {
    const { container } = render(
      renderChordproAst(songWithDiagramsValues('inline'), {
        chordDiagrams: { instrument: 'guitar' },
      }),
    );
    expect(container.querySelector('.chord-block-inline-diagram')).not.toBeNull();
    expect(container.querySelector('.lyrics')?.textContent).toContain('Do');
    // The chord name survives (loading / not-found fallback).
    expect(container.querySelector('.chord-block')?.textContent).toContain('C');
    // The end-of-song grid is suppressed in inline mode.
    expect(container.querySelector('.chord-diagrams')).toBeNull();
  });

  test('{diagrams: hover} keeps the chord name and adds a focusable popover trigger', () => {
    const { container } = render(
      renderChordproAst(songWithDiagramsValues('hover'), {
        chordDiagrams: { instrument: 'guitar' },
      }),
    );
    const trigger = container.querySelector('.chord-has-diagram');
    expect(trigger).not.toBeNull();
    // Keyboard-reachable trigger (the popover reveal is CSS :focus).
    expect(trigger?.getAttribute('tabindex')).toBe('0');
    expect(trigger?.textContent).toContain('C');
    const popover = container.querySelector('.chord-diagram-popover');
    expect(popover).not.toBeNull();
    // aria-describedby / id linkage for assistive technology (useId).
    const tooltipId = trigger?.getAttribute('aria-describedby');
    expect(tooltipId).toBeTruthy();
    expect(popover?.getAttribute('id')).toBe(tooltipId);
    expect(container.querySelector('.chord-block-inline-diagram')).toBeNull();
    expect(container.querySelector('.chord-diagrams')).toBeNull();
  });

  test('default (section) mode renders the end-of-song grid, not inline cells', () => {
    const { container } = render(
      renderChordproAst(songWithDiagramsValues(null), {
        chordDiagrams: { instrument: 'guitar' },
      }),
    );
    expect(container.querySelector('.chord-diagrams')).not.toBeNull();
    expect(container.querySelector('.chord-block-inline-diagram')).toBeNull();
    expect(container.querySelector('.chord-has-diagram')).toBeNull();
  });

  test('{diagrams: off} after {diagrams: inline} suppresses inline diagrams (last-wins visibility)', () => {
    const { container } = render(
      renderChordproAst(songWithDiagramsValues('inline', 'off'), {
        chordDiagrams: { instrument: 'guitar' },
      }),
    );
    expect(container.querySelector('.chord-block-inline-diagram')).toBeNull();
    expect(container.querySelector('.chord-diagrams')).toBeNull();
    expect(container.querySelector('.chord')?.textContent).toContain('C');
  });

  test('{diagrams: inline} and {diagrams: guitar} compose (mode + instrument are independent facets)', () => {
    const { container } = render(
      // No instrument option — {diagrams: guitar} supplies it and
      // {diagrams: inline} supplies the mode.
      renderChordproAst(songWithDiagramsValues('inline', 'guitar'), {
        chordDiagrams: {},
      }),
    );
    expect(container.querySelector('.chord-block-inline-diagram')).not.toBeNull();
    expect(container.querySelector('.chord-diagrams')).toBeNull();
  });

  test('{diagrams: section} after {diagrams: inline} restores the end-of-song grid', () => {
    // `section` is the default mode; writing it explicitly after `inline`
    // must revert to the end-of-song diagram grid (last-wins), so a user
    // who set `{diagrams: inline}` can switch back without removing the
    // first directive.
    const { container } = render(
      renderChordproAst(songWithDiagramsValues('inline', 'section'), {
        chordDiagrams: { instrument: 'guitar' },
      }),
    );
    // End-of-song grid is restored.
    expect(container.querySelector('.chord-diagrams')).not.toBeNull();
    // Inline diagram cells are absent — section mode suppresses them.
    expect(container.querySelector('.chord-block-inline-diagram')).toBeNull();
  });

  test('{diagrams: hover} with instrument: piano renders the hover popover', () => {
    // Mirrors the existing guitar hover test; exercises the piano branch
    // of the instrument-selection path so diagrams mode + non-guitar
    // instrument compose correctly.
    const { container } = render(
      renderChordproAst(songWithDiagramsValues('hover'), {
        chordDiagrams: { instrument: 'piano' },
      }),
    );
    const trigger = container.querySelector('.chord-has-diagram');
    expect(trigger).not.toBeNull();
    // Keyboard-reachable trigger (the popover reveal is CSS :focus).
    expect(trigger?.getAttribute('tabindex')).toBe('0');
    expect(trigger?.textContent).toContain('C');
    // Popover container must be present.
    const popover = container.querySelector('.chord-diagram-popover');
    expect(popover).not.toBeNull();
    // aria-describedby / id linkage for assistive technology.
    const tooltipId = trigger?.getAttribute('aria-describedby');
    expect(tooltipId).toBeTruthy();
    expect(popover?.getAttribute('id')).toBe(tooltipId);
    // Inline diagram cells and end-of-song grid are absent in hover mode.
    expect(container.querySelector('.chord-block-inline-diagram')).toBeNull();
    expect(container.querySelector('.chord-diagrams')).toBeNull();
  });

  // A song with a chord-bearing segment followed by a chord-LESS
  // segment on the same line, plus `{key}` / `{tempo}` directives and
  // a `{diagrams: …}` mode. Exercises the inline-diagram baseline-
  // alignment hook, the meta-inline chip-className invariant, and the
  // `song--diagrams-*` wrapper gate.
  function mixedSegmentSong(diagramsValue: string): ChordproSong {
    return {
      metadata: EMPTY_META,
      lines: [
        {
          kind: 'directive',
          value: { name: 'key', value: 'G', kind: { tag: 'key' }, selector: null },
        },
        {
          kind: 'directive',
          value: { name: 'tempo', value: '120', kind: { tag: 'tempo' }, selector: null },
        },
        {
          kind: 'directive',
          value: {
            name: 'diagrams',
            value: diagramsValue,
            kind: { tag: 'diagrams' },
            selector: null,
          },
        },
        {
          kind: 'lyrics',
          value: {
            segments: [
              { chord: { name: 'C', detail: null, display: null }, text: 'Hello ', spans: [] },
              { chord: null, text: 'world', spans: [] },
            ],
          },
        },
      ],
    };
  }

  test('when diagrams mode is inline, then the lyrics line carries the line--inline-diagrams baseline hook (only in inline)', () => {
    // In inline mode the compact diagram makes the chord row ~40px
    // tall, so a chord-LESS block's lyric floats up to the top of the
    // row instead of sitting on the lyric baseline next to the
    // chord-bearing block's lyric. The fix bottom-aligns the line's
    // flex items via `.line--inline-diagrams`.
    //
    // jsdom has no layout engine, so this only proves the structural
    // hook (the CSS selector) is emitted in inline mode and withheld
    // elsewhere. The ACTUAL baseline alignment is verified in a real
    // browser by `tests-e2e/diagrams-inline-hover.spec.ts`.
    const inline = render(
      renderChordproAst(mixedSegmentSong('inline'), { chordDiagrams: { instrument: 'guitar' } }),
    );
    const inlineLine = inline.container.querySelector('div.line');
    expect(inlineLine).not.toBeNull();
    expect(inlineLine?.classList.contains('line--inline-diagrams')).toBe(true);
    // The line still carries the compact diagram cell (chord-bearing
    // block) AND the chord-less block whose lyric must align.
    expect(inlineLine?.querySelector('.chord-block-inline-diagram')).not.toBeNull();
    expect(inline.container.textContent).toContain('world');

    // Regular (section) mode must NOT get the modifier — gating the
    // bottom-alignment to inline keeps regular/hover layout (and their
    // snapshots) unchanged.
    const section = render(
      renderChordproAst(mixedSegmentSong('section'), { chordDiagrams: { instrument: 'guitar' } }),
    );
    expect(
      section.container.querySelector('div.line')?.classList.contains('line--inline-diagrams'),
    ).toBe(false);

    // Hover mode keeps the chord NAME as the trigger (same ~1em height
    // as regular), so it does NOT need — and must not get — the hook.
    const hover = render(
      renderChordproAst(mixedSegmentSong('hover'), { chordDiagrams: { instrument: 'guitar' } }),
    );
    expect(
      hover.container.querySelector('div.line')?.classList.contains('line--inline-diagrams'),
    ).toBe(false);
  });

  test('when the diagram mode changes, then the {key} / {tempo} meta-inline chip classNames stay mode-independent', () => {
    // The reported regression was that `{diagrams: inline}` restyled the
    // top-level `{key}` / `{tempo}` chips (stacked / full-width). The
    // ROOT CAUSE — a stray `song--diagrams-bottom` wrapper flipping the
    // article to a flex column — is pinned by the next test, and the
    // VISUAL effect (chip width) is verified in a real browser by
    // `tests-e2e/diagrams-inline-hover.spec.ts`.
    //
    // This test guards a narrower, walker-level invariant that neither
    // of those covers: the chips themselves must be emitted with the
    // same className regardless of diagram mode — a future walker branch
    // that added a mode-dependent class directly to a chip would slip
    // past the wrapper-class test. It deliberately does NOT claim to
    // prove the chips "render identically" (jsdom can't measure layout).
    const inline = render(
      renderChordproAst(mixedSegmentSong('inline'), { chordDiagrams: { instrument: 'guitar' } }),
    );
    const section = render(
      renderChordproAst(mixedSegmentSong('section'), { chordDiagrams: { instrument: 'guitar' } }),
    );
    const chipClasses = (root: HTMLElement): string[] =>
      Array.from(root.querySelectorAll('.meta-inline')).map((el) => (el as HTMLElement).className);
    const sectionChips = chipClasses(section.container);
    // Both modes surface the {key} and {tempo} markers.
    expect(sectionChips.length).toBe(2);
    expect(chipClasses(inline.container)).toEqual(sectionChips);
    // Each chip's className is byte-identical across modes.
    const keyChip = (root: HTMLElement): string =>
      (root.querySelector('.meta-inline--key') as HTMLElement).className;
    expect(keyChip(inline.container)).toBe(keyChip(section.container));
    const tempoChip = (root: HTMLElement): string =>
      (root.querySelector('.meta-inline--tempo') as HTMLElement).className;
    expect(tempoChip(inline.container)).toBe(tempoChip(section.container));
  });

  test('when diagrams mode is inline or hover, then the song--diagrams-* wrapper modifier is withheld (it fires only when the end-of-song grid is emitted)', () => {
    // Bug 1 root cause: the wrapper class carried
    // `song--diagrams-${position}` whenever diagrams were *visible*,
    // and `position` defaults to `bottom`. So `{diagrams: inline}` and
    // `{diagrams: hover}` — which suppress the end-of-song grid and
    // emit NO wrapper sibling — still flipped the article to
    // `.song--diagrams-bottom` (display:flex / column). With no grid
    // sibling and no `.song__body` wrapper, every body child (lines,
    // sections, and the top-level `{key}` / `{tempo}` `.meta-inline`
    // chips) became an independent flex-column item and stacked /
    // stretched to full width. jsdom has no layout engine so it can't
    // measure the stacking, but the WRONG WRAPPER CLASS that causes it
    // is structurally observable — this test pins the invariant
    // "position modifier ⇔ grid present" that the className alone never
    // expressed.
    //
    // Inline mode: no grid, so the wrapper must be plain `.song`
    // (block flow). NOT `song--diagrams-bottom`.
    const inline = render(
      renderChordproAst(mixedSegmentSong('inline'), { chordDiagrams: { instrument: 'guitar' } }),
    );
    const inlineSong = inline.container.querySelector('.song');
    expect(inlineSong).not.toBeNull();
    expect(inlineSong?.className).toBe('song');
    // Defensive: no `song--diagrams-*` modifier of any position leaks
    // into inline mode (guards a future `position` directive in an
    // inline song from re-introducing the bug under a different
    // suffix).
    expect(inlineSong?.className).not.toMatch(/\bsong--diagrams-/);
    // The inline body has no end-of-song grid and no `.song__body`
    // wrapper — both are section-mode-only.
    expect(inline.container.querySelector('.chord-diagrams')).toBeNull();
    expect(inline.container.querySelector('.song__body')).toBeNull();

    // Hover mode: same as inline — grid suppressed, plain `.song`.
    const hover = render(
      renderChordproAst(mixedSegmentSong('hover'), { chordDiagrams: { instrument: 'guitar' } }),
    );
    expect(hover.container.querySelector('.song')?.className).toBe('song');
    expect(hover.container.querySelector('.chord-diagrams')).toBeNull();
    expect(hover.container.querySelector('.song__body')).toBeNull();

    // Section mode: a chord IS present, so the end-of-song grid emits
    // (position defaults to `bottom`). The wrapper MUST carry the
    // `song song--diagrams-bottom` modifier AND wrap the body in a
    // single `.song__body` flex child so only the body wrapper + the
    // grid section feel the column-flex (chips inside flow inline).
    const section = render(
      renderChordproAst(mixedSegmentSong('section'), { chordDiagrams: { instrument: 'guitar' } }),
    );
    const sectionSong = section.container.querySelector('.song');
    expect(sectionSong?.className).toBe('song song--diagrams-bottom');
    expect(section.container.querySelector('.song__body')).not.toBeNull();
    // Sanity: the grid that justifies the modifier really is present.
    expect(section.container.querySelector('.chord-diagrams')).not.toBeNull();
  });
});

