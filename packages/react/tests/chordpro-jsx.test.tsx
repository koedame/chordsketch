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
    ['java​script:alert(1)'],
    ['java\tscript:alert(1)'],
    ['java‮script:alert(1)'],
  ])('blocks obfuscated dangerous URI: %s', (src) => {
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
