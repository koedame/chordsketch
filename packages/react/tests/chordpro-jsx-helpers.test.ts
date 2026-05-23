/**
 * Unit tests for the small helper exports of `chordpro-jsx.tsx`
 * (`unicodeAccidentals`, `tokenizeGridLine`, `lyricsCaretRatio`).
 * The end-to-end walker is exercised separately in
 * `chordpro-jsx.test.tsx`; these tests pin the helpers'
 * contracts so future refactors can change the renderer without
 * silently regressing the parsing / mapping logic.
 *
 * Closes the parallel-review Medium finding "tokenizeGridLine /
 * lyricsCaretRatio / unicodeAccidentals have no direct unit
 * tests".
 */

import { describe, expect, test } from 'vitest';

import {
  lyricsCaretRatio,
  tokenizeGridLine,
  unicodeAccidentals,
  extractGridLabel,
  parseGridShape,
} from '../src/chordpro-jsx';

describe('unicodeAccidentals', () => {
  test.each([
    // Root accidentals.
    ['Bb', 'B♭'],
    ['Eb7', 'E♭7'],
    ['F#m', 'F♯m'],
    ['Bb/Eb', 'B♭/E♭'],
    ['Bbm7', 'B♭m7'],
    ['C', 'C'],
    ['Am', 'Am'],
    ['Cdim', 'Cdim'],
    ['Cmaj7', 'Cmaj7'],
    // Extension accidentals (`b<digit>` / `#<digit>`) inside
    // chord-quality strings turn into proper musical flats /
    // sharps. Sister-site to `unicode_accidentals_extension_
    // alterations` in `crates/chordpro/src/typography.rs`.
    ['Gb7(b9)', 'G♭7(♭9)'],
    ['Cmaj7#11', 'Cmaj7♯11'],
    ['D7b13', 'D7♭13'],
    ['G7(b9,#11)', 'G7(♭9,♯11)'],
    // `b`/`#` not followed by a digit stays as-is (chord-
    // quality letter / non-alteration glyph).
    ['Cm7', 'Cm7'],
  ])('%s → %s', (input, expected) => {
    expect(unicodeAccidentals(input)).toBe(expected);
  });

  test('survives non-ASCII text intact', () => {
    expect(unicodeAccidentals('中文')).toBe('中文');
  });
});

describe('tokenizeGridLine', () => {
  test('splits a simple bar into cell tokens and a barline', () => {
    const tokens = tokenizeGridLine('| G  .  .  . |');
    // Filter spaces for readability — they collapse into one
    // `space` token per whitespace run.
    const nonSpace = tokens.filter((t) => t.kind !== 'space');
    expect(nonSpace).toEqual([
      { kind: 'barline' },
      { kind: 'cell', names: ['G'] },
      { kind: 'continuation' },
      { kind: 'continuation' },
      { kind: 'continuation' },
      { kind: 'barline' },
    ]);
  });

  test('recognises repeat-start and repeat-end markers', () => {
    const tokens = tokenizeGridLine('|: G :|');
    const kinds = tokens.filter((t) => t.kind !== 'space').map((t) => t.kind);
    expect(kinds).toEqual(['repeat-start', 'cell', 'repeat-end']);
  });

  test('recognises combined `:|:` repeat-both marker', () => {
    const tokens = tokenizeGridLine('| G :|: C |');
    const kinds = tokens.filter((t) => t.kind !== 'space').map((t) => t.kind);
    expect(kinds).toEqual(['barline', 'cell', 'repeat-both', 'cell', 'barline']);
  });

  test('recognises volta endings', () => {
    const tokens = tokenizeGridLine('|1 Em |2 Am');
    const voltas = tokens.filter((t) => t.kind === 'volta');
    expect(voltas).toEqual([
      { kind: 'volta', ending: 1 },
      { kind: 'volta', ending: 2 },
    ]);
  });

  test('recognises final, double, and no-chord markers', () => {
    const tokens = tokenizeGridLine('| Em | n || G |.');
    const kinds = tokens.filter((t) => t.kind !== 'space').map((t) => t.kind);
    expect(kinds).toContain('final');
    expect(kinds).toContain('double');
    expect(kinds).toContain('no-chord');
  });

  test('unwraps bracketed chord names like `[Am]`', () => {
    const tokens = tokenizeGridLine('| [Am] [C] |');
    const cells = tokens.filter((t) => t.kind === 'cell');
    expect(cells).toEqual([
      { kind: 'cell', names: ['Am'] },
      { kind: 'cell', names: ['C'] },
    ]);
  });

  test('recognises standalone `%` (single-bar) and `%%` (two-bar) repeat cells', () => {
    const tokens = tokenizeGridLine('| % . | %% . |');
    const kinds = tokens.filter((t) => t.kind !== 'space').map((t) => t.kind);
    expect(kinds).toEqual([
      'barline',
      'percent1',
      'continuation',
      'barline',
      'percent2',
      'continuation',
      'barline',
    ]);
  });

  test('splits cell-internal `~` into multi-chord names', () => {
    const tokens = tokenizeGridLine('| C~G ~A |');
    const cells = tokens.filter((t) => t.kind === 'cell');
    // First cell: `C~G` → ['C', 'G'] (two chords sharing a beat).
    // Second cell: `~A` → ['', 'A'] (leading-tilde anticipation form;
    // empty string preserved so renderer can decide whether to show
    // the tick).
    expect(cells).toEqual([
      { kind: 'cell', names: ['C', 'G'] },
      { kind: 'cell', names: ['', 'A'] },
    ]);
  });

  test('emits nothing for an empty / whitespace-only input', () => {
    expect(tokenizeGridLine('').length).toBe(0);
    // Whitespace-only collapses to a single space token.
    expect(tokenizeGridLine('   ').filter((t) => t.kind !== 'space').length).toBe(0);
  });

  test('treats a chord whose name starts with `n` as a chord, not no-chord', () => {
    // `nb13` is not a real chord name but is the kind of token
    // the tokenizer's `n` no-chord branch must not greedily
    // swallow. The `n`-no-chord rule fires only when the next
    // char is whitespace / bar.
    const tokens = tokenizeGridLine('| nb13 |');
    const chord = tokens.find((t) => t.kind === 'cell');
    expect(chord).toEqual({ kind: 'cell', names: ['nb13'] });
  });

  // Regression tests for #2556 — sister-site to the same
  // cases in `crates/chordpro/src/grid.rs`. See the production
  // guard in `tokenizeGridLine` for the mechanism; these tests
  // pin the user-observable contract.
  test('drops a bare trailing `:` without hanging the tokenizer', () => {
    // Mid-edit state captured from the kitchen-sink sample: a
    // grid row whose final `|` has been deleted but the trailing
    // `:` survives. Pre-fix this input made `tokenizeGridLine`
    // spin without forward progress.
    const input = '|: C7 . | %  . :|: G7 . | %  . :';
    const nonSpace = tokenizeGridLine(input).filter((t) => t.kind !== 'space');
    // Assert full token shape (not just kinds): catches a
    // regression that swaps `repeat-both` for `barline` or
    // mangles the surviving chord names.
    expect(nonSpace).toEqual([
      { kind: 'repeat-start' },
      { kind: 'cell', names: ['C7'] },
      { kind: 'continuation' },
      { kind: 'barline' },
      { kind: 'percent1' },
      { kind: 'continuation' },
      { kind: 'repeat-both' },
      { kind: 'cell', names: ['G7'] },
      { kind: 'continuation' },
      { kind: 'barline' },
      { kind: 'percent1' },
      { kind: 'continuation' },
    ]);
  });

  test('emits no tokens for a lone `:`', () => {
    expect(tokenizeGridLine(':')).toEqual([]);
  });

  test('drops a run of `:` and still terminates', () => {
    // Drives the no-progress guard through multiple iterations.
    // A regression that reverted the unconditional `i += 1`
    // would hang here under vitest's per-test timeout.
    expect(tokenizeGridLine(':::::::')).toEqual([]);
  });

  test('drops a `:` sitting between two cells', () => {
    const cells = tokenizeGridLine('C : D').filter((t) => t.kind === 'cell');
    expect(cells).toEqual([
      { kind: 'cell', names: ['C'] },
      { kind: 'cell', names: ['D'] },
    ]);
  });

  test('terminates for arbitrary inputs drawn from the dispatch alphabet', () => {
    // Property check: the outer loop must terminate for any
    // input drawn from the dispatch alphabet, regardless of
    // ordering. Generated deterministically from a small LCG so
    // the corpus survives across runs. A regression that
    // reintroduces the no-progress shape would hang one of the
    // cases here under vitest's per-test timeout.
    const alphabet = '|:.%~ \t[]nstC7G:1234ABs';
    let state = 0xc0ffee;
    for (let n = 0; n < 256; n++) {
      const len = state % 48;
      let s = '';
      for (let k = 0; k < len; k++) {
        state = (Math.imul(state, 1103515245) + 12345) >>> 0;
        s += alphabet[(state >>> 16) % alphabet.length];
      }
      // Calling tokenizeGridLine is enough — if it doesn't
      // return, vitest's harness times the test out.
      tokenizeGridLine(s);
    }
  });
});

describe('lyricsCaretRatio', () => {
  // Source: `[Am]Hello World`. AST has one segment with
  // chord.name = "Am" and text = "Hello World" (11 chars). The
  // `[Am]` bracket takes 4 source chars before the text.
  const lineWithChord = {
    segments: [
      {
        chord: { name: 'Am', detail: null, display: null },
        text: 'Hello World',
        spans: [],
      },
    ],
  };

  test('caret at start of source (col 0) maps to lyrics column 0 → 0%', () => {
    expect(lyricsCaretRatio(lineWithChord, 0, 15)).toBe(0);
  });

  test('caret inside the chord bracket snaps to lyrics start', () => {
    // Source col 2 = inside `[Am]` (between "A" and "m").
    // Should snap to the start of the lyrics text (col 0).
    expect(lyricsCaretRatio(lineWithChord, 2, 15)).toBe(0);
  });

  test('caret immediately after the bracket lands on lyrics col 0', () => {
    expect(lyricsCaretRatio(lineWithChord, 4, 15)).toBe(0);
  });

  test('caret in the middle of the lyrics text maps correctly', () => {
    // Source col 9 = between "Hello" and " World".
    // Lyrics offset = 9 - 4 = 5; ratio = 5 / 11 ≈ 0.4545.
    const r = lyricsCaretRatio(lineWithChord, 9, 15);
    expect(r).toBeCloseTo(5 / 11, 4);
  });

  test('caret past the line end pins to the rightmost lyrics column', () => {
    expect(lyricsCaretRatio(lineWithChord, 999, 15)).toBe(1);
  });

  test('chord-only line (no lyrics text) falls back to source-column ratio', () => {
    // A line with a single chord and empty text — the function
    // can't divide by total lyrics, so it falls back to the
    // linear `caretColumn / max(caretLineLength, 1)` ratio.
    const chordOnly = {
      segments: [{ chord: { name: 'G', detail: null, display: null }, text: '', spans: [] }],
    };
    expect(lyricsCaretRatio(chordOnly, 1, 4)).toBe(0.25);
  });

  test('chord-less line treats every char as lyrics', () => {
    const chordless = {
      segments: [{ chord: null, text: 'hello-text', spans: [] }],
    };
    // 5 / 10 = 0.5.
    expect(lyricsCaretRatio(chordless, 5, 10)).toBe(0.5);
  });

  test('multi-segment line with two chord brackets', () => {
    // `[G]hello [C]world` — segment 1 chord=G text="hello ",
    // segment 2 chord=C text="world". Source positions:
    // - chars 0-2 = `[G]`
    // - chars 3-8 = `hello ` (6 chars)
    // - chars 9-11 = `[C]`
    // - chars 12-16 = `world` (5 chars)
    // Total lyrics = 11.
    const multi = {
      segments: [
        { chord: { name: 'G', detail: null, display: null }, text: 'hello ', spans: [] },
        { chord: { name: 'C', detail: null, display: null }, text: 'world', spans: [] },
      ],
    };
    // Caret at source col 12 = start of `world`. Lyrics offset =
    // 6 (segment 1's full text) + 0 = 6; ratio = 6/11.
    expect(lyricsCaretRatio(multi, 12, 17)).toBeCloseTo(6 / 11, 4);
  });
});

describe('parseGridShape', () => {
  test('parses full L+MxB+R form', () => {
    expect(parseGridShape('shape="1+4x2+4"')).toEqual({
      marginLeft: 1, measures: 4, beats: 2, marginRight: 4,
    });
  });

  test('parses body-only MxB form (margins default to 0)', () => {
    expect(parseGridShape('shape="4x4"')).toEqual({
      marginLeft: 0, measures: 4, beats: 4, marginRight: 0,
    });
  });

  test('parses bare cell-count N as 1-measure × N-beats', () => {
    expect(parseGridShape('shape="16"')).toEqual({
      marginLeft: 0, measures: 1, beats: 16, marginRight: 0,
    });
  });

  test('falls back to spec default on unparseable input', () => {
    expect(parseGridShape('garbage')).toEqual({
      marginLeft: 1, measures: 4, beats: 4, marginRight: 1,
    });
  });

  test('falls back to spec default on empty input', () => {
    expect(parseGridShape('')).toEqual({
      marginLeft: 1, measures: 4, beats: 4, marginRight: 1,
    });
  });
});

describe('extractGridLabel', () => {
  test('extracts label from quoted form', () => {
    expect(extractGridLabel('label="Intro" shape="4x4"')).toBe('Intro');
  });

  test('extracts label from bare form', () => {
    expect(extractGridLabel('label=Outro')).toBe('Outro');
  });

  test('returns null when no label attribute is present', () => {
    expect(extractGridLabel('shape="4x4"')).toBeNull();
    expect(extractGridLabel('')).toBeNull();
  });
});
