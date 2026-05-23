import { describe, expect, test } from 'vitest';

import {
  CAPO_MAX,
  CAPO_MIN,
  TRANSPOSE_MAX,
  TRANSPOSE_MIN,
  applyChordReposition,
  lyricsOffsetToSourceColumn,
  readCapo,
  setCapoInSource,
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

  test.each([
    ['[bracket]', 'left bracket'],
    [']bracket', 'right bracket'],
    ['{brace', 'left brace'],
    ['brace}', 'right brace'],
    ['multi\nline', 'newline'],
    ['carriage\rreturn', 'carriage return'],
    ['<tag', 'angle bracket'],
  ])(
    'rejects chord containing forbidden character (%s — %s)',
    (chord, _label) => {
      expect(() =>
        applyChordReposition('a\nb', {
          fromLine: 1,
          fromColumn: 0,
          fromLength: 1,
          toLine: 1,
          toLyricsOffset: 0,
          chord,
          copy: true,
        }),
      ).toThrow(/forbidden character/);
    },
  );

  test('rejects empty chord name', () => {
    expect(() =>
      applyChordReposition('a\nb', {
        fromLine: 1,
        fromColumn: 0,
        fromLength: 1,
        toLine: 1,
        toLyricsOffset: 0,
        chord: '',
        copy: true,
      }),
    ).toThrow(/non-empty string/);
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

describe('constants', () => {
  test('TRANSPOSE / CAPO bounds expose the playground toolbar range', () => {
    expect(TRANSPOSE_MIN).toBe(-11);
    expect(TRANSPOSE_MAX).toBe(11);
    expect(CAPO_MIN).toBe(0);
    expect(CAPO_MAX).toBe(12);
  });
});

describe('readCapo', () => {
  test('returns 0 when no {capo} directive is present', () => {
    expect(readCapo('{title: Demo}\n[C]Hello')).toBe(0);
    expect(readCapo('')).toBe(0);
  });

  test('parses a positive directive value', () => {
    expect(readCapo('{title: Demo}\n{capo: 3}\n[C]Hello')).toBe(3);
  });

  test('parses without whitespace after the colon', () => {
    expect(readCapo('{capo:5}\nlyrics')).toBe(5);
  });

  test('clamps out-of-range positive values into [CAPO_MIN, CAPO_MAX]', () => {
    expect(readCapo('{capo: 99}\nlyrics')).toBe(CAPO_MAX);
  });

  test('treats malformed and negative values as 0', () => {
    expect(readCapo('{capo: -3}\nlyrics')).toBe(0);
    expect(readCapo('{capo: }\nlyrics')).toBe(0);
  });

  test('honours only the first {capo} occurrence', () => {
    expect(readCapo('{capo: 2}\n{capo: 7}\n[C]Hi')).toBe(2);
  });
});

describe('setCapoInSource', () => {
  test('updates an existing directive in place', () => {
    const source = '{title: Demo}\n{capo: 2}\n[C]Hello';
    expect(setCapoInSource(source, 5)).toBe('{title: Demo}\n{capo: 5}\n[C]Hello');
  });

  test('removes the directive (and its trailing newline) when capo is 0', () => {
    const source = '{title: Demo}\n{capo: 2}\n[C]Hello';
    expect(setCapoInSource(source, 0)).toBe('{title: Demo}\n[C]Hello');
  });

  test('returns source unchanged when capo is 0 and no directive exists', () => {
    const source = '[C]Hello';
    expect(setCapoInSource(source, 0)).toBe(source);
  });

  test('inserts after the {key} anchor when no directive exists', () => {
    const source = '{title: Demo}\n{key: G}\n[C]Hello';
    expect(setCapoInSource(source, 4)).toBe(
      '{title: Demo}\n{key: G}\n{capo: 4}\n[C]Hello',
    );
  });

  test('inserts after the {title} anchor when no {key} is present', () => {
    const source = '{title: Demo}\n[C]Hello';
    expect(setCapoInSource(source, 4)).toBe(
      '{title: Demo}\n{capo: 4}\n[C]Hello',
    );
  });

  test('inserts at the start when no metadata anchor exists', () => {
    expect(setCapoInSource('[C]Hello', 3)).toBe('{capo: 3}\n[C]Hello');
  });

  test('clamps capo into [CAPO_MIN, CAPO_MAX] before writing', () => {
    expect(setCapoInSource('[C]Hi', 99)).toBe('{capo: 12}\n[C]Hi');
    // Negative collapses to 0 → directive omitted entirely.
    expect(setCapoInSource('[C]Hi', -5)).toBe('[C]Hi');
  });

  test('preserves multi-byte lyric bodies untouched', () => {
    // The directive lives at the top of the document, so the
    // unicode body characters never enter the regex match range.
    const source = '{title: 日本語}\n[C]こんにちは';
    expect(setCapoInSource(source, 2)).toBe(
      '{title: 日本語}\n{capo: 2}\n[C]こんにちは',
    );
  });

  test('round-trips: setCapoInSource then readCapo returns the input', () => {
    const source = '{title: Demo}\n{key: D}\n[C]Hello';
    for (const value of [0, 1, 5, 7, 12]) {
      expect(readCapo(setCapoInSource(source, value))).toBe(value);
    }
  });
});
