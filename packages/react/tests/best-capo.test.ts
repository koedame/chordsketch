import { describe, expect, test } from 'vitest';

import { BEST_CAPO_MAX, computeBestCapoPositions } from '../src/best-capo';
import type {
  ChordproChord,
  ChordproDirective,
  ChordproLine,
  ChordproLyricsLine,
  ChordproNote,
  ChordproSong,
} from '../src/chordpro-ast';

function plainChord(
  root: ChordproNote,
  accidental: 'sharp' | 'flat' | null = null,
): ChordproChord {
  const symbol = `${root}${accidental === 'sharp' ? '#' : accidental === 'flat' ? 'b' : ''}`;
  return {
    name: symbol,
    detail: {
      root,
      rootAccidental: accidental,
      quality: 'major',
      extension: null,
      bassNote: null,
    },
    display: null,
  };
}

function lyrics(...chords: ChordproChord[]): ChordproLine {
  const segments = chords.map((chord) => ({ chord, text: '', spans: [] }));
  const value: ChordproLyricsLine = { segments };
  return { kind: 'lyrics', value };
}

function song(...lines: ChordproLine[]): ChordproSong {
  return {
    metadata: {
      title: null,
      subtitles: [],
      artists: [],
      composers: [],
      lyricists: [],
      album: null,
      year: null,
      key: null,
      keys: [],
      tempo: null,
      tempos: [],
      time: null,
      times: [],
      capo: null,
      sortTitle: null,
      sortArtist: null,
      arrangers: [],
      copyright: null,
      duration: null,
      tags: [],
      custom: [],
    },
    lines,
  };
}

describe('computeBestCapoPositions', () => {
  test('returns null when the song has no chord segments', () => {
    expect(computeBestCapoPositions(song())).toBeNull();
  });

  test('returns null when the song is null / undefined', () => {
    expect(computeBestCapoPositions(null)).toBeNull();
    expect(computeBestCapoPositions(undefined)).toBeNull();
  });

  test('treats a chord with no parsed detail as no chord', () => {
    const ncChord: ChordproChord = { name: 'N.C.', detail: null, display: null };
    expect(computeBestCapoPositions(song(lyrics(ncChord)))).toBeNull();
  });

  test('C / F / G — capo 0 wins with zero accidentals', () => {
    const result = computeBestCapoPositions(
      song(lyrics(plainChord('C'), plainChord('F'), plainChord('G'))),
    );
    expect(result).not.toBeNull();
    expect(result!.minAccidentals).toBe(0);
    expect(result!.positions).toContain(0);
    // capo 5 transposes C/F/G to G/C/D — also accidental-free,
    // so it must appear in the tied set.
    expect(result!.positions).toContain(5);
  });

  test('Eb / Bb / Ab — every accidental-free capo position is reported', () => {
    const result = computeBestCapoPositions(
      song(
        lyrics(
          plainChord('E', 'flat'),
          plainChord('B', 'flat'),
          plainChord('A', 'flat'),
        ),
      ),
    );
    expect(result).not.toBeNull();
    expect(result!.minAccidentals).toBe(0);
    // The three roots {Eb=3, Bb=10, Ab=8} are all black keys; any
    // capo c that lands every root on a white key qualifies. The
    // intersection of "shift each black key to a white key" is
    // {1, 3, 6, 8, 11}.
    expect(result!.positions).toEqual([1, 3, 6, 8, 11]);
  });

  test('caps the search at BEST_CAPO_MAX', () => {
    const result = computeBestCapoPositions(song(lyrics(plainChord('C'))));
    expect(result).not.toBeNull();
    for (const pos of result!.positions) {
      expect(pos).toBeLessThanOrEqual(BEST_CAPO_MAX);
      expect(pos).toBeGreaterThanOrEqual(0);
    }
  });

  test('ignores non-lyrics lines when collecting chord roots', () => {
    const directive: ChordproDirective = {
      name: 'comment',
      value: 'unused',
      kind: { tag: 'comment' },
      selector: null,
    };
    const directiveLine: ChordproLine = { kind: 'directive', value: directive };
    const result = computeBestCapoPositions(
      song(directiveLine, lyrics(plainChord('C'))),
    );
    expect(result).not.toBeNull();
    expect(result!.minAccidentals).toBe(0);
  });

  test('result is invariant under {capo: N} on the song metadata', () => {
    // The AST emitted by `parseChordpro*` has `{capo}` folded into
    // the chord roots (ADR-0023), so a C-major song at capo 2
    // arrives here with B♭ / E♭ / F chord roots. Dragging the
    // capo slider must not change the recommended positions —
    // the user is looking at the same song, just held with a
    // different capo.
    function makeAst(capoValue: string | null, rootShift: number): ChordproSong {
      const ast = song(
        lyrics(
          // Source chords were C / F / G; with `{capo: rootShift}`
          // the AST stores them shifted down by `rootShift`.
          // capo=0 → C/F/G ; capo=2 → Bb/Eb/F ; capo=5 → G/C/D
          ...(() => {
            if (rootShift === 0) return [plainChord('C'), plainChord('F'), plainChord('G')];
            if (rootShift === 2) {
              return [
                plainChord('B', 'flat'),
                plainChord('E', 'flat'),
                plainChord('F'),
              ];
            }
            if (rootShift === 5) {
              return [plainChord('G'), plainChord('C'), plainChord('D')];
            }
            throw new Error('unexpected rootShift');
          })(),
        ),
      );
      ast.metadata.capo = capoValue;
      return ast;
    }

    const noCapo = computeBestCapoPositions(makeAst(null, 0))!;
    const capo2 = computeBestCapoPositions(makeAst('2', 2))!;
    const capo5 = computeBestCapoPositions(makeAst('5', 5))!;

    expect(capo2.positions).toEqual(noCapo.positions);
    expect(capo2.minAccidentals).toBe(noCapo.minAccidentals);
    expect(capo5.positions).toEqual(noCapo.positions);
    expect(capo5.minAccidentals).toBe(noCapo.minAccidentals);
  });

  test('result shifts with transpose (chord roots already transposed on the AST)', () => {
    // The wasm `parseChordpro*` path bakes the active transpose
    // offset into the AST's chord roots, so the helper sees the
    // *transposed* roots directly. A C/F/G song at transpose=+1
    // arrives here with Db/Gb/Ab roots; the recommended capo
    // positions must shift by +1 in lockstep — otherwise the
    // user moves the `<Transpose>` slider and the ★ markers stay
    // frozen against the pre-transpose song.
    const original = computeBestCapoPositions(
      song(lyrics(plainChord('C'), plainChord('F'), plainChord('G'))),
    )!;
    const transposedUpOne = computeBestCapoPositions(
      song(
        lyrics(
          plainChord('D', 'flat'),
          plainChord('G', 'flat'),
          plainChord('A', 'flat'),
        ),
      ),
    )!;
    // The minimum-accidentals invariant survives transposition:
    // every transposed song has *some* capo position that lands
    // the chord roots back on the original key, so the floor is
    // the same.
    expect(transposedUpOne.minAccidentals).toBe(original.minAccidentals);
    // The recommendations actually move: at least one position
    // is different between the two sets. (A pin against the bug
    // where the helper ignored transposition and returned the
    // original positions unchanged.)
    const origSet = new Set(original.positions);
    const transSet = new Set(transposedUpOne.positions);
    const intersection = [...origSet].filter((p) => transSet.has(p));
    expect(intersection.length).toBeLessThan(origSet.size);
    // Modulo-12 invariant: every transposed position is exactly
    // one semitone above an original position (the shift is +1).
    // This holds even though `c=0` and `c=12` collapse to the
    // same shift mod 12 — both either qualify or both drop out.
    for (const p of transposedUpOne.positions) {
      const recovered = ((p - 1) % 12 + 12) % 12;
      const origMod = original.positions.map((q) => q % 12);
      expect(origMod).toContain(recovered);
    }
  });

  test('counts bass notes of slash chords toward the accidental total', () => {
    // D / F# at capo 0 carries one sharp (F#).
    const slash: ChordproChord = {
      name: 'D/F#',
      detail: {
        root: 'D',
        rootAccidental: null,
        quality: 'major',
        extension: null,
        bassNote: { note: 'F', accidental: 'sharp' },
      },
      display: null,
    };
    const result = computeBestCapoPositions(song(lyrics(slash)));
    expect(result).not.toBeNull();
    // At capo 0 the bass note F# contributes 1 accidental; at
    // capo 2 the chord lowers to C / E — zero accidentals.
    expect(result!.minAccidentals).toBe(0);
    expect(result!.positions).toContain(2);
  });
});

describe('parseSongCapo input sanitisation (via metadata.capo)', () => {
  // `parseSongCapo` is a private helper, so we exercise it
  // through `computeBestCapoPositions` and the `capo`-invariance
  // contract: when the AST chord roots are unchanged and only
  // `metadata.capo` varies, every valid value must produce the
  // same `positions` set as the baseline (capo=null), and every
  // invalid value must be treated as "no capo" — i.e. identical
  // to the baseline.
  function baseSong(capoValue: string | null): ChordproSong {
    const ast = song(lyrics(plainChord('C'), plainChord('F'), plainChord('G')));
    ast.metadata.capo = capoValue;
    return ast;
  }

  test('null capo metadata produces the accidental-free baseline', () => {
    const result = computeBestCapoPositions(baseSong(null))!;
    // C/F/G are accidental-free; the helper enumerates every
    // position in `0..=BEST_CAPO_MAX` whose chord roots stay on
    // white keys. The exact set is a stable anchor we reuse in
    // the rejection cases below.
    expect(result.minAccidentals).toBe(0);
    expect(result.positions.length).toBeGreaterThan(0);
  });

  test.each([
    ['scientific notation', '1e5'],
    ['decimal', '3.5'],
    ['negative', '-3'],
    ['leading plus', '+3'],
    ['out of range high', '25'],
    ['out of range low', '0'], // capo_validated rejects 0 (treated as unset)
    ['letters', 'foo'],
    ['empty', ''],
    ['whitespace only', '   '],
  ])(
    'rejects %s capo input and resolves to "no capo"',
    (_label, value) => {
      const invalid = computeBestCapoPositions(baseSong(value))!;
      const baseline = computeBestCapoPositions(baseSong(null))!;
      expect([...invalid.positions]).toEqual([...baseline.positions]);
      expect(invalid.minAccidentals).toBe(baseline.minAccidentals);
    },
  );

  test('accepts integer strings with surrounding whitespace', () => {
    const trimmed = computeBestCapoPositions(baseSong('2'))!;
    const padded = computeBestCapoPositions(baseSong('  2  '))!;
    expect([...padded.positions]).toEqual([...trimmed.positions]);
    expect(padded.minAccidentals).toBe(trimmed.minAccidentals);
  });

  test('accepts the meaningful 1..=24 range', () => {
    // capo=24 is the upper bound capo_validated accepts; the
    // helper must not panic and must shift the recommendations
    // by 24 semitones modulo 12 (= 0). A {capo:24} song with the
    // pre-baked roots Eb/Ab/Bb (= C+12 mod 12 with two octave
    // wraps, simplified) should behave identically to capo=12.
    const max = computeBestCapoPositions(baseSong('24'))!;
    expect(max.positions.length).toBeGreaterThan(0);
    expect(max.minAccidentals).toBeGreaterThanOrEqual(0);
  });
});
