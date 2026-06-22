import type { HTMLAttributes, ReactNode } from 'react';

import {
  ACCIDENTAL_FLAT,
  ACCIDENTAL_NATURAL,
  ACCIDENTAL_SHARP,
  type BravuraGlyph,
  GCLEF,
  NOTEHEAD_BLACK,
  STAFF_SPACE_FONT_UNITS,
  smuflTransform,
} from './bravura-glyphs';
import { keySignatureFor } from './music-glyphs';
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
/** Horizontal gap between consecutive key-signature accidentals. */
const SIG_GAP = 1;
/** Horizontal gap after the key signature before the first notehead column. */
const SIG_NOTE_GAP = 4;

/** Font-unit → user-space scale (one staff space = {@link LINE_GAP} units). */
const GLYPH_S = LINE_GAP / STAFF_SPACE_FONT_UNITS;
/** Notehead half-width / half-height in user units, for layout + bounds. */
const NOTEHEAD_HALF_W = NOTEHEAD_BLACK.cx * GLYPH_S;
const NOTEHEAD_HALF_H = NOTEHEAD_BLACK.bbox.maxY * GLYPH_S;

/** A drawn accidental glyph: a sharp, a flat, or a natural (the last cancels
 * an accidental the active key signature would otherwise apply to the note's
 * letter). */
type AccidentalKind = 'sharp' | 'flat' | 'natural';

/** The Bravura accidental glyph for a sharp / flat / natural column. */
function accidentalFor(kind: AccidentalKind): BravuraGlyph {
  switch (kind) {
    case 'flat':
      return ACCIDENTAL_FLAT;
    case 'natural':
      return ACCIDENTAL_NATURAL;
    case 'sharp':
      return ACCIDENTAL_SHARP;
  }
}

// ---- Key signature ----------------------------------------------
//
// When the chord is being edited in the context of a song key (possibly after
// a mid-song modulation), the staff draws that key's signature after the clef
// and renders each notehead relative to it: a tone whose accidental the
// signature already implies draws no inline accidental, and a tone that
// deviates from the signature draws one — a natural to cancel a signature
// sharp/flat, or the tone's own sharp/flat otherwise. Without a key (or for a
// modal / unparseable `{key}`) the staff falls back to spelling every altered
// tone inline, exactly as it did before key awareness.
//
// The key → (count, sharp/flat) theory is owned by `keySignatureFor`
// (`./music-glyphs`, sister to `chordsketch_chordpro::parse_key`); this module
// only maps that result into the treble-staff geometry the chord staff uses.

/** Conventional treble-clef staff steps of the order-of-sharps accidentals
 * (`F♯ C♯ G♯ D♯ A♯ E♯ B♯`), each as a diatonic staff step (see `staffStep`):
 * F5=38, C5=35, G5=39, D5=36, A4=33, E5=37, B4=34. */
const SHARP_SIGNATURE: ReadonlyArray<readonly [string, number]> = [
  ['F', 38],
  ['C', 35],
  ['G', 39],
  ['D', 36],
  ['A', 33],
  ['E', 37],
  ['B', 34],
];

/** Conventional treble-clef staff steps of the order-of-flats accidentals
 * (`B♭ E♭ A♭ D♭ G♭ C♭ F♭`): B4=34, E5=37, A4=33, D5=36, G4=32, C5=35, F4=30. */
const FLAT_SIGNATURE: ReadonlyArray<readonly [string, number]> = [
  ['B', 34],
  ['E', 37],
  ['A', 33],
  ['D', 36],
  ['G', 32],
  ['C', 35],
  ['F', 30],
];

/** One accidental of a drawn key signature: which staff step it sits on and
 * whether it is a sharp or a flat. */
export interface StaffSignatureAccidental {
  step: number;
  kind: 'sharp' | 'flat';
}

/** The resolved key signature a chord staff draws: the signature accidentals
 * (after the clef) plus the per-letter alteration they imply, used to decide
 * each notehead's inline accidental. */
export interface StaffKeySignature {
  accidentals: StaffSignatureAccidental[];
  /** Signed semitone alteration (`1` sharp, `-1` flat) the signature applies
   * to a note letter; absent letters are natural. */
  alterations: Partial<Record<string, 1 | -1>>;
}

/**
 * Resolve the key signature a chord staff should draw for the active song key,
 * or `null` when there is no usable key context (no key, or a modal /
 * unparseable `{key}` value such as `C dorian`, in which case the staff spells
 * every altered tone inline). A natural-signature key (`C` major / `A` minor)
 * resolves to an empty-but-present signature so the staff still renders the
 * chord without inline-accidental suppression.
 *
 * Exported for unit tests.
 */
export function staffKeySignature(musicKey: string | null | undefined): StaffKeySignature | null {
  if (musicKey == null || musicKey.trim().length === 0) return null;
  const sig = keySignatureFor(musicKey);
  if (sig === null) return null;
  if (sig.type === 'natural') return { accidentals: [], alterations: {} };
  const order = sig.type === 'sharp' ? SHARP_SIGNATURE : FLAT_SIGNATURE;
  const delta: 1 | -1 = sig.type === 'sharp' ? 1 : -1;
  const accidentals: StaffSignatureAccidental[] = [];
  const alterations: Record<string, 1 | -1> = {};
  for (const [letter, step] of order.slice(0, sig.count)) {
    accidentals.push({ step, kind: sig.type });
    alterations[letter] = delta;
  }
  return { accidentals, alterations };
}

/** The inline accidental a tone needs given the active key signature: `null`
 * when the signature already accounts for the tone, otherwise the glyph to
 * draw (a `natural` to cancel a signature accidental on this letter, or the
 * tone's own `sharp`/`flat`). */
function inlineAccidentalFor(note: StaffNote, keySig: StaffKeySignature | null): AccidentalKind | null {
  const signatureAlteration = keySig?.alterations[note.letter.toUpperCase()] ?? 0;
  if (note.accidental === signatureAlteration) return null;
  if (note.accidental === 0) return 'natural';
  return note.accidental < 0 ? 'flat' : 'sharp';
}

/** Diatonic staff step of a spelled note (`octave * 7 + letterIndex`). */
export function staffStep(note: StaffNote): number {
  const idx = LETTER_ORDER.indexOf(note.letter.toUpperCase());
  // An unrecognised letter would corrupt the layout; treat it as C so the
  // note still renders rather than landing at NaN.
  return note.octave * 7 + (idx === -1 ? 0 : idx);
}

/** Number of accidental glyphs a signed semitone offset draws: one per
 * semitone of alteration, capped at four as a defensive bound against a
 * pathological value. `0` for a natural tone. This is the single source of the
 * cap-at-four rule shared by {@link accidentalGlyph} and the staff layout. */
export function accidentalCount(accidental: number): number {
  const n = Math.trunc(accidental);
  return n === 0 ? 0 : Math.min(Math.abs(n), 4);
}

/** Unicode accidental glyph for a signed semitone offset. Multi-semitone
 * accidentals repeat the single glyph (`♭♭` / `♯♯` / `♭♭♭`) so they render in
 * any font, unlike the dedicated U+1D12A/B double glyphs — and so the full
 * `StaffNote.accidental` range is covered: the core can emit ±3 for an
 * enharmonically-extreme root (e.g. `Cbdim7`'s triple-flat seventh), which a
 * fixed `-2..=2` switch would have dropped to no glyph at all. Capped via
 * {@link accidentalCount}. Retained as an exported helper for textual /
 * accessible-label use; the staff itself draws Bravura glyphs (see
 * {@link ChordStaff}). */
export function accidentalGlyph(accidental: number): string {
  const n = Math.trunc(accidental);
  if (n === 0) return '';
  return (n < 0 ? '♭' : '♯').repeat(accidentalCount(accidental));
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
  /** Which Bravura accidental glyph to draw before the notehead, or `null`
   * when the active key signature already accounts for the tone (or the tone
   * is a plain natural with no signature). The number of glyphs is
   * `accXs.length` (see {@link accidentalCount}; a `natural` is always one). */
  accKind: AccidentalKind | null;
  /** Left-edge x of each accidental glyph drawn before the notehead. */
  accXs: number[];
  ledgers: number[];
  midi: number;
}

/** A laid-out key-signature accidental (relative-space `cy`, before
 * normalisation). */
interface SignatureColumn {
  x: number;
  cy: number;
  kind: 'sharp' | 'flat';
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
  /** Key-signature accidentals drawn between the clef and the first notehead,
   * in conventional order. Empty for no key (or a natural-signature key). */
  signature: Array<{
    x: number;
    cy: number;
    kind: 'sharp' | 'flat';
  }>;
  columns: Array<{
    x: number;
    cy: number;
    accKind: AccidentalKind | null;
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
 *
 * When `keySig` is supplied the staff draws that key's signature after the
 * clef and renders each notehead relative to it (in-key tones lose their
 * inline accidental; out-of-key tones gain one, including a natural to cancel
 * a signature sharp/flat). `null` reproduces the key-agnostic layout.
 */
export function buildStaffModel(
  notes: readonly StaffNote[],
  keySig: StaffKeySignature | null = null,
): StaffModel {
  // Lay columns out with a running cursor so each accidental reserves its own
  // horizontal slot before the notehead (real Bravura accidentals are ~1 staff
  // space wide and would otherwise collide with the previous tone).
  let cursor = NOTE_START_X;

  // Key signature first, in the gap between the clef and the first notehead.
  const signature: SignatureColumn[] = [];
  if (keySig !== null && keySig.accidentals.length > 0) {
    for (const acc of keySig.accidentals) {
      const glyphW = accidentalFor(acc.kind).advance * GLYPH_S;
      signature.push({ x: cursor, cy: relY(acc.step), kind: acc.kind });
      cursor += glyphW + SIG_GAP;
    }
    cursor += SIG_NOTE_GAP;
  }

  const columns: StaffColumn[] = notes.map((note) => {
    const step = staffStep(note);
    const accKind = inlineAccidentalFor(note, keySig);
    const accXs: number[] = [];
    if (accKind !== null) {
      const glyphW = accidentalFor(accKind).advance * GLYPH_S;
      // A natural is a single glyph; sharps/flats may stack (double / triple).
      const count = accKind === 'natural' ? 1 : accidentalCount(note.accidental);
      for (let j = 0; j < count; j++) accXs.push(cursor + j * glyphW);
      cursor += count * glyphW + ACC_NOTE_GAP;
    }
    const x = cursor + NOTEHEAD_HALF_W;
    cursor = x + NOTEHEAD_HALF_W + COL_GAP;
    return {
      x,
      cy: relY(step),
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
  for (const sig of signature) {
    const g = accidentalFor(sig.kind);
    minRel = Math.min(minRel, sig.cy - g.bbox.maxY * GLYPH_S);
    maxRel = Math.max(maxRel, sig.cy - g.bbox.minY * GLYPH_S);
  }
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
    signature: signature.map((sig) => ({
      x: sig.x,
      cy: sig.cy + offsetY,
      kind: sig.kind,
    })),
    columns: columns.map((col) => ({
      x: col.x,
      cy: col.cy + offsetY,
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
   * The song key in effect at the chord's position (a ChordPro `{key}` value
   * such as `"C"`, `"D"`, `"F# minor"`). When supplied and parseable as a
   * tonal key, the staff draws that key's signature after the clef and renders
   * each notehead relative to it (in-key tones drop their inline accidental;
   * out-of-key tones gain one). Omit — or pass a modal / unparseable value —
   * to spell every altered tone inline (the key-agnostic default). Honouring
   * mid-song modulation is the caller's job: pass the key active at this
   * chord's source line (see `activeKeyAtLine`).
   */
  musicKey?: string | null;
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
  musicKey,
  loadingFallback,
  wasmLoader,
  className,
  ...divProps
}: ChordStaffProps): JSX.Element {
  const { notes, loading } = useChordStaff(chord, wasmLoader);
  const keySig = staffKeySignature(musicKey);
  const wrapperClass = ['chordsketch-staff', className].filter(Boolean).join(' ');
  // The key only narrows how accidentals are drawn; when the chord renders
  // against a tonal key, name it in the accessible label so a screen-reader
  // user knows the signature applies (e.g. "… on a staff in D").
  const inKey = keySig !== null && typeof musicKey === 'string' && musicKey.trim().length > 0;
  const label = inKey
    ? `Notes of ${displayName ?? chord} on a staff in ${musicKey!.trim()}`
    : `Notes of ${displayName ?? chord} on a staff`;

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

  const model = buildStaffModel(notes, keySig);

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
        {/* Key signature (sharps or flats) after the clef. */}
        {model.signature.map((sig, i) => (
          <path
            key={`sig-${i}`}
            className="chordsketch-staff__signature"
            d={accidentalFor(sig.kind).d}
            transform={smuflTransform({
              staffSpace: LINE_GAP,
              fontAnchorX: 0,
              fontAnchorY: 0,
              targetX: sig.x,
              targetY: sig.cy,
            })}
            fill="currentColor"
          />
        ))}
        {/* Noteheads, ledger lines, accidentals */}
        {model.columns.map((col, i) => {
          const accKind = col.accKind;
          return (
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
              {accKind !== null
                ? col.accXs.map((ax, j) => (
                    <path
                      key={`acc-${i}-${j}`}
                      className="chordsketch-staff__accidental"
                      d={accidentalFor(accKind).d}
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
          );
        })}
      </svg>
    </div>
  );
}
