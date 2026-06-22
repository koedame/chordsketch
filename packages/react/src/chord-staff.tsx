import type { HTMLAttributes, ReactNode } from 'react';

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

const LETTER_ORDER = 'CDEFGAB';
const LINE_GAP = 9;
const HALF_GAP = LINE_GAP / 2;
/** Staff step of the bottom treble line (E4). */
const BOTTOM_LINE_STEP = 30;
/** Staff step of the top treble line (F5). */
const TOP_LINE_STEP = 38;
const NOTE_RX = 5.2;
const NOTE_RY = 3.9;
const LEDGER_HALF_WIDTH = 7.5;
const NOTE_SPACING = 15;
const NOTE_START_X = 27;
const PAD = 6;
/** Scale mapping the simplified clef path's staff (lines at y 4..16, gap 3)
 * onto this staff (gap {@link LINE_GAP}). */
const CLEF_SCALE = LINE_GAP / 3;
const CLEF_X = 7;

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
  accidental: string;
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
  const columns: StaffColumn[] = notes.map((note, i) => ({
    x: NOTE_START_X + i * NOTE_SPACING,
    cy: relY(staffStep(note)),
    accidental: accidentalGlyph(note.accidental),
    ledgers: ledgerSteps(staffStep(note)).map(relY),
    midi: note.midi,
  }));

  // Relative y extents: the five staff lines, every notehead (± its radius),
  // every ledger line, and the clef's vertical overhang. Seed the bounds with
  // the staff + clef so an empty / sparse chord still frames the staff.
  const staffTopRel = relY(TOP_LINE_STEP);
  const staffBottomRel = relY(BOTTOM_LINE_STEP);
  // The simplified clef path spans y≈2.5..21 in its own space; mapped onto
  // this staff (its line y=4 → staffTopRel) it overhangs both ends.
  const clefTopRel = staffTopRel + (2.5 - 4) * CLEF_SCALE;
  const clefBottomRel = staffTopRel + (21 - 4) * CLEF_SCALE;
  let minRel = Math.min(staffTopRel, clefTopRel);
  let maxRel = Math.max(staffBottomRel, clefBottomRel);
  for (const col of columns) {
    minRel = Math.min(minRel, col.cy - NOTE_RY, ...col.ledgers);
    maxRel = Math.max(maxRel, col.cy + NOTE_RY, ...col.ledgers);
  }

  const offsetY = PAD - minRel;
  const height = maxRel - minRel + 2 * PAD;
  const lastX = columns.length > 0 ? columns[columns.length - 1]!.x : NOTE_START_X;
  const width = lastX + NOTE_RX + PAD + 4;
  const staffLeft = 3;
  const staffRight = width - 2;

  // Five lines from top (F5) to bottom (E4) on the even steps.
  const lineYs: number[] = [];
  for (let step = TOP_LINE_STEP; step >= BOTTOM_LINE_STEP; step -= 2) {
    lineYs.push(relY(step) + offsetY);
  }

  // Clef: map its path-space onto this staff and shift by the normalisation
  // offset. (point x,y) → (CLEF_X + (x-4.5)*s, (staffTopRel+offsetY) + (y-4)*s).
  const clefTy = staffTopRel + offsetY - 4 * CLEF_SCALE;
  const clefTx = CLEF_X - 4.5 * CLEF_SCALE;
  const clefTransform = `translate(${clefTx.toFixed(2)} ${clefTy.toFixed(2)}) scale(${CLEF_SCALE.toFixed(3)})`;

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
      ledgerYs: col.ledgers.map((y) => y + offsetY),
      midi: col.midi,
    })),
  };
}

// The simplified treble-clef outline, shared with `music-glyphs.tsx`'s
// `KeySignatureGlyph` (its own coordinate space: staff lines at y 4..16). It
// is a caricature of the SMuFL gClef that reads as "treble clef" at icon size
// without a Bravura font load.
const CLEF_PATH =
  'M9 19 C 9 21, 5.5 21, 5.5 18.5 C 5.5 16, 9 16, 9 14 ' +
  'C 9 11, 4.5 9, 4.5 7 C 4.5 4, 8.5 2.5, 9.5 5 ' +
  'C 10.5 8, 6 9.5, 6 13 C 6 16, 10 16, 10 13.5';

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
        {/* Treble clef */}
        <path
          d={CLEF_PATH}
          transform={model.clefTransform}
          fill="none"
          stroke="currentColor"
          strokeWidth={1}
          strokeLinecap="round"
        />
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
            {col.accidental ? (
              <text
                x={col.x - NOTE_RX - 4}
                y={col.cy}
                className="chordsketch-staff__accidental"
                textAnchor="middle"
                dominantBaseline="central"
                fill="currentColor"
              >
                {col.accidental}
              </text>
            ) : null}
            <ellipse
              cx={col.x}
              cy={col.cy}
              rx={NOTE_RX}
              ry={NOTE_RY}
              // A filled (quarter-note) head reads clearly at small size; the
              // slight rotation echoes engraved noteheads.
              transform={`rotate(-20 ${col.x} ${col.cy})`}
              fill="currentColor"
            />
          </g>
        ))}
      </svg>
    </div>
  );
}
