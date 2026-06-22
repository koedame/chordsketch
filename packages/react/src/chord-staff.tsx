import type { HTMLAttributes, ReactNode } from 'react';

import {
  ACCIDENTAL_FLAT,
  ACCIDENTAL_SHARP,
  GCLEF,
  NOTEHEAD_BLACK,
  STAFF_SPACE_FONT_UNITS,
  smuflTransform,
} from './bravura-glyphs';
import {
  type ChordStaffWasmLoader,
  type StaffNote,
  useChordStaff,
} from './use-chord-staff';

// ---- Staff geometry ---------------------------------------------
//
// A five-line treble staff drawn in its own SVG user-space. Vertical
// position is driven by each tone's DIATONIC step (letter + octave), not its
// pitch class, so enharmonic spellings land on the right line (the core
// already spelled them — see `chordsketch_chordpro::chord_staff_notes`).
//
// "Staff step" counts diatonic letters from C0: `octave * 7 + letterIndex`,
// with C = 0 … B = 6. On a treble staff the bottom line (E4) is step 30 and
// the top line (F5) is step 38, so the five lines sit on the even steps
// 30/32/34/36/38 and each unit step is half a line gap.
//
// The clef, noteheads, and accidentals are real Bravura SMuFL outlines (see
// `./bravura-glyphs` / ADR-0014) mapped from font units into this staff via
// `smuflTransform`, scaled so one staff space spans {@link LINE_GAP} units.

const LETTER_ORDER = 'CDEFGAB';
const LINE_GAP = 9;
const HALF_GAP = LINE_GAP / 2;
/** Staff step of the bottom treble line (E4). */
const BOTTOM_LINE_STEP = 30;
/** Staff step of the top treble line (F5). */
const TOP_LINE_STEP = 38;
/** Staff step of the G (treble) line — the gClef's reference line. */
const G_LINE_STEP = 4 * 7 + LETTER_ORDER.indexOf('G'); // G4 = 32
const LEDGER_HALF_WIDTH = 7.5;
const PAD = 6;
/** Left x of the clef; the first notehead column starts after it. */
const CLEF_X = 2;
const NOTE_START_X = 27;
/** Horizontal gap after a notehead before the next column. */
const COL_GAP = 6;
/** Horizontal gap between an accidental and the notehead it alters. */
const ACC_NOTE_GAP = 2;

/** Font-unit → user-space scale (one staff space = {@link LINE_GAP} units). */
const GLYPH_S = LINE_GAP / STAFF_SPACE_FONT_UNITS;
/** Notehead half-width / half-height in user units, for layout + bounds. */
const NOTEHEAD_HALF_W = NOTEHEAD_BLACK.cx * GLYPH_S;
const NOTEHEAD_HALF_H = NOTEHEAD_BLACK.bbox.maxY * GLYPH_S;

/** The Bravura accidental glyph for a flat / sharp column. */
function accidentalFor(kind: 'sharp' | 'flat'): typeof ACCIDENTAL_SHARP {
  return kind === 'flat' ? ACCIDENTAL_FLAT : ACCIDENTAL_SHARP;
}

/** Diatonic staff step of a spelled note (`octave * 7 + letterIndex`). */
export function staffStep(note: StaffNote): number {
  const idx = LETTER_ORDER.indexOf(note.letter.toUpperCase());
  // An unrecognised letter would corrupt the layout; treat it as C so the
  // note still renders rather than landing at NaN.
  return note.octave * 7 + (idx === -1 ? 0 : idx);
}

/** Unicode accidental glyph for a signed semitone offset. Multi-semitone
 * accidentals repeat the single glyph (`♭♭` / `♯♯` / `♭♭♭`) so they render in
 * any font, unlike the dedicated U+1D12A/B double glyphs — and so the full
 * `StaffNote.accidental` range is covered: the core can emit ±3 for an
 * enharmonically-extreme root (e.g. `Cbdim7`'s triple-flat seventh), which a
 * fixed `-2..=2` switch would have dropped to no glyph at all. Capped at four
 * repeats as a defensive bound against a pathological value. */
export function accidentalGlyph(accidental: number): string {
  const n = Math.trunc(accidental);
  if (n === 0) return '';
  return (n < 0 ? '♭' : '♯').repeat(Math.min(Math.abs(n), 4));
}

/** Even staff steps (line positions) a notehead at `step` needs ledger lines
 * drawn at: below the staff (steps < bottom line) or above it (> top line). */
export function ledgerSteps(step: number): number[] {
  const out: number[] = [];
  if (step < BOTTOM_LINE_STEP) {
    for (let e = BOTTOM_LINE_STEP - 2; e >= step; e -= 2) out.push(e);
  } else if (step > TOP_LINE_STEP) {
    for (let e = TOP_LINE_STEP + 2; e <= step; e += 2) out.push(e);
  }
  return out;
}

/** A laid-out notehead column. */
interface StaffColumn {
  x: number;
  /** Notehead centre y (relative space, before normalisation). */
  cy: number;
  /** Unicode accidental string (`''` / `♭` / `♯♯` …) — used for the label. */
  accidental: string;
  /** Which Bravura accidental glyph to draw, or `null` for a natural tone. */
  accKind: 'sharp' | 'flat' | null;
  /** Left-edge x of each accidental glyph drawn before the notehead. */
  accXs: number[];
  ledgers: number[];
  midi: number;
}

/** The full geometry needed to paint the staff, in normalised (all-positive,
 * padded) SVG user-space. Exported for unit tests. */
export interface StaffModel {
  width: number;
  height: number;
  /** y of each of the five staff lines, top (F5) → bottom (E4). */
  lineYs: number[];
  staffLeft: number;
  staffRight: number;
  clefTransform: string;
  columns: Array<{
    x: number;
    cy: number;
    accidental: string;
    accKind: 'sharp' | 'flat' | null;
    accXs: number[];
    ledgerYs: number[];
    midi: number;
  }>;
}

/** Relative y (smaller = higher pitch) of a staff step, anchored so the
 * bottom line (E4) is 0. */
function relY(step: number): number {
  return -(step - BOTTOM_LINE_STEP) * HALF_GAP;
}

/**
 * Lay the spelled tones out on a treble staff. Notes are arpeggiated
 * left-to-right (ascending pitch) so adjacent seconds never collide — a clean,
 * unambiguous "these are the notes" reading suited to the editor helper, not a
 * vertically-stacked engraving.
 */
export function buildStaffModel(notes: readonly StaffNote[]): StaffModel {
  // Lay columns out with a running cursor so each accidental reserves its own
  // horizontal slot before the notehead (real Bravura accidentals are ~1 staff
  // space wide and would otherwise collide with the previous tone).
  let cursor = NOTE_START_X;
  const columns: StaffColumn[] = notes.map((note) => {
    const step = staffStep(note);
    const accidental = accidentalGlyph(note.accidental);
    const accKind = note.accidental < 0 ? 'flat' : note.accidental > 0 ? 'sharp' : null;
    const accXs: number[] = [];
    if (accKind !== null) {
      const glyphW = accidentalFor(accKind).advance * GLYPH_S;
      for (let j = 0; j < accidental.length; j++) accXs.push(cursor + j * glyphW);
      cursor += accidental.length * glyphW + ACC_NOTE_GAP;
    }
    const x = cursor + NOTEHEAD_HALF_W;
    cursor = x + NOTEHEAD_HALF_W + COL_GAP;
    return {
      x,
      cy: relY(step),
      accidental,
      accKind,
      accXs,
      ledgers: ledgerSteps(step).map(relY),
      midi: note.midi,
    };
  });

  // Relative y extents: the five staff lines, every notehead (± its half
  // height), every ledger line, every accidental's overhang, and the clef's
  // vertical overhang. Seed the bounds with the staff + clef so an empty /
  // sparse chord still frames the staff.
  const staffTopRel = relY(TOP_LINE_STEP);
  const staffBottomRel = relY(BOTTOM_LINE_STEP);
  // The gClef origin sits on the G line; it overhangs ~4.4 spaces above and
  // ~2.6 below in font units, mapped here through GLYPH_S.
  const gLineRel = relY(G_LINE_STEP);
  const clefTopRel = gLineRel - GCLEF.bbox.maxY * GLYPH_S;
  const clefBottomRel = gLineRel - GCLEF.bbox.minY * GLYPH_S;
  let minRel = Math.min(staffTopRel, clefTopRel);
  let maxRel = Math.max(staffBottomRel, clefBottomRel);
  for (const col of columns) {
    minRel = Math.min(minRel, col.cy - NOTEHEAD_HALF_H, ...col.ledgers);
    maxRel = Math.max(maxRel, col.cy + NOTEHEAD_HALF_H, ...col.ledgers);
    if (col.accKind !== null) {
      const g = accidentalFor(col.accKind);
      // Accidental font y=0 anchors at col.cy; it reaches up by bbox.maxY and
      // down by -bbox.minY (font +Y up → SVG +Y down).
      minRel = Math.min(minRel, col.cy - g.bbox.maxY * GLYPH_S);
      maxRel = Math.max(maxRel, col.cy - g.bbox.minY * GLYPH_S);
    }
  }

  const offsetY = PAD - minRel;
  const height = maxRel - minRel + 2 * PAD;
  const lastRight =
    columns.length > 0 ? columns[columns.length - 1]!.x + NOTEHEAD_HALF_W : NOTE_START_X;
  const width = lastRight + PAD + 4;
  const staffLeft = 3;
  const staffRight = width - 2;

  // Five lines from top (F5) to bottom (E4) on the even steps.
  const lineYs: number[] = [];
  for (let step = TOP_LINE_STEP; step >= BOTTOM_LINE_STEP; step -= 2) {
    lineYs.push(relY(step) + offsetY);
  }

  // Clef: font origin (0,0) lands on the G line, scaled to this staff.
  const clefTransform = smuflTransform({
    staffSpace: LINE_GAP,
    fontAnchorX: 0,
    fontAnchorY: 0,
    targetX: CLEF_X,
    targetY: gLineRel + offsetY,
  });

  return {
    width,
    height,
    lineYs,
    staffLeft,
    staffRight,
    clefTransform,
    columns: columns.map((col) => ({
      x: col.x,
      cy: col.cy + offsetY,
      accidental: col.accidental,
      accKind: col.accKind,
      accXs: col.accXs,
      ledgerYs: col.ledgers.map((y) => y + offsetY),
      midi: col.midi,
    })),
  };
}

/** Props accepted by {@link ChordStaff}. */
export interface ChordStaffProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  /** Chord name whose constituent notes to draw (e.g. `"Cmaj9"`, `"Ebm7"`). */
  chord: string;
  /**
   * The chord name with Unicode accidentals (e.g. `"E♭m7"`), used only in the
   * accessible label so it matches how the chord is displayed elsewhere.
   * Falls back to {@link chord}.
   */
  displayName?: string;
  /**
   * Node shown while the WASM module loads. Defaults to a minimal
   * `role="status"` placeholder so the staff area does not jump.
   */
  loadingFallback?: ReactNode;
  /**
   * Test-only WASM loader override. Production callers never supply this — the
   * default lazy-loads `@chordsketch/wasm`.
   *
   * @internal
   */
  wasmLoader?: ChordStaffWasmLoader;
}

function defaultLoadingFallback(): ReactNode {
  return (
    <div role="status" aria-live="polite" className="chordsketch-staff__loading">
      Loading staff…
    </div>
  );
}

/**
 * Render a chord's constituent notes on a five-line treble staff (五線譜).
 *
 * The note placement and spelling come from `@chordsketch/wasm`'s
 * `chordStaffNotes` (sister to `chordsketch_chordpro::chord_staff_notes`), so
 * every consumer draws the same musically-correct staff. The SVG itself is
 * assembled here in React — it is geometry, not user content — so there is no
 * `dangerouslySetInnerHTML`.
 *
 * Degrades gracefully: a `role="status"` placeholder while the module loads,
 * and nothing (an empty, labelled figure) when the chord is not parseable or
 * Web Assembly is unavailable under SSR.
 *
 * ```tsx
 * <ChordStaff chord="Cmaj9" />
 * ```
 */
export function ChordStaff({
  chord,
  displayName,
  loadingFallback,
  wasmLoader,
  className,
  ...divProps
}: ChordStaffProps): JSX.Element {
  const { notes, loading } = useChordStaff(chord, wasmLoader);
  const wrapperClass = ['chordsketch-staff', className].filter(Boolean).join(' ');
  const label = `Notes of ${displayName ?? chord} on a staff`;

  if (notes === null) {
    if (loading) {
      return (
        <div {...divProps} className={wrapperClass} aria-busy="true">
          {loadingFallback ?? defaultLoadingFallback()}
        </div>
      );
    }
    // Not loading and no notes — the chord is not parseable (or SSR without
    // WASM). Render an empty, labelled figure rather than nothing so the
    // layout stays stable and the absence is announced.
    return (
      <div {...divProps} className={wrapperClass} role="img" aria-label={`${label} (unavailable)`} />
    );
  }

  const model = buildStaffModel(notes);

  return (
    <div {...divProps} className={wrapperClass}>
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox={`0 0 ${model.width.toFixed(2)} ${model.height.toFixed(2)}`}
        width={model.width}
        height={model.height}
        className="chordsketch-staff__svg"
        role="img"
        aria-label={label}
      >
        {/* Five staff lines */}
        {model.lineYs.map((y, i) => (
          <line
            key={`staff-line-${i}`}
            x1={model.staffLeft}
            x2={model.staffRight}
            y1={y}
            y2={y}
            stroke="currentColor"
            strokeWidth={0.7}
          />
        ))}
        {/* Treble clef (real Bravura gClef, U+E050). */}
        <path d={GCLEF.d} transform={model.clefTransform} fill="currentColor" />
        {/* Noteheads, ledger lines, accidentals */}
        {model.columns.map((col, i) => (
          <g key={`note-${i}`} className="chordsketch-staff__note">
            {col.ledgerYs.map((y, j) => (
              <line
                key={`ledger-${i}-${j}`}
                x1={col.x - LEDGER_HALF_WIDTH}
                x2={col.x + LEDGER_HALF_WIDTH}
                y1={y}
                y2={y}
                stroke="currentColor"
                strokeWidth={0.7}
              />
            ))}
            {col.accKind !== null
              ? col.accXs.map((ax, j) => (
                  <path
                    key={`acc-${i}-${j}`}
                    className="chordsketch-staff__accidental"
                    d={accidentalFor(col.accKind!).d}
                    transform={smuflTransform({
                      staffSpace: LINE_GAP,
                      fontAnchorX: 0,
                      fontAnchorY: 0,
                      targetX: ax,
                      targetY: col.cy,
                    })}
                    fill="currentColor"
                  />
                ))
              : null}
            <path
              className="chordsketch-staff__notehead"
              d={NOTEHEAD_BLACK.d}
              transform={smuflTransform({
                staffSpace: LINE_GAP,
                fontAnchorX: NOTEHEAD_BLACK.cx,
                fontAnchorY: 0,
                targetX: col.x,
                targetY: col.cy,
              })}
              fill="currentColor"
            />
          </g>
        ))}
      </svg>
    </div>
  );
}
