import { describe, expect, test } from 'vitest';

import {
  applyChordReposition,
  lyricsOffsetToSourceColumn,
} from '../src/chord-source-edit';

describe('lyricsOffsetToSourceColumn', () => {
  test('chord-less line: lyrics offset === source column', () => {
    // No brackets — 1:1 mapping.
    expect(lyricsOffsetToSourceColumn('Hello world', 0)).toBe(0);
    expect(lyricsOffsetToSourceColumn('Hello world', 3)).toBe(3);
    expect(lyricsOffsetToSourceColumn('Hello world', 11)).toBe(11);
  });

  test('clamps past-end offsets to line length', () => {
    expect(lyricsOffsetToSourceColumn('hi', 99)).toBe(2);
  });

  test('chord bracket counts as zero-width to the lyrics offset', () => {
    // Line: `[Am]Hello` — bracket at cols 0..3 is invisible to lyrics.
    // Lyrics offset 0 ⇒ AFTER the bracket, at col 4 (= start of "H").
    expect(lyricsOffsetToSourceColumn('[Am]Hello', 0)).toBe(4);
    // Lyrics offset 3 ⇒ between "Hel" and "lo" = col 7.
    expect(lyricsOffsetToSourceColumn('[Am]Hello', 3)).toBe(7);
    // Lyrics offset 5 (past end of "Hello") clamps to line end.
    expect(lyricsOffsetToSourceColumn('[Am]Hello', 5)).toBe(9);
  });

  test('multiple adjacent brackets all skipped before lyric counting', () => {
    // `[Am][G]Hello` — both brackets at cols 0..6 are zero-width
    // to the lyric counter, so offset 0 lands AFTER all of them.
    // This is the deliberate "new chord becomes the active one
    // for the lyric" behaviour — the alternative (insert BEFORE
    // the brackets) would push the existing chords above an
    // invisible zero-width segment.
    expect(lyricsOffsetToSourceColumn('[Am][G]Hello', 0)).toBe(7);
    expect(lyricsOffsetToSourceColumn('[Am][G]Hello', 1)).toBe(8); // before "e"
  });

  test('bracket in the middle of lyrics', () => {
    // `He[Am]llo` — bracket at cols 2..5.
    expect(lyricsOffsetToSourceColumn('He[Am]llo', 0)).toBe(0);
    expect(lyricsOffsetToSourceColumn('He[Am]llo', 1)).toBe(1);
    // Lyrics offset 2: the lyric counter has advanced past "He"
    // and we're at the bracket boundary. Skip the bracket first
    // so the insert lands AFTER `[Am]` (col 6) — the new chord
    // becomes the active one for "llo".
    expect(lyricsOffsetToSourceColumn('He[Am]llo', 2)).toBe(6);
    // Lyrics offset 3 ⇒ after bracket + one lyric char → col 7.
    expect(lyricsOffsetToSourceColumn('He[Am]llo', 3)).toBe(7);
  });

  test('malformed unterminated `[` falls back to plain lyrics', () => {
    // `[Am Hello` — no closing `]`, treat the rest as lyrics.
    // Lyrics offset 0 stops at the `[`.
    expect(lyricsOffsetToSourceColumn('[Am Hello', 0)).toBe(0);
  });
});

describe('applyChordReposition — move', () => {
  test('cross-line move: chord removed from source, inserted on target', () => {
    // Source:
    //   line 1: `[Am]Hello`
    //   line 2: `World`
    // Move `[Am]` from line 1 col 0 to line 2 lyrics-offset 2.
    const before = '[Am]Hello\nWorld';
    const { text, caretOffset } = applyChordReposition(before, {
      fromLine: 1,
      fromColumn: 0,
      fromLength: 4,
      toLine: 2,
      toLyricsOffset: 2,
      chord: 'Am',
      copy: false,
    });
    // line 1 becomes `Hello`, line 2 becomes `Wo[Am]rld`.
    expect(text).toBe('Hello\nWo[Am]rld');
    // Caret lands right after the inserted `[Am]` on line 2.
    // line 1 = "Hello" (5 chars) + \n = 6, +2 (Wo) +4 ([Am]) = 12.
    expect(caretOffset).toBe(12);
  });

  test('same-line move forward: target column is interpreted post-removal', () => {
    // Source: `[Am]Hello World` (15 chars).
    // Move `[Am]` to lyrics-offset 6 — between "Hello " and "World"
    // in the rendered text (which is "Hello World", 11 chars).
    // After removal: `Hello World`. Insert at col 6.
    const before = '[Am]Hello World';
    const { text, caretOffset } = applyChordReposition(before, {
      fromLine: 1,
      fromColumn: 0,
      fromLength: 4,
      toLine: 1,
      toLyricsOffset: 6,
      chord: 'Am',
      copy: false,
    });
    expect(text).toBe('Hello [Am]World');
    // After insert, caret after `[Am]` at col 10.
    expect(caretOffset).toBe(10);
  });

  test('same-line move backward', () => {
    // Source: `Hello [Am]World` — `[Am]` at col 6.
    // Move it to lyrics-offset 0 (beginning of the line).
    const before = 'Hello [Am]World';
    const { text, caretOffset } = applyChordReposition(before, {
      fromLine: 1,
      fromColumn: 6,
      fromLength: 4,
      toLine: 1,
      toLyricsOffset: 0,
      chord: 'Am',
      copy: false,
    });
    expect(text).toBe('[Am]Hello World');
    expect(caretOffset).toBe(4);
  });

  test('chord landing into a line that already has chord brackets', () => {
    // Source line: `[G]Hello world` — drop `[Am]` at lyrics-offset 6.
    // After mapping: "Hello world" has its 6th char at "w"; in source
    // that's col 9 (3 bracket + 6 lyric chars). Insert there.
    const before = 'Foo\n[G]Hello world';
    const { text } = applyChordReposition(before, {
      fromLine: 1,
      fromColumn: 0,
      fromLength: 4, // pretend `Foo\n` has a 4-char bracket prefix (this is a contrived corpus)
      toLine: 2,
      toLyricsOffset: 6,
      chord: 'Am',
      copy: true, // copy mode — no removal so we don't need the from to be valid
    });
    expect(text).toBe('Foo\n[G]Hello [Am]world');
  });
});

describe('applyChordReposition — copy (Alt held)', () => {
  test('copy keeps the original bracket and adds a fresh one at target', () => {
    const before = '[Am]Hello World';
    const { text } = applyChordReposition(before, {
      fromLine: 1,
      fromColumn: 0,
      fromLength: 4,
      toLine: 1,
      toLyricsOffset: 6, // between "Hello " and "World"
      chord: 'Am',
      copy: true,
    });
    // Original `[Am]` preserved; a second `[Am]` inserted at the target.
    expect(text).toBe('[Am]Hello [Am]World');
  });
});

describe('applyChordReposition — error paths', () => {
  test('throws on out-of-range fromLine for move', () => {
    expect(() =>
      applyChordReposition('a\nb', {
        fromLine: 5,
        fromColumn: 0,
        fromLength: 1,
        toLine: 1,
        toLyricsOffset: 0,
        chord: 'X',
        copy: false,
      }),
    ).toThrow(/fromLine/);
  });

  test('throws on out-of-range toLine', () => {
    expect(() =>
      applyChordReposition('a\nb', {
        fromLine: 1,
        fromColumn: 0,
        fromLength: 1,
        toLine: 9,
        toLyricsOffset: 0,
        chord: 'X',
        copy: true,
      }),
    ).toThrow(/toLine/);
  });

  test('throws when from range exceeds line length', () => {
    expect(() =>
      applyChordReposition('hi', {
        fromLine: 1,
        fromColumn: 0,
        fromLength: 99,
        toLine: 1,
        toLyricsOffset: 0,
        chord: 'X',
        copy: false,
      }),
    ).toThrow(/exceeds line length/);
  });
});
