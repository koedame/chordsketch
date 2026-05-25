// Compute the capo position(s) at which a song's chord-root labels
// carry the fewest accidental glyphs (`♯` / `♭`).
//
// Per ADR-0023, a capo on fret `c` displays every chord transposed by
// `-c` semitones. The "best capo" picker enumerates `c ∈ [0..=12]`,
// counts how many accidental glyphs would appear in the chord-root
// labels at each `c`, and returns the set of positions tied for the
// minimum. The slider in `<Capo>` paints a ★ marker at each tied
// position so the user can see at a glance which capo fret produces
// the simplest spelling.
//
// Mirrors `canonical_key_spelling` in
// `crates/chordpro/src/transpose.rs`: black keys spell as flats
// (`Db` / `Eb` / `Gb` / `Ab` / `Bb`) to match the song-wide chord
// labels the renderer pipeline produces. The bass note of slash
// chords is included in the count — `G/B` contributes 0 accidentals,
// `D/F#` contributes 1.

import { CAPO_MAX } from './chord-source-edit';
import type {
  ChordproAccidental,
  ChordproChord,
  ChordproLine,
  ChordproNote,
  ChordproSong,
} from './chordpro-ast';

/**
 * Inclusive upper bound for the candidate capo positions
 * `computeBestCapoPositions` enumerates. Re-exports `CAPO_MAX` from
 * `chord-source-edit.ts` so the search range stays in lockstep with
 * the slider's physical range — if `CAPO_MAX` widens to support a
 * longer guitar neck, the best-capo picker enumerates the new
 * positions automatically.
 */
export const BEST_CAPO_MAX = CAPO_MAX;

/**
 * Whether a chromatic semitone (`0..12`) spells with an accidental
 * under the canonical flat-side preference. Black keys are flats;
 * white keys carry no accidental.
 */
function isAccidentalSemitone(semitone: number): boolean {
  switch (((semitone % 12) + 12) % 12) {
    case 1: // Db
    case 3: // Eb
    case 6: // Gb
    case 8: // Ab
    case 10: // Bb
      return true;
    default:
      return false;
  }
}

const NOTE_TO_SEMITONE: Record<ChordproNote, number> = {
  C: 0,
  D: 2,
  E: 4,
  F: 5,
  G: 7,
  A: 9,
  B: 11,
};

function accidentalShift(accidental: ChordproAccidental | null): number {
  if (accidental === 'sharp') return 1;
  if (accidental === 'flat') return -1;
  return 0;
}

function chordRootSemitone(chord: ChordproChord): number | null {
  const detail = chord.detail;
  if (!detail) return null;
  const base = NOTE_TO_SEMITONE[detail.root];
  return (((base + accidentalShift(detail.rootAccidental)) % 12) + 12) % 12;
}

function chordBassSemitone(chord: ChordproChord): number | null {
  const detail = chord.detail;
  if (!detail || !detail.bassNote) return null;
  const base = NOTE_TO_SEMITONE[detail.bassNote.note];
  return (((base + accidentalShift(detail.bassNote.accidental)) % 12) + 12) % 12;
}

/**
 * Parse the song's `{capo: N}` metadata into a 0..=24 semitone
 * offset. Out-of-range / non-integer values resolve to 0 so the
 * helper never panics on user input. Mirrors the Rust-side
 * `Metadata::capo_validated` contract.
 */
function parseSongCapo(song: ChordproSong): number {
  const raw = song.metadata.capo;
  if (raw === null || raw === undefined) return 0;
  const n = Number.parseInt(raw.trim(), 10);
  if (!Number.isInteger(n)) return 0;
  if (n < 1 || n > 24) return 0;
  return n;
}

/**
 * Collect every (root, bass) semitone pair driven by an actual chord.
 *
 * The AST emitted by `@chordsketch/wasm`'s `parseChordpro*` path has
 * already folded `{capo: N}` into the effective transpose offset
 * (ADR-0023), so the chord roots stored on the AST are *displayed*
 * roots — shifted by `-capo` from the source's literal roots. Add
 * `capo` back here so the best-capo enumeration sees the original
 * roots and produces a stable answer independent of the current
 * capo position.
 */
function collectChordSemitones(song: ChordproSong): number[] {
  const capoBack = parseSongCapo(song);
  const undoCapo = (s: number) => (((s + capoBack) % 12) + 12) % 12;
  const out: number[] = [];
  for (const line of song.lines as ChordproLine[]) {
    if (line.kind !== 'lyrics') continue;
    for (const segment of line.value.segments) {
      const chord = segment.chord;
      if (!chord) continue;
      const root = chordRootSemitone(chord);
      if (root === null) continue;
      out.push(undoCapo(root));
      const bass = chordBassSemitone(chord);
      if (bass !== null) out.push(undoCapo(bass));
    }
  }
  return out;
}

/** Result returned by {@link computeBestCapoPositions}. */
export interface BestCapoResult {
  /**
   * Sorted ascending, deduplicated capo positions tied for the
   * minimum accidental count. Every entry lies in
   * `[0, BEST_CAPO_MAX]`. Declared as `ReadonlyArray<number>` so a
   * caller cannot mutate the result in place (the invariants above
   * are guaranteed at construction time only).
   */
  readonly positions: ReadonlyArray<number>;
  /**
   * Number of accidental glyphs (`♯` / `♭`) that every position in
   * {@link positions} produces across the song's chord roots. Always
   * `>= 0`.
   */
  readonly minAccidentals: number;
}

/**
 * Return the set of capo positions in `0..=BEST_CAPO_MAX` tied for
 * the lowest accidental-glyph count, or `null` when the song has no
 * recognised chords (an empty song, or one containing only `N.C.`
 * placeholders).
 *
 * Cost is `O(12 * unique chord notes)` — cheap; safe to recompute on
 * every AST change without memoization beyond the host's normal
 * `useMemo`.
 */
export function computeBestCapoPositions(song: ChordproSong | null | undefined): BestCapoResult | null {
  if (!song) return null;
  const semitones = collectChordSemitones(song);
  if (semitones.length === 0) return null;

  let minCount = Number.POSITIVE_INFINITY;
  let positions: number[] = [];
  for (let c = 0; c <= BEST_CAPO_MAX; c += 1) {
    let count = 0;
    for (const s of semitones) {
      const shifted = (((s - c) % 12) + 12) % 12;
      if (isAccidentalSemitone(shifted)) count += 1;
    }
    if (count < minCount) {
      minCount = count;
      positions = [c];
    } else if (count === minCount) {
      positions.push(c);
    }
  }

  return { positions, minAccidentals: minCount };
}
