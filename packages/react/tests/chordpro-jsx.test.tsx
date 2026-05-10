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

  test('blocks dangerous URI schemes in image directives', () => {
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
                  src: 'javascript:alert(1)',
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
    // Sanitizer drops the dangerous src — no `<img>` reaches the DOM.
    expect(container.querySelector('img')).toBeNull();
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
    expect(lyrics?.querySelector('strong')?.textContent).toBe('Hello ');
    expect(lyrics?.querySelector('em')?.textContent).toBe('world');
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
