import { describe, expect, it } from 'vitest';
import { extractLyrics } from '../src/extract-lyrics';

describe('extractLyrics', () => {
  it('returns the lyric words with the inline chords removed', () => {
    expect(extractLyrics('[G]Hello [Am]world')).toBe('Hello world');
  });

  it('rejoins a word when a chord is annotated inside it', () => {
    expect(extractLyrics('wo[C]rld')).toBe('world');
  });

  it('drops a line that holds nothing but a directive', () => {
    expect(extractLyrics('{title: Foo}\n[G]Hello')).toBe('Hello');
  });

  it('removes a directive that sits inside a lyric line, keeping the words', () => {
    expect(extractLyrics('Hello {comment: x} world')).toBe('Hello world');
  });

  it('returns an empty string for an instrumental with chord-only lines', () => {
    expect(extractLyrics('{soc}\n[G] [C] [D]\n{eoc}')).toBe('');
  });

  it('returns an empty string for empty input', () => {
    expect(extractLyrics('')).toBe('');
  });

  it('drops blank lines so the surviving lyric lines are contiguous', () => {
    expect(extractLyrics('[G]Line one\n\n[C]Line two')).toBe('Line one\nLine two');
  });

  it('collapses the whitespace run that removing a chord leaves behind', () => {
    expect(extractLyrics('Hello[G]   [C]world')).toBe('Hello world');
  });

  it('trims leading and trailing whitespace from each line', () => {
    expect(extractLyrics('  [C]padded  ')).toBe('padded');
  });

  it('joins multiple lyric lines with newlines', () => {
    const source = '{title: Song}\n[C]first line\n[G]second line\n{eoc}';
    expect(extractLyrics(source)).toBe('first line\nsecond line');
  });

  it('preserves non-Latin lyrics unchanged', () => {
    expect(extractLyrics('[C]きみ[G]の名前')).toBe('きみの名前');
  });

  it('preserves accented characters and emoji', () => {
    expect(extractLyrics('[C]café 🎸 here')).toBe('café 🎸 here');
  });

  it('does not let an unbalanced bracket swallow the following line', () => {
    expect(extractLyrics('[C]one [broken\n[G]two')).toBe('one [broken\ntwo');
  });
});
