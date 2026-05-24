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
