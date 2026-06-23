import { describe, expect, test } from 'vitest';

import {
  CAPO_MAX,
  CAPO_MIN,
  TRANSPOSE_MAX,
  TRANSPOSE_MIN,
  activeKeyAtLine,
  applyChordDelete,
  applyChordEdit,
  applyChordInsert,
  applyChordReposition,
  buildChordName,
  buildChordNudge,
  capoTransposeOffset,
  caretInsideWrittenBracket,
  chordLayoutForLine,
  chordSelectionCaretOffset,
  chordSourceEditableUnderTranspose,
  chordSuffixFromQuality,
  composeChordSuffix,
  decomposeChordSuffix,
  enumerateEditorSuffixes,
  findChordAtCaret,
  findChordByOffsetOrdinal,
  isSeventhAvailable,
  isTensionAvailable,
  lyricsOffsetToSourceColumn,
  nudgeChordPosition,
  partsFromRawName,
  readCapo,
  repositionedChordOrdinal,
  setCapoInSource,
  sourceColumnToLyricsOffset,
  splitBassNote,
  toggleTension,
  withSeventh,
  withTriad,
  type ChordTypeSelection,
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

});

describe('structured chord-type model (ADR-0037)', () => {
  const sel = (
    triad: ChordTypeSelection['triad'],
    seventh: ChordTypeSelection['seventh'],
    tensions: ChordTypeSelection['tensions'] = [],
  ): ChordTypeSelection => ({ triad, seventh, tensions });

  test('composes explicit, unambiguous suffixes', () => {
    expect(composeChordSuffix(sel('maj', 'none'))).toBe('');
    expect(composeChordSuffix(sel('min', 'none'))).toBe('m');
    expect(composeChordSuffix(sel('maj', '7'))).toBe('7');
    expect(composeChordSuffix(sel('maj', 'maj7'))).toBe('maj7');
    expect(composeChordSuffix(sel('min', '7'))).toBe('m7');
    expect(composeChordSuffix(sel('min', 'maj7'))).toBe('mMaj7');
    expect(composeChordSuffix(sel('dim', '7'))).toBe('dim7');
    // Tensions stack into ascending, comma-separated parentheses.
    expect(composeChordSuffix(sel('maj', '7', ['13']))).toBe('7(13)');
    expect(composeChordSuffix(sel('maj', '7', ['13', '9', '11']))).toBe('7(9,11,13)');
    expect(composeChordSuffix(sel('maj', 'maj7', ['13']))).toBe('maj7(13)');
    expect(composeChordSuffix(sel('min', '7', ['b5']))).toBe('m7(b5)');
    expect(composeChordSuffix(sel('maj', '7', ['#5']))).toBe('7(#5)');
    // No seventh + a single natural tension is an add-tone chord; never `C(9)`.
    expect(composeChordSuffix(sel('maj', 'none', ['9']))).toBe('add9');
    expect(composeChordSuffix(sel('min', 'none', ['9']))).toBe('madd9');
    // Sixth chords carry no parentheses.
    expect(composeChordSuffix(sel('maj', 'none', ['6']))).toBe('6');
    expect(composeChordSuffix(sel('min', 'none', ['6']))).toBe('m6');
    expect(composeChordSuffix(sel('maj', 'none', ['6', '9']))).toBe('69');
  });

  test('composing never emits the ambiguous bare stack or seventh-less paren', () => {
    for (const suffix of enumerateEditorSuffixes()) {
      // No bare extended stack: a 9/11/13 only ever appears inside parens,
      // an add-tone, or the 6/9 chord.
      if (/\d/.test(suffix)) {
        const ok =
          suffix.includes('(') ||
          suffix.startsWith('add') ||
          suffix.includes('add') ||
          suffix === '5' ||
          suffix === '6' ||
          suffix === 'm6' ||
          suffix === '69' ||
          suffix === 'm69' ||
          /^(maj7|m7|mMaj7|aug7|augmaj7|dim7)/.test(suffix) ||
          /^7(sus[24]|\(|$)/.test(suffix) ||
          /sus[24]/.test(suffix);
        expect(ok, `suffix ${JSON.stringify(suffix)} must be explicit`).toBe(true);
      }
      // A parenthesised tension always sits on a seventh chord.
      if (suffix.includes('(')) {
        expect(/7\(|7sus[24]\(/.test(suffix), `${suffix} parens require a 7th`).toBe(true);
      }
    }
  });

  test('decompose round-trips every producible suffix', () => {
    for (const suffix of enumerateEditorSuffixes()) {
      const decomposed = decomposeChordSuffix(suffix);
      expect(decomposed, `decompose(${JSON.stringify(suffix)}) should be recognised`).not.toBeNull();
      expect(composeChordSuffix(decomposed!)).toBe(suffix);
    }
  });

  test('decompose normalises legacy / equivalent spellings', () => {
    // Bare extended stacks normalise to an explicit seventh + tensions.
    expect(composeChordSuffix(decomposeChordSuffix('13')!)).toBe('7(9,11,13)');
    expect(composeChordSuffix(decomposeChordSuffix('9')!)).toBe('7(9)');
    expect(composeChordSuffix(decomposeChordSuffix('m13')!)).toBe('m7(9,11,13)');
    expect(composeChordSuffix(decomposeChordSuffix('maj9')!)).toBe('maj7(9)');
    // Concatenated alterations normalise into parentheses.
    expect(composeChordSuffix(decomposeChordSuffix('7b9')!)).toBe('7(b9)');
    expect(composeChordSuffix(decomposeChordSuffix('m7b5')!)).toBe('m7(b5)');
    expect(composeChordSuffix(decomposeChordSuffix('7#5')!)).toBe('7(#5)');
  });

  test('decompose returns null for unmodelled suffixes (free-form fallback)', () => {
    // `9sus4` is free-form: tensions are not modelled on sus triads, so the
    // structured controls cannot represent it (the field edits it verbatim).
    for (const suffix of ['alt', '7alt', 'no3', 'xyz', '7(99)', 'add6', '9sus4', 'dim7(9)']) {
      expect(decomposeChordSuffix(suffix), suffix).toBeNull();
    }
  });

  test('availability rules forbid ambiguous / unvoiceable combinations', () => {
    // Power chord takes no seventh or tension.
    expect(isSeventhAvailable('5', '7')).toBe(false);
    expect(isTensionAvailable('5', 'none', '9')).toBe(false);
    // dim has only the diminished seventh.
    expect(isSeventhAvailable('dim', '7')).toBe(true);
    expect(isSeventhAvailable('dim', 'maj7')).toBe(false);
    // Tensions live on major / minor triads only.
    expect(isTensionAvailable('aug', '7', '9')).toBe(false);
    expect(isTensionAvailable('sus4', '7', '9')).toBe(false);
    expect(isTensionAvailable('maj', '7', '9')).toBe(true);
    // Altered tones require a seventh; the sixth requires none.
    expect(isTensionAvailable('maj', 'none', 'b9')).toBe(false);
    expect(isTensionAvailable('maj', '7', 'b9')).toBe(true);
    expect(isTensionAvailable('maj', '7', '6')).toBe(false);
    expect(isTensionAvailable('maj', 'none', '6')).toBe(true);
    // The exotic minor-major-7 takes no tensions.
    expect(isTensionAvailable('min', 'maj7', '9')).toBe(false);
  });

  test('toggle helpers drop tensions the new triad / seventh forbids', () => {
    // Clearing the seventh drops the altered tones but keeps a natural upper
    // tension (which becomes an add-tone chord).
    const dom = sel('maj', '7', ['b9', '13']);
    expect(withSeventh(dom, 'none').tensions).toEqual(['13']);
    expect(composeChordSuffix(withSeventh(dom, 'none'))).toBe('add13');
    // Switching to a triad that takes no tensions clears them.
    expect(withTriad(dom, 'aug').tensions).toEqual([]);
    // add9 / add11 / add13 are mutually exclusive with no seventh.
    const add9 = toggleTension(sel('maj', 'none'), '9');
    const add11 = toggleTension(add9, '11');
    expect(add11.tensions).toEqual(['11']);
  });

  test('every producible suffix builds a valid chord token', () => {
    // The composed suffix feeds straight into buildChordName; if any carried a
    // `/` or a structural char the edit would throw and silently drop.
    for (const suffix of enumerateEditorSuffixes()) {
      expect(() => buildChordName({ root: 'C', suffix })).not.toThrow();
      expect(buildChordName({ root: 'C', suffix })).toBe(`C${suffix}`);
    }
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

describe('capoTransposeOffset (mirrors core capo_validated 1..=24)', () => {
  test('returns 0 when no {capo} directive is present', () => {
    expect(capoTransposeOffset('{title: T}\nLa la')).toBe(0);
  });

  test('returns the value verbatim for 1..=24 (NO display clamp to 12)', () => {
    expect(capoTransposeOffset('{capo: 1}\n')).toBe(1);
    expect(capoTransposeOffset('{capo: 12}\n')).toBe(12);
    // The bug this guards: readCapo clamps 13..24 down to 12; the gate
    // must use the real value the core transposes by.
    expect(capoTransposeOffset('{capo: 13}\n')).toBe(13);
    expect(capoTransposeOffset('{capo: 24}\n')).toBe(24);
    expect(readCapo('{capo: 18}\n')).toBe(12); // sanity: readCapo DOES clamp
    expect(capoTransposeOffset('{capo: 18}\n')).toBe(18); // gate does not
  });

  test('returns 0 for out-of-range / malformed / negative (core treats as unset)', () => {
    expect(capoTransposeOffset('{capo: 0}\n')).toBe(0);
    expect(capoTransposeOffset('{capo: 25}\n')).toBe(0);
    expect(capoTransposeOffset('{capo: 300}\n')).toBe(0);
    expect(capoTransposeOffset('{capo: -3}\n')).toBe(0);
  });
});

describe('chordSourceEditableUnderTranspose', () => {
  test('editable when effective transpose is zero', () => {
    expect(chordSourceEditableUnderTranspose('La la', 0)).toBe(true);
    expect(chordSourceEditableUnderTranspose('La la', undefined)).toBe(true);
    // Coincidental cancellation is a genuine no-op transpose.
    expect(chordSourceEditableUnderTranspose('{capo: 2}\nLa', 2)).toBe(true);
  });

  test('NOT editable when a transpose or capo shifts the rendered chords', () => {
    expect(chordSourceEditableUnderTranspose('La la', 3)).toBe(false);
    expect(chordSourceEditableUnderTranspose('{capo: 5}\nLa', 0)).toBe(false);
  });

  test('regression: capo 13..24 is not clamped, so the gate stays correct', () => {
    // Pre-fix, readCapo(13)=12 made `12 - 12 === 0` → editing enabled on
    // a transposed AST (core effective = 12 - 13 = -1). Must be false now.
    expect(chordSourceEditableUnderTranspose('{capo: 13}\nLa', 12)).toBe(false);
    // And the genuine no-op at capo 18 / transpose 18 stays editable.
    expect(chordSourceEditableUnderTranspose('{capo: 18}\nLa', 18)).toBe(true);
  });
});

describe('chordLayoutForLine', () => {
  test('chord-less line: every segment column equals its lyrics offset', () => {
    const { layout, totalLyrics } = chordLayoutForLine([{ text: 'Hello' }]);
    expect(layout).toEqual([{ sourceColumn: 0, bracketLength: 0, lyricsOffsetStart: 0 }]);
    expect(totalLyrics).toBe(5);
  });

  test('accounts for bracket width when accumulating source columns', () => {
    // Source: `[C]do[Am]re` → seg0 {C,"do"}, seg1 {Am,"re"}.
    const { layout, totalLyrics } = chordLayoutForLine([
      { text: 'do', chord: { name: 'C' } },
      { text: 're', chord: { name: 'Am' } },
    ]);
    expect(layout).toEqual([
      { sourceColumn: 0, bracketLength: 3, lyricsOffsetStart: 0 }, // [C]
      { sourceColumn: 5, bracketLength: 4, lyricsOffsetStart: 2 }, // [Am] after `[C]do`
    ]);
    expect(totalLyrics).toBe(4);
  });

  test('matches the column applyChordEdit expects (round-trips with the editor)', () => {
    const segs = [{ text: 'hi', chord: { name: 'Am' } }];
    const { layout } = chordLayoutForLine(segs);
    const source = '[Am]hi';
    expect(source.slice(layout[0].sourceColumn, layout[0].sourceColumn + layout[0].bracketLength)).toBe(
      '[Am]',
    );
  });

  test('uses the parser-supplied source column over reconstruction (#2634)', () => {
    // Source `do\[re[Am]mi`: the escaped `\[` makes seg0 text `do[re` (5
    // chars) span SIX source columns. Reconstruction from `seg.text.length`
    // would place `[Am]` at column 5; the AST column is the real 6.
    const source = 'do\\[re[Am]mi';
    const segs = [
      { text: 'do[re', sourceColumn: null }, // chord-less leading segment
      { text: 'mi', chord: { name: 'Am' }, sourceColumn: 6 },
    ];
    const { layout } = chordLayoutForLine(segs);
    expect(layout[1].sourceColumn).toBe(6);
    // The reported span is exactly the `[Am]` in the raw source.
    expect(
      source.slice(layout[1].sourceColumn, layout[1].sourceColumn + layout[1].bracketLength),
    ).toBe('[Am]');
  });

  test('falls back to reconstruction when the AST omits sourceColumn', () => {
    // Older `@chordsketch/wasm` builds (or non-parser segments) have no
    // sourceColumn; the running reconstruction still produces the columns it
    // always did for escape-free lines.
    const { layout } = chordLayoutForLine([
      { text: 'do', chord: { name: 'C' } },
      { text: 're', chord: { name: 'Am' } },
    ]);
    expect(layout.map((l) => l.sourceColumn)).toEqual([0, 5]);
  });

  test('resyncs the running column after an authoritative value', () => {
    // A later field-less chord stays aligned because the running counter is
    // resynced to the authoritative column of the earlier one.
    const { layout } = chordLayoutForLine([
      { text: 'do[re', sourceColumn: null }, // 5 visible chars, 6 source cols
      { text: 'mi', chord: { name: 'Am' }, sourceColumn: 6 }, // authoritative
      { text: 'fa', chord: { name: 'G' } }, // no field → reconstructed from 6
    ]);
    // [Am] at 6, then `[Am]mi` = 6 cols → [G] at 6 + 4 + 2 = 12.
    expect(layout.map((l) => l.sourceColumn)).toEqual([0, 6, 12]);
  });
});

describe('escaped-special source scanning (#2634)', () => {
  // The documented failing case: editing / nudging `[Am]` on a line where an
  // escaped `\[` precedes it must target the real `[Am]` span, not drift.
  const SOURCE = 'do\\[re[Am]mi';

  test('findChordAtCaret resolves the chord after an escaped special', () => {
    // Caret on the `[` of `[Am]` (raw column 6).
    const match = findChordAtCaret(SOURCE, 6);
    expect(match).not.toBeNull();
    expect(match!.chordName).toBe('Am');
    expect(match!.sourceColumn).toBe(6);
    expect(match!.bracketLength).toBe(4);
    // Lyrics offset counts the escaped `[` as one visible char: `do[re` = 5.
    expect(match!.offset).toBe(5);
    // The resolved span is the real `[Am]`.
    expect(SOURCE.slice(match!.sourceColumn, match!.sourceColumn + match!.bracketLength)).toBe(
      '[Am]',
    );
  });

  test('the escaped `\\[` is not mis-detected as a chord open', () => {
    // Caret inside `do\[re` (column 4, the escaped `[`) is lyrics, not a chord.
    expect(findChordAtCaret(SOURCE, 4)).toBeNull();
  });

  test('applyChordEdit targets the correct span (not a no-op, not corruption)', () => {
    const match = findChordAtCaret(SOURCE, 6)!;
    const { text } = applyChordEdit(SOURCE, {
      line: 1,
      fromColumn: match.sourceColumn,
      fromLength: match.bracketLength,
      chord: 'Bm',
      expected: match.chordName,
    });
    // The edit applied (not the silent no-op the `expected` guard would emit
    // on a drifted column) and rewrote exactly `[Am]` → `[Bm]`.
    expect(text).toBe('do\\[re[Bm]mi');
  });

  test('a drifted (reconstructed) column would have no-opped — proving the fix matters', () => {
    // Demonstrate the pre-fix behaviour: the reconstructed column 5 spans
    // `e[Am` not `[Am]`, so the `expected` guard no-ops (safe but dropped).
    const drifted = 5;
    const { text } = applyChordEdit(SOURCE, {
      line: 1,
      fromColumn: drifted,
      fromLength: 4,
      chord: 'Bm',
      expected: 'Am',
    });
    expect(text).toBe(SOURCE); // unchanged — the bug this PR fixes
  });

  test('buildChordNudge moves the chord by the real span across an escape', () => {
    const match = findChordAtCaret(SOURCE, 6)!;
    const nudge = buildChordNudge({
      sourceLine: 1,
      chordName: match.chordName,
      sourceColumn: match.sourceColumn,
      bracketLength: match.bracketLength,
      currentOffset: match.offset,
      otherOffsets: match.otherOffsets,
      totalLyrics: match.totalLyrics,
      direction: 1,
    });
    expect(nudge).not.toBeNull();
    const { text } = applyChordReposition(SOURCE, nudge!.event);
    // `[Am]` moves one visible lyric char right: from before `mi` to between
    // `m` and `i` → `do\[remi` with `[Am]` after the `m`.
    expect(text).toBe('do\\[rem[Am]i');
  });

  test('lyricsOffsetToSourceColumn accounts for an escaped special', () => {
    // `do\[re` is 5 visible lyric chars over 6 source columns. Offset 5
    // (after the last visible char `e`) maps to source column 6.
    expect(lyricsOffsetToSourceColumn('do\\[re', 5)).toBe(6);
    // Offset 2 (the escaped `[`) sits at source column 2 (the backslash).
    expect(lyricsOffsetToSourceColumn('do\\[re', 2)).toBe(2);
  });

  test('sourceColumnToLyricsOffset is the inverse across an escaped special', () => {
    // Column 6 (after `do\[re`) is 5 visible lyric chars in.
    expect(sourceColumnToLyricsOffset('do\\[re', 6)).toBe(5);
  });

  test('a chord whose name contains an escaped bracket is not split early', () => {
    // `[A\]m]` is ONE chord spanning to the final `]` (column 5), not split at
    // the escaped `\]`. The caret-driven path keeps the RAW name so it
    // round-trips the source for the edit `expected` guard.
    const match = findChordAtCaret('[A\\]m]x', 0)!;
    expect(match.chordName).toBe('A\\]m'); // raw — round-trips the source span
    expect(match.bracketLength).toBe(6);
    expect('[A\\]m]x'.slice(match.sourceColumn, match.sourceColumn + match.bracketLength)).toBe(
      '[A\\]m]',
    );
  });

  test('editing an escaped-bracket-name chord round-trips via the raw-scan path', () => {
    // Because the name is raw, the `expected` guard matches the live source
    // and the edit applies (the AST path no-ops these — documented edge).
    const source = '[A\\]m]x';
    const match = findChordAtCaret(source, 0)!;
    const { text } = applyChordEdit(source, {
      line: 1,
      fromColumn: match.sourceColumn,
      fromLength: match.bracketLength,
      chord: 'C',
      expected: match.chordName,
    });
    expect(text).toBe('[C]x');
  });
});

describe('applyChordReposition — expected-token guard (parity with edit/delete)', () => {
  test('move no-ops when the live `from` span no longer matches `expected`', () => {
    // Stale/drifted span: source has `[C]` at col 0 but the event expects `[Am]`.
    const before = '[C]hi';
    const { text } = applyChordReposition(before, {
      fromLine: 1,
      fromColumn: 0,
      fromLength: 4,
      toLine: 1,
      toLyricsOffset: 2,
      chord: 'Am',
      copy: false,
      expected: 'Am',
    });
    expect(text).toBe(before); // unchanged — no corruption
  });

  test('move applies when `expected` matches the live span', () => {
    const { text } = applyChordReposition('[Am]hi', {
      fromLine: 1,
      fromColumn: 0,
      fromLength: 4,
      toLine: 1,
      toLyricsOffset: 2,
      chord: 'Am',
      copy: false,
      expected: 'Am',
    });
    expect(text).toBe('hi[Am]');
  });

  test('copy ignores `expected` (nothing is removed)', () => {
    const { text } = applyChordReposition('hi', {
      fromLine: 1,
      fromColumn: 0,
      fromLength: 4,
      toLine: 1,
      toLyricsOffset: 0,
      chord: 'Am',
      copy: true,
      expected: 'whatever',
    });
    expect(text).toBe('[Am]hi');
  });

  test('shares the structural denylist with the other writers (rejects `>`)', () => {
    // Pre-fix, applyChordReposition inlined a denylist that omitted `>`.
    expect(() =>
      applyChordReposition('hi', {
        fromLine: 1,
        fromColumn: 0,
        fromLength: 0,
        toLine: 1,
        toLyricsOffset: 0,
        chord: 'A>',
        copy: true,
      }),
    ).toThrow(/forbidden/);
  });
});

describe('caretInsideWrittenBracket', () => {
  test('lands just after the `[` of a repositioned chord', () => {
    // `[Am]hi` → move Am to the end → `hi[Am]`; caretOffset points past
    // the `]` (6). The inside-bracket caret must be just after `[` (3).
    const result = applyChordReposition('[Am]hi', {
      fromLine: 1,
      fromColumn: 0,
      fromLength: 4,
      toLine: 1,
      toLyricsOffset: 2,
      chord: 'Am',
      copy: false,
      expected: 'Am',
    });
    expect(result.text).toBe('hi[Am]');
    expect(result.caretOffset).toBe(6); // just past `]`
    expect(caretInsideWrittenBracket(result, 'Am')).toBe(3); // just after `[`
  });

  test('lands just after the `[` of a freshly inserted chord', () => {
    // Insert `[G]` at column 2 of `hi` → `hi[G]`; caret inside → 3.
    const result = applyChordInsert('hi', { line: 1, column: 2, chord: 'G' });
    expect(result.text).toBe('hi[G]');
    expect(caretInsideWrittenBracket(result, 'G')).toBe(3);
  });
});

describe('buildChordNudge sets the expected-token guard on its move event', () => {
  test('expected equals the moved chord name', () => {
    const result = buildChordNudge({
      sourceLine: 1,
      chordName: 'Am7',
      sourceColumn: 0,
      bracketLength: 5,
      currentOffset: 0,
      otherOffsets: [],
      totalLyrics: 4,
      direction: 1,
    });
    expect(result).not.toBeNull();
    expect(result!.event.expected).toBe('Am7');
    expect(result!.event.copy).toBe(false);
  });
});

describe('repositionedChordOrdinal', () => {
  // Destination line `[Am]Hello [G]World` — chords at offsets 0 and 6.
  test('cross-line move / copy counts every chord at the offset', () => {
    // Nothing removed from the destination line (removedIndex = -1):
    // dropping a third chord at offset 0 lands after the existing one.
    expect(repositionedChordOrdinal(0, [0, 6], -1)).toBe(1);
    // Offset with no existing chord → ordinal 0.
    expect(repositionedChordOrdinal(3, [0, 6], -1)).toBe(0);
    // Stacked chords `[A][B][C]word` all at offset 0 → a fourth lands 3rd.
    expect(repositionedChordOrdinal(0, [0, 0, 0], -1)).toBe(3);
  });

  test('same-line move excludes the dragged chord from the count', () => {
    // Dragging the chord at index 0 (offset 0) to offset 6: it is removed
    // from the destination line first, so only the chord already at 6
    // counts → the moved chord lands after it (ordinal 1).
    expect(repositionedChordOrdinal(6, [0, 6], 0)).toBe(1);
    // Dragging the chord at offset 6 (index 1) back to offset 0: the
    // chord at 0 stays, so the moved chord lands after it (ordinal 1).
    expect(repositionedChordOrdinal(0, [0, 6], 1)).toBe(1);
    // Moving a chord to an offset only it occupied → ordinal 0.
    expect(repositionedChordOrdinal(0, [0], 0)).toBe(0);
  });
});

describe('partsFromRawName', () => {
  test('splits root / accidental / suffix / bass and round-trips', () => {
    expect(partsFromRawName('Bbm7/F')).toEqual({
      root: 'B',
      accidental: 'b',
      suffix: 'm7',
      bass: 'F',
    });
    expect(buildChordName(partsFromRawName('Bbm7/F'))).toBe('Bbm7/F');
  });

  test('bare major triad has empty accidental + suffix', () => {
    expect(partsFromRawName('G')).toEqual({ root: 'G', accidental: '', suffix: '', bass: '' });
  });

  test('sharp root + slash bass', () => {
    expect(partsFromRawName('F#7/A#')).toEqual({
      root: 'F',
      accidental: '#',
      suffix: '7',
      bass: 'A#',
    });
  });

  test('rootless / non-standard name yields empty root (un-editable, not corrupted)', () => {
    expect(partsFromRawName('N.C.')).toEqual({
      root: '',
      accidental: '',
      suffix: 'N.C.',
      bass: '',
    });
    // buildChordName rejects an empty root, so a stray edit is dropped
    // rather than defaulting the root and corrupting the token.
    expect(() => buildChordName(partsFromRawName('N.C.'))).toThrow();
  });
});

describe('splitBassNote', () => {
  test('splits a plain bass note into letter + natural accidental', () => {
    expect(splitBassNote('G')).toEqual({ note: 'G', accidental: '' });
  });

  test('splits a sharp / flat bass note', () => {
    expect(splitBassNote('F#')).toEqual({ note: 'F', accidental: '#' });
    expect(splitBassNote('Bb')).toEqual({ note: 'B', accidental: 'b' });
  });

  test('round-trips with the picker concatenation', () => {
    for (const token of ['C', 'F#', 'Bb', 'A', 'E']) {
      const split = splitBassNote(token);
      expect(split).not.toBeNull();
      expect(`${split!.note}${split!.accidental}`).toBe(token);
    }
  });

  test('an empty token (no bass) is not a plain note', () => {
    expect(splitBassNote('')).toBeNull();
  });

  test('a non-plain-note bass yields null (free-form, picker stays unpressed)', () => {
    // A figured / compound bass, a lower-case letter, a double accidental, and
    // a stray suffix are all outside the single-note grammar the picker models.
    expect(splitBassNote('G7')).toBeNull();
    expect(splitBassNote('g')).toBeNull();
    expect(splitBassNote('F##')).toBeNull();
    expect(splitBassNote('H')).toBeNull();
    expect(splitBassNote('F# ')).toBeNull();
  });
});

describe('findChordAtCaret', () => {
  // Source: line 0 is a directive, line 1 has the chords. Absolute
  // offset of line 1 is `"{title: T}".length + 1` = 11.
  const source = '{title: T}\n[G]Almost [Bbm7]heaven';
  const line1Start = source.indexOf('\n') + 1; // 11

  test('caret inside a bracket selects that chord', () => {
    // Caret inside `[Bbm7]` (on the "b" of the body).
    const at = source.indexOf('Bbm7');
    const match = findChordAtCaret(source, at);
    expect(match).not.toBeNull();
    expect(match!.chordName).toBe('Bbm7');
    expect(match!.line).toBe(2);
    expect(match!.sourceColumn).toBe('[G]Almost '.length);
    expect(match!.bracketLength).toBe('[Bbm7]'.length);
    expect(match!.parts).toEqual({ root: 'B', accidental: 'b', suffix: 'm7', bass: '' });
    // "Almost " = 7 lyric chars before the 2nd chord.
    expect(match!.offset).toBe(7);
    expect(match!.ordinal).toBe(0);
    expect(match!.otherOffsets).toEqual([0]);
    expect(match!.totalLyrics).toBe('Almost heaven'.length);
  });

  test('caret on the opening bracket selects the chord', () => {
    const match = findChordAtCaret(source, line1Start); // column 0 = `[` of [G]
    expect(match).not.toBeNull();
    expect(match!.chordName).toBe('G');
    expect(match!.offset).toBe(0);
  });

  test('caret in the lyrics (not on a chord) returns null', () => {
    const at = source.indexOf('Almost'); // just after `]` of [G], on the lyric
    expect(findChordAtCaret(source, at)).toBeNull();
  });

  test('caret on a directive line returns null', () => {
    expect(findChordAtCaret(source, 3)).toBeNull();
  });

  test('stacked chords [A][B]: caret at the `][` boundary selects the right chord', () => {
    const stacked = '[A][B]word';
    // `]` of [A] is at col 2; col 3 is the `[` of [B].
    const right = findChordAtCaret(stacked, 3);
    expect(right).not.toBeNull();
    expect(right!.chordName).toBe('B');
    expect(right!.ordinal).toBe(1); // 2nd chord sharing lyrics offset 0
    expect(right!.offset).toBe(0);
    // Inside [A].
    const left = findChordAtCaret(stacked, 1);
    expect(left!.chordName).toBe('A');
    expect(left!.ordinal).toBe(0);
  });

  test('out-of-range caret offset clamps and does not throw', () => {
    expect(findChordAtCaret(source, 9999)).toBeNull();
    expect(findChordAtCaret(source, -5)).toBeNull();
  });
});

describe('applyChordInsert', () => {
  test('inserts a new [chord] at the caret column', () => {
    const source = 'Almost heaven';
    const result = applyChordInsert(source, { line: 1, column: 7, chord: 'Bbm7' });
    expect(result.text).toBe('Almost [Bbm7]heaven');
    // Caret lands just past the inserted bracket.
    expect(result.caretOffset).toBe('Almost [Bbm7]'.length);
  });

  test('clamps a past-end column to the line end', () => {
    const result = applyChordInsert('hi', { line: 1, column: 99, chord: 'C' });
    expect(result.text).toBe('hi[C]');
  });

  test('snaps out of an existing bracket so it cannot split a token', () => {
    // Caret column 2 is strictly inside `[Am]` (between A and m).
    const result = applyChordInsert('[Am]word', { line: 1, column: 2, chord: 'C' });
    // Insertion snaps to just after `]` of [Am].
    expect(result.text).toBe('[Am][C]word');
  });

  test('inserts on the correct line in a multi-line source', () => {
    const source = '{title: T}\nAlmost heaven';
    const result = applyChordInsert(source, { line: 2, column: 0, chord: 'G' });
    expect(result.text).toBe('{title: T}\n[G]Almost heaven');
  });

  test('rejects a structurally dangerous chord body', () => {
    expect(() => applyChordInsert('hi', { line: 1, column: 0, chord: 'A]B' })).toThrow();
    expect(() => applyChordInsert('hi', { line: 1, column: 0, chord: '' })).toThrow();
  });

  test('throws on an out-of-range line', () => {
    expect(() => applyChordInsert('hi', { line: 5, column: 0, chord: 'C' })).toThrow();
  });
});

describe('chordSelectionCaretOffset', () => {
  const source = '{title: T}\n[G]Almost [Bbm7]heaven';

  test('round-trips with findChordAtCaret', () => {
    const at = source.indexOf('Bbm7');
    const match = findChordAtCaret(source, at)!;
    const offset = chordSelectionCaretOffset(source, match);
    expect(offset).not.toBeNull();
    // The resolved offset points at the chord's `[`, which is itself a
    // caret position on the chord — findChordAtCaret re-resolves it.
    expect(findChordAtCaret(source, offset!)!.chordName).toBe('Bbm7');
  });

  test('resolves stacked chords by ordinal', () => {
    const stacked = '[A][B]word';
    expect(chordSelectionCaretOffset(stacked, { line: 1, offset: 0, ordinal: 0 })).toBe(0);
    expect(chordSelectionCaretOffset(stacked, { line: 1, offset: 0, ordinal: 1 })).toBe(3);
  });

  test('returns null for a selection that no longer maps to a chord', () => {
    expect(chordSelectionCaretOffset(source, { line: 2, offset: 0, ordinal: 5 })).toBeNull();
    expect(chordSelectionCaretOffset(source, { line: 9, offset: 0, ordinal: 0 })).toBeNull();
  });
});

describe('activeKeyAtLine', () => {
  test('returns null before any key directive', () => {
    const src = '[C]Hello\n{key: G}\n[G]world';
    // Line 1 precedes the key directive → no key in effect yet.
    expect(activeKeyAtLine(src, 1)).toBeNull();
  });

  test('resolves the key declared on or above the given line', () => {
    const src = '{key: G}\n[G]first\n[D]second';
    expect(activeKeyAtLine(src, 1)).toBe('G');
    expect(activeKeyAtLine(src, 2)).toBe('G');
    expect(activeKeyAtLine(src, 3)).toBe('G');
  });

  test('honours mid-song modulation (last key wins per position)', () => {
    const src = ['{key: C}', '[C]verse', '{key: A}', '[A]chorus', '[E]chorus'].join('\n');
    // The chord on line 2 sounds in C; the chords on lines 4-5 sound in A.
    expect(activeKeyAtLine(src, 2)).toBe('C');
    expect(activeKeyAtLine(src, 4)).toBe('A');
    expect(activeKeyAtLine(src, 5)).toBe('A');
  });

  test('accepts the colon-less attribute form `{key VALUE}`', () => {
    expect(activeKeyAtLine('{key Bb}\n[Bb]x', 2)).toBe('Bb');
  });

  test('accepts the generic-metadata `{meta: key VALUE}` form', () => {
    expect(activeKeyAtLine('{meta: key Em}\n[Em]x', 2)).toBe('Em');
    expect(activeKeyAtLine('{meta key F#m}\n[F#m]x', 2)).toBe('F#m');
  });

  test('matches the directive name case-insensitively and trims the value', () => {
    expect(activeKeyAtLine('{KEY:   D }\n[D]x', 2)).toBe('D');
  });

  test('ignores non-key directives, empty keys, and selector-suffixed keys', () => {
    expect(activeKeyAtLine('{title: Song}\n[C]x', 2)).toBeNull();
    expect(activeKeyAtLine('{key:}\n[C]x', 2)).toBeNull();
    // A conditional `{key-guitar}` applies only under an instrument filter and
    // does not define the plain editor view's key.
    expect(activeKeyAtLine('{key-guitar: G}\n[G]x', 2)).toBeNull();
  });

  test('a later key directive does not leak to lines above it', () => {
    const src = '[C]top\n{key: G}\n[G]below';
    expect(activeKeyAtLine(src, 1)).toBeNull();
    expect(activeKeyAtLine(src, 3)).toBe('G');
  });

  test('clamps an out-of-range line to the document', () => {
    expect(activeKeyAtLine('{key: G}\n[G]x', 99)).toBe('G');
  });

  test('handles an unterminated brace with much whitespace linearly (no ReDoS)', () => {
    // A `{` followed by a long whitespace run and no closing `}` must not
    // trigger quadratic regex backtracking (the directive scanner runs per
    // line on every keystroke). The line is not a directive, so the result
    // is null — and it must return promptly.
    const malformed = `{${' '.repeat(100_000)}`;
    const start = Date.now();
    expect(activeKeyAtLine(`${malformed}\n[C]x`, 2)).toBeNull();
    // Generous bound: the linear scan completes in well under this; the
    // O(n²) regex this guards against took seconds at this length.
    expect(Date.now() - start).toBeLessThan(1000);
  });

  test('still resolves a key on a line that also carries other braces', () => {
    // The scanner takes the first brace group; a normal key line resolves.
    expect(activeKeyAtLine('{key: A}', 1)).toBe('A');
  });
});
