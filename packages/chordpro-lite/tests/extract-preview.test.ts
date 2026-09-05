import { describe, expect, it } from 'vitest';
import { extractPreview, type PreviewLine } from '../src/extract-preview';

/**
 * Take the first preview line, asserting there is one.
 *
 * `lines[0]` is `PreviewLine | undefined` under
 * `noUncheckedIndexedAccess`. Silencing that with `!` or `as` would turn
 * a regression that returns no lines into a confusing `TypeError`; this
 * fails with the expectation instead.
 */
function firstLine(lines: PreviewLine[]): PreviewLine {
  const first = lines[0];
  if (first === undefined) throw new Error('expected at least one preview line');
  return first;
}

describe('extractPreview', () => {
  it('splits a line into its chords and its lyric text', () => {
    expect(extractPreview('[C]Morning [G]light')).toEqual([
      { chords: ['C', 'G'], lyric: 'Morning light' },
    ]);
  });

  it('returns the first two lines by default', () => {
    const source = '[C]one\n[G]two\n[Am]three';
    expect(extractPreview(source)).toEqual([
      { chords: ['C'], lyric: 'one' },
      { chords: ['G'], lyric: 'two' },
    ]);
  });

  it('returns up to maxLines entries when maxLines is raised', () => {
    const source = '[C]one\n[G]two\n[Am]three';
    expect(extractPreview(source, { maxLines: 3 })).toHaveLength(3);
  });

  it('returns nothing when maxLines is zero', () => {
    expect(extractPreview('[C]one', { maxLines: 0 })).toEqual([]);
  });

  it('returns nothing when maxLines is negative', () => {
    expect(extractPreview('[C]one', { maxLines: -1 })).toEqual([]);
  });

  it('skips directive-only lines and starts at the first line with content', () => {
    expect(extractPreview('{title: Foo}\n{artist: Bar}\n[C]lyric')).toEqual([
      { chords: ['C'], lyric: 'lyric' },
    ]);
  });

  it('returns an empty lyric for a chord-only line', () => {
    expect(extractPreview('[G] [C] [D]')).toEqual([{ chords: ['G', 'C', 'D'], lyric: '' }]);
  });

  it('returns an empty chord list for a body that carries no chords', () => {
    expect(extractPreview('just some words')).toEqual([{ chords: [], lyric: 'just some words' }]);
  });

  it('returns nothing for empty input', () => {
    expect(extractPreview('')).toEqual([]);
  });

  it('returns nothing when the input is blank lines only', () => {
    expect(extractPreview('\n\n   \n')).toEqual([]);
  });

  it('skips blank lines so the returned lines are contiguous', () => {
    expect(extractPreview('[C]one\n\n[G]two')).toEqual([
      { chords: ['C'], lyric: 'one' },
      { chords: ['G'], lyric: 'two' },
    ]);
  });

  it('does not count an empty annotation as a chord', () => {
    expect(extractPreview('[]word[ ]s')).toEqual([{ chords: [], lyric: 'words' }]);
  });

  it('stops collecting chords at maxChordsPerLine', () => {
    const source = '[C][D][E][F][G][A][B][C]tail';
    expect(firstLine(extractPreview(source, { maxChordsPerLine: 3 })).chords).toEqual([
      'C',
      'D',
      'E',
    ]);
  });

  it('truncates the lyric at maxLyricChars', () => {
    expect(extractPreview('[C]abcdefghij', { maxLyricChars: 4 })).toEqual([
      { chords: ['C'], lyric: 'abcd' },
    ]);
  });

  it('returns an empty lyric when maxLyricChars is zero', () => {
    expect(extractPreview('[C]abcdefghij', { maxLyricChars: 0 })).toEqual([
      { chords: ['C'], lyric: '' },
    ]);
  });

  it('returns an empty lyric rather than trimming from the end when maxLyricChars is negative', () => {
    // `Array.prototype.slice`'s negative-end semantics would otherwise
    // keep everything but the last |max| code points instead of nothing.
    expect(extractPreview('[C]abcdefghij', { maxLyricChars: -5 })).toEqual([
      { chords: ['C'], lyric: '' },
    ]);
  });

  it('truncates on a character boundary when the limit falls inside a surrogate pair', () => {
    // Three code points, two of them astral: cutting at two must keep
    // whole characters rather than emit a lone surrogate.
    expect(firstLine(extractPreview('𝄞𝄢x', { maxLyricChars: 2 })).lyric).toBe('𝄞𝄢');
  });

  it('collapses the whitespace run that removing a chord leaves behind', () => {
    expect(extractPreview('Hello[G]   [C]world')).toEqual([
      { chords: ['G', 'C'], lyric: 'Hello world' },
    ]);
  });

  it('removes a directive that sits inside a lyric line, keeping the words', () => {
    expect(extractPreview('Hello {comment: x} world')).toEqual([
      { chords: [], lyric: 'Hello world' },
    ]);
  });

  it('does not let an unbalanced bracket swallow the following line', () => {
    expect(extractPreview('[C]one [broken\n[G]two')).toEqual([
      { chords: ['C'], lyric: 'one [broken' },
      { chords: ['G'], lyric: 'two' },
    ]);
  });

  it('degrades rather than throwing when handed an iReal Pro URL', () => {
    // Callers gate on detectFormat and skip iReal Pro bodies; this only
    // pins that the sampler stays total.
    const result = extractPreview('irealb://Song=Artist=Style=C=n=');
    expect(result).toHaveLength(1);
    expect(firstLine(result).chords).toEqual([]);
  });

  it('preserves non-Latin lyrics unchanged', () => {
    expect(extractPreview('[C]きみ[G]の名前')).toEqual([
      { chords: ['C', 'G'], lyric: 'きみの名前' },
    ]);
  });

  it('keeps slash bass notes and extensions in the chord symbol', () => {
    expect(firstLine(extractPreview('[Cmaj7/E]word')).chords).toEqual(['Cmaj7/E']);
  });
});
