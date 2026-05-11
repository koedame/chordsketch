import { render } from '@testing-library/react';
import { describe, expect, test } from 'vitest';

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

  test('renders "Original Key · Play Key" when transposedKey is supplied', () => {
    const { container } = render(
      renderChordproAst(
        {
          metadata: {
            ...EMPTY_META,
            title: 'My Song',
            key: 'G',
          },
          lines: [],
        },
        { transposedKey: 'A' },
      ),
    );
    const meta = container.querySelector('.meta');
    expect(meta?.textContent).toContain('Original Key G');
    expect(meta?.textContent).toContain('Play Key A');
    expect(meta?.textContent).not.toMatch(/Key G(?! ·)/);
  });

  test('falls back to "Key X" when transposedKey is null or equal to the original', () => {
    // null → single-key form
    const a = render(
      renderChordproAst(
        { metadata: { ...EMPTY_META, key: 'G' }, lines: [] },
        { transposedKey: null },
      ),
    );
    expect(a.container.querySelector('.meta')?.textContent).toBe('Key G');
    // equal-to-original → single-key form (avoids the visually
    // confusing "Original Key G · Play Key G" tautology)
    const b = render(
      renderChordproAst(
        { metadata: { ...EMPTY_META, key: 'G' }, lines: [] },
        { transposedKey: 'G' },
      ),
    );
    expect(b.container.querySelector('.meta')?.textContent).toBe('Key G');
  });

  test('extended metadata lands in the meta strip in attribution → parameters → tags order', () => {
    // Mirrors the ChordPro spec's conceptual grouping —
    // attribution (people / album / year) first, then musical
    // parameters (key / tempo / time / capo / duration), then
    // tags as their own row.
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
          capo: '2',
          tempo: '120',
          time: '4/4',
          duration: '3:30',
          copyright: '© 2026',
          tags: ['demo', 'reference'],
        },
        lines: [],
      }),
    );
    const meta = container.querySelector('.meta:not(.meta--tags)');
    const txt = meta?.textContent ?? '';
    expect(txt).toContain('Demo');
    expect(txt).toContain('Music JC');
    expect(txt).toContain('Lyrics JL');
    expect(txt).toContain('Arrangement JA');
    expect(txt).toContain('Reference');
    expect(txt).toContain('2026');
    expect(txt).toContain('Key G');
    expect(txt).toContain('Capo 2');
    expect(txt).toContain('120 BPM');
    expect(txt).toContain('4/4');
    expect(txt).toContain('3:30');
    expect(txt).toContain('© 2026');
    // Tags live on a separate row as pill chips.
    const tagRow = container.querySelector('.meta--tags');
    expect(tagRow).not.toBeNull();
    const tags = tagRow?.querySelectorAll('.tag');
    expect(tags?.length).toBe(2);
    expect(tags?.[0]?.textContent).toBe('demo');
    expect(tags?.[1]?.textContent).toBe('reference');
  });

  test('renders the metadata header', () => {
    const { container } = render(
      renderChordproAst({
        metadata: {
          ...EMPTY_META,
          title: 'My Song',
          subtitles: ['A subtitle'],
          artists: ['Artist'],
          key: 'G',
          capo: '2',
        },
        lines: [],
      }),
    );
    expect(container.querySelector('h1')?.textContent).toBe('My Song');
    expect(container.querySelector('h2')?.textContent).toBe('A subtitle');
    expect(container.querySelector('.meta')?.textContent).toBe('Artist · Key G · Capo 2');
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
        ],
      }),
    );
    const comments = container.querySelectorAll('p.comment');
    expect(comments.length).toBe(2);
    expect(comments[0]?.textContent).toBe('plain comment');
    expect(comments[1]?.querySelector('em')?.textContent).toBe('italic comment');
    expect(container.querySelector('.comment-box')?.textContent).toBe('boxed comment');
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
});
