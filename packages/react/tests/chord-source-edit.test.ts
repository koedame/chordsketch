import { describe, expect, test } from 'vitest';

import {
  CAPO_MAX,
  CAPO_MIN,
  TRANSPOSE_MAX,
  TRANSPOSE_MIN,
  CHORD_TYPE_PRESETS,
  applyChordDelete,
  applyChordEdit,
  applyChordReposition,
  buildChordName,
  chordSuffixFromQuality,
  findChordByOffsetOrdinal,
  lyricsOffsetToSourceColumn,
  nudgeChordPosition,
  readCapo,
  setCapoInSource,
  sourceColumnToLyricsOffset,
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

describe('sourceColumnToLyricsOffset', () => {
  test('chord-less line: column === lyrics offset', () => {
    expect(sourceColumnToLyricsOffset('Hello world', 0)).toBe(0);
    expect(sourceColumnToLyricsOffset('Hello world', 3)).toBe(3);
    expect(sourceColumnToLyricsOffset('Hello world', 11)).toBe(11);
  });

  test('clamps out-of-range columns', () => {
    expect(sourceColumnToLyricsOffset('hi', 99)).toBe(2);
    expect(sourceColumnToLyricsOffset('hi', -5)).toBe(0);
  });

  test('chord bracket is zero-width to the lyrics offset', () => {
    // `[Am]Hello` — a column at the chord's `[` (col 0) precedes no
    // lyric, so offset 0.
    expect(sourceColumnToLyricsOffset('[Am]Hello', 0)).toBe(0);
    // Column 4 is the start of "Hello", still 0 lyrics consumed.
    expect(sourceColumnToLyricsOffset('[Am]Hello', 4)).toBe(0);
    // Column 7 is between "Hel" and "lo" → 3 lyric chars before it.
    expect(sourceColumnToLyricsOffset('[Am]Hello', 7)).toBe(3);
  });

  test('is the inverse of lyricsOffsetToSourceColumn for in-range offsets', () => {
    const line = '[Am]Hel[G]lo world';
    for (let offset = 0; offset <= 11; offset++) {
      const col = lyricsOffsetToSourceColumn(line, offset);
      // Round-trips back to the same offset (brackets are skipped on
      // the way out, so the column lands at a lyric boundary).
      expect(sourceColumnToLyricsOffset(line, col)).toBe(offset);
    }
  });

  test('malformed (unterminated) bracket counts as lyrics within range', () => {
    // No closing `]` before the column → characters count as lyrics
    // rather than throwing.
    expect(sourceColumnToLyricsOffset('[Am Hello', 5)).toBe(5);
  });
});

describe('nudgeChordPosition', () => {
  test('moves right one lyric character', () => {
    expect(nudgeChordPosition(0, [], 5, 1)).toEqual({ offset: 1, ordinal: 0 });
  });

  test('moves left one lyric character', () => {
    expect(nudgeChordPosition(3, [], 5, -1)).toEqual({ offset: 2, ordinal: 0 });
  });

  test('returns null at the left edge (cannot move before offset 0)', () => {
    expect(nudgeChordPosition(0, [], 5, -1)).toBeNull();
  });

  test('returns null at the right edge (cannot move past line end)', () => {
    // A trailing chord legitimately sits at offset === totalLyrics,
    // so moving right from there is out of bounds.
    expect(nudgeChordPosition(5, [], 5, 1)).toBeNull();
  });

  test('allows landing exactly on the line-end offset', () => {
    expect(nudgeChordPosition(4, [], 5, 1)).toEqual({ offset: 5, ordinal: 0 });
  });

  test('destination ordinal counts chords already at the destination offset', () => {
    // Two other chords sit at offset 2; the moved chord lands AFTER
    // them (lyricsOffsetToSourceColumn skips leading brackets), so its
    // ordinal among same-offset chords is 2.
    expect(nudgeChordPosition(1, [2, 2, 4], 5, 1)).toEqual({ offset: 2, ordinal: 2 });
  });
});

describe('findChordByOffsetOrdinal', () => {
  test('finds the single chord at an offset', () => {
    expect(findChordByOffsetOrdinal([0, 3, 5], 3, 0)).toBe(1);
  });

  test('disambiguates stacked chords by ordinal', () => {
    // Three chords share offset 2 ([A][B][C]word). ordinal picks which.
    expect(findChordByOffsetOrdinal([2, 2, 2, 5], 2, 0)).toBe(0);
    expect(findChordByOffsetOrdinal([2, 2, 2, 5], 2, 1)).toBe(1);
    expect(findChordByOffsetOrdinal([2, 2, 2, 5], 2, 2)).toBe(2);
  });

  test('returns -1 when the selection no longer resolves', () => {
    expect(findChordByOffsetOrdinal([0, 3], 3, 1)).toBe(-1);
    expect(findChordByOffsetOrdinal([0, 3], 9, 0)).toBe(-1);
  });
});

describe('nudge integration: nudgeChordPosition + applyChordReposition', () => {
  // Helper mirroring how the React walker turns a nudge into a
  // ChordRepositionEvent + applies it to the source. Proves the pure
  // offset math composes with the source transform end to end.
  function nudgeSource(
    source: string,
    fromLine: number,
    fromColumn: number,
    chordName: string,
    currentOffset: number,
    otherOffsets: number[],
    totalLyrics: number,
    direction: -1 | 1,
  ): string | null {
    const dest = nudgeChordPosition(currentOffset, otherOffsets, totalLyrics, direction);
    if (!dest) return null;
    const { text } = applyChordReposition(source, {
      fromLine,
      fromColumn,
      fromLength: chordName.length + 2,
      toLine: fromLine,
      toLyricsOffset: dest.offset,
      chord: chordName,
      copy: false,
    });
    return text;
  }

  test('nudging a leading chord right moves it one character into the lyric', () => {
    // `[Am]Hello`: Am at column 0, offset 0, line has 5 lyric chars.
    expect(nudgeSource('[Am]Hello', 1, 0, 'Am', 0, [], 5, 1)).toBe('H[Am]ello');
  });

  test('nudging a mid-lyric chord left moves it one character back', () => {
    // `H[Am]ello`: Am at column 1, offset 1.
    expect(nudgeSource('H[Am]ello', 1, 1, 'Am', 1, [], 5, -1)).toBe('[Am]Hello');
  });

  test('nudging right onto an occupied offset lands after the existing chord', () => {
    // `[A]H[B]ello`: move A (col 0, offset 0) right to offset 1, where
    // B already sits. A re-inserts after B → `[B]` then `[A]` at the
    // same lyric position is NOT the case here (different offsets);
    // verify the source transform: removing [A] gives `H[B]ello`,
    // inserting [A] at offset 1 lands after [B].
    expect(nudgeSource('[A]H[B]ello', 1, 0, 'A', 0, [1], 5, 1)).toBe('H[B][A]ello');
  });

  test('repeated right nudges walk the chord across the lyric', () => {
    let src = '[Am]Hello';
    let offset = 0;
    let col = 0;
    for (let step = 1; step <= 3; step++) {
      const dest = nudgeChordPosition(offset, [], 5, 1);
      expect(dest).not.toBeNull();
      const { text } = applyChordReposition(src, {
        fromLine: 1,
        fromColumn: col,
        fromLength: 4,
        toLine: 1,
        toLyricsOffset: dest!.offset,
        chord: 'Am',
        copy: false,
      });
      src = text;
      offset = dest!.offset;
      // After re-insertion the new column is offset + (chars consumed
      // by lyrics before it); recompute via the helper.
      col = lyricsOffsetToSourceColumn(src.replace('[Am]', ''), offset);
    }
    // Am started before "H", three right steps → before the second "l".
    expect(src).toBe('Hel[Am]lo');
  });
});

describe('chordSuffixFromQuality', () => {
  test('round-trips parser quality + extension splits', () => {
    expect(chordSuffixFromQuality('major', null)).toBe('');
    expect(chordSuffixFromQuality('minor', null)).toBe('m');
    expect(chordSuffixFromQuality('diminished', null)).toBe('dim');
    expect(chordSuffixFromQuality('augmented', null)).toBe('aug');
    expect(chordSuffixFromQuality('minor', '7')).toBe('m7');
    expect(chordSuffixFromQuality('major', 'maj7')).toBe('maj7');
    expect(chordSuffixFromQuality('minor', '7b5')).toBe('m7b5');
    expect(chordSuffixFromQuality('major', 'sus4')).toBe('sus4');
  });

  test('every suffix-only preset is reachable from a quality+extension split', () => {
    // Sanity: the presets the chips expose are all valid suffix strings
    // the parser could produce (so a chip selection round-trips).
    const suffixes = new Set(CHORD_TYPE_PRESETS.map((p) => p.text));
    expect(suffixes.has('')).toBe(true); // maj
    expect(suffixes.has('m')).toBe(true); // min
    expect(suffixes.has('m7')).toBe(true);
    expect(suffixes.has('maj7')).toBe(true);
  });

  test('the expanded jazz tension / quality set is present (#2630)', () => {
    const suffixes = new Set(CHORD_TYPE_PRESETS.map((p) => p.text));
    // Extended + altered families added in #2630.
    for (const t of ['maj9', 'm9', '11', 'm11', '13', 'm13', 'add11', '7b9', '7#9', '7#11', '7b13', '7alt', '69', 'm6', 'mMaj7', '7sus4', '9sus4']) {
      expect(suffixes.has(t)).toBe(true);
    }
  });

  test('every preset text builds a valid chord token (no forbidden / structural chars)', () => {
    // A chip selection feeds `text` straight into buildChordName as the
    // suffix; if any preset carried a `/` or a structural char the edit
    // would throw and silently drop. Guards the `69` (not `6/9`) choice.
    for (const preset of CHORD_TYPE_PRESETS) {
      expect(() => buildChordName({ root: 'C', suffix: preset.text })).not.toThrow();
      expect(buildChordName({ root: 'C', suffix: preset.text })).toBe(`C${preset.text}`);
    }
  });

  test('preset ids are unique', () => {
    const ids = CHORD_TYPE_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('buildChordName', () => {
  test('assembles root + accidental + suffix + bass', () => {
    expect(buildChordName({ root: 'A' })).toBe('A');
    expect(buildChordName({ root: 'A', suffix: 'm' })).toBe('Am');
    expect(buildChordName({ root: 'A', accidental: '#', suffix: 'm7' })).toBe('A#m7');
    expect(buildChordName({ root: 'B', accidental: 'b', suffix: 'maj7' })).toBe('Bbmaj7');
    expect(buildChordName({ root: 'G', suffix: '7', bass: 'B' })).toBe('G7/B');
    expect(buildChordName({ root: 'C', bass: 'E' })).toBe('C/E');
  });

  test('rejects a bad root', () => {
    expect(() => buildChordName({ root: 'H' })).toThrow(/root/);
    expect(() => buildChordName({ root: 'Am' })).toThrow(/root/);
    expect(() => buildChordName({ root: '' })).toThrow(/root/);
  });

  test('rejects a bad accidental', () => {
    // @ts-expect-error — exercising the runtime guard with an invalid value
    expect(() => buildChordName({ root: 'C', accidental: 'x' })).toThrow(/accidental/);
  });

  test.each([
    ['m[7'], ['m]7'], ['m{7'], ['m}7'], ['m<7'], ['m\n7'], ['m/7'],
  ])('rejects a suffix containing a structural character (%s)', (suffix) => {
    expect(() => buildChordName({ root: 'C', suffix })).toThrow(/suffix/);
  });

  test('rejects a bass containing a slash or structural character', () => {
    expect(() => buildChordName({ root: 'C', bass: 'E/G' })).toThrow(/bass/);
    expect(() => buildChordName({ root: 'C', bass: 'E]' })).toThrow(/bass/);
  });
});

describe('applyChordEdit', () => {
  test('replaces the chord token in place and reports caret after it', () => {
    // `[Am]Hello` — edit Am (col 0, len 4) → Amaj7.
    const { text, caretOffset } = applyChordEdit('[Am]Hello', {
      line: 1,
      fromColumn: 0,
      fromLength: 4,
      chord: 'Amaj7',
    });
    expect(text).toBe('[Amaj7]Hello');
    expect(caretOffset).toBe('[Amaj7]'.length); // 7
  });

  test('edits a mid-line chord on the correct line, leaving others intact', () => {
    // line 2: `He[G]llo` — edit G (col 2, len 3) → G7.
    const before = 'first\nHe[G]llo';
    const { text, caretOffset } = applyChordEdit(before, {
      line: 2,
      fromColumn: 2,
      fromLength: 3,
      chord: 'G7',
    });
    expect(text).toBe('first\nHe[G7]llo');
    // line1 "first"(5)+\n = 6, + col 2 ("He") + "[G7]"(4) = 12.
    expect(caretOffset).toBe(12);
  });

  test('round-trips buildChordName output through applyChordEdit', () => {
    const chord = buildChordName({ root: 'D', accidental: 'b', suffix: 'm7', bass: 'F' });
    expect(chord).toBe('Dbm7/F');
    const { text } = applyChordEdit('[Am]x', { line: 1, fromColumn: 0, fromLength: 4, chord });
    expect(text).toBe('[Dbm7/F]x');
  });

  test('throws on out-of-range line / span and on a forbidden chord', () => {
    expect(() =>
      applyChordEdit('a', { line: 5, fromColumn: 0, fromLength: 1, chord: 'C' }),
    ).toThrow(/line 5 out of range/);
    expect(() =>
      applyChordEdit('[Am]', { line: 1, fromColumn: 0, fromLength: 99, chord: 'C' }),
    ).toThrow(/exceeds line length/);
    expect(() =>
      applyChordEdit('[Am]', { line: 1, fromColumn: 0, fromLength: 4, chord: '' }),
    ).toThrow(/non-empty/);
    expect(() =>
      applyChordEdit('[Am]', { line: 1, fromColumn: 0, fromLength: 4, chord: 'C}evil' }),
    ).toThrow(/forbidden character/);
  });
});

describe('applyChordDelete', () => {
  test('removes the chord token, keeping the lyric', () => {
    const { text, caretOffset } = applyChordDelete('[Am]Hello', {
      line: 1,
      fromColumn: 0,
      fromLength: 4,
    });
    expect(text).toBe('Hello');
    expect(caretOffset).toBe(0);
  });

  test('removes a mid-line chord on the correct line', () => {
    const { text, caretOffset } = applyChordDelete('first\nHe[G]llo', {
      line: 2,
      fromColumn: 2,
      fromLength: 3,
    });
    expect(text).toBe('first\nHello');
    // "first"(5)+\n=6, +2 = 8
    expect(caretOffset).toBe(8);
  });

  test('throws on out-of-range line / span', () => {
    expect(() => applyChordDelete('a', { line: 9, fromColumn: 0, fromLength: 1 })).toThrow(
      /out of range/,
    );
    expect(() => applyChordDelete('[Am]', { line: 1, fromColumn: 0, fromLength: 99 })).toThrow(
      /exceeds line length/,
    );
  });
});

describe('applyChordEdit / applyChordDelete — expected-token guard', () => {
  test('applyChordEdit no-ops when the live span no longer matches `expected`', () => {
    // Stale event: source already advanced from `[C]` to `[Cm]`, but the
    // event still carries the old span (col 0, len 3) + expected 'C'.
    const { text } = applyChordEdit('[Cm]hi', {
      line: 1,
      fromColumn: 0,
      fromLength: 3,
      chord: 'C7',
      expected: 'C',
    });
    // Source unchanged — no `[C7]]hi` corruption.
    expect(text).toBe('[Cm]hi');
  });

  test('applyChordEdit applies when `expected` matches the live span', () => {
    const { text } = applyChordEdit('[C]hi', {
      line: 1,
      fromColumn: 0,
      fromLength: 3,
      chord: 'C7',
      expected: 'C',
    });
    expect(text).toBe('[C7]hi');
  });

  test('applyChordDelete no-ops on a stale `expected`', () => {
    const { text } = applyChordDelete('[Cm]hi', {
      line: 1,
      fromColumn: 0,
      fromLength: 3,
      expected: 'C',
    });
    expect(text).toBe('[Cm]hi');
  });

  test('applyChordDelete applies when `expected` matches the live span', () => {
    const { text } = applyChordDelete('[Am]hi', {
      line: 1,
      fromColumn: 0,
      fromLength: 4,
      expected: 'Am',
    });
    expect(text).toBe('hi');
  });
});
