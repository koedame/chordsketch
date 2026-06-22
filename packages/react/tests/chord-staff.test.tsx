import { render, waitFor } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

import { ACCIDENTAL_FLAT, ACCIDENTAL_NATURAL } from '../src/bravura-glyphs';
import {
  ChordStaff,
  accidentalCount,
  accidentalGlyph,
  buildStaffModel,
  ledgerSteps,
  staffKeySignature,
  staffStep,
} from '../src/chord-staff';
import type { ChordStaffWasmLoader, StaffNote } from '../src/use-chord-staff';

// -- Fixtures ------------------------------------------------------

const CMAJ9: StaffNote[] = [
  { letter: 'C', accidental: 0, octave: 4, midi: 60 },
  { letter: 'E', accidental: 0, octave: 4, midi: 64 },
  { letter: 'G', accidental: 0, octave: 4, midi: 67 },
  { letter: 'B', accidental: 0, octave: 4, midi: 71 },
  { letter: 'D', accidental: 0, octave: 5, midi: 74 },
];
const EBM7: StaffNote[] = [
  { letter: 'E', accidental: -1, octave: 4, midi: 63 },
  { letter: 'G', accidental: -1, octave: 4, midi: 66 },
  { letter: 'B', accidental: -1, octave: 4, midi: 70 },
  { letter: 'D', accidental: -1, octave: 5, midi: 73 },
];
// A major triad — A C♯ E (the C♯ is the only altered tone), as
// `chord_staff_notes("A")` spells it (root centred at A4).
const A_MAJOR: StaffNote[] = [
  { letter: 'A', accidental: 0, octave: 4, midi: 69 },
  { letter: 'C', accidental: 1, octave: 5, midi: 73 },
  { letter: 'E', accidental: 0, octave: 5, midi: 76 },
];
// F major triad — F A C, all natural — used to exercise a natural cancelling
// a signature sharp (F♮ in a key whose signature sharps F).
const F_MAJOR: StaffNote[] = [
  { letter: 'F', accidental: 0, octave: 4, midi: 65 },
  { letter: 'A', accidental: 0, octave: 4, midi: 69 },
  { letter: 'C', accidental: 0, octave: 5, midi: 72 },
];

function makeLoader(table: Record<string, StaffNote[]>): ChordStaffWasmLoader {
  return vi.fn(
    async () =>
      ({
        default: vi.fn(async () => undefined),
        chordStaffNotes: (chord: string) => table[chord] ?? null,
      }) as unknown as Awaited<ReturnType<ChordStaffWasmLoader>>,
  );
}

// -- Pure geometry helpers ----------------------------------------

describe('staff geometry helpers', () => {
  test('staffStep counts diatonic letters from C0', () => {
    // E4 (bottom treble line) = 30; F5 (top line) = 38; middle C4 = 28.
    expect(staffStep({ letter: 'E', accidental: 0, octave: 4, midi: 64 })).toBe(30);
    expect(staffStep({ letter: 'F', accidental: 0, octave: 5, midi: 77 })).toBe(38);
    expect(staffStep({ letter: 'C', accidental: 0, octave: 4, midi: 60 })).toBe(28);
  });

  test('accidentalGlyph maps signed offsets to Unicode across the full range', () => {
    expect(accidentalGlyph(-2)).toBe('♭♭');
    expect(accidentalGlyph(-1)).toBe('♭');
    expect(accidentalGlyph(0)).toBe('');
    expect(accidentalGlyph(1)).toBe('♯');
    expect(accidentalGlyph(2)).toBe('♯♯');
    // The core can emit ±3 for an enharmonically-extreme root (e.g. Cbdim7);
    // the glyph must render it rather than silently dropping to no accidental.
    expect(accidentalGlyph(-3)).toBe('♭♭♭');
    expect(accidentalGlyph(3)).toBe('♯♯♯');
  });

  test('accidentalCount caps at four and shares the rule with accidentalGlyph', () => {
    expect(accidentalCount(0)).toBe(0);
    expect(accidentalCount(-1)).toBe(1);
    expect(accidentalCount(2)).toBe(2);
    expect(accidentalCount(3)).toBe(3);
    // Pathological value is capped at four, matching accidentalGlyph's length.
    expect(accidentalCount(9)).toBe(4);
    expect(accidentalCount(-9)).toBe(4);
    for (const n of [-9, -3, -1, 0, 1, 2, 3, 9]) {
      expect(accidentalGlyph(n).length).toBe(accidentalCount(n));
    }
  });

  test('ledgerSteps adds lines for notes outside the staff only', () => {
    // Within the staff (E4..F5): no ledgers.
    expect(ledgerSteps(30)).toEqual([]);
    expect(ledgerSteps(34)).toEqual([]);
    // Middle C (28) needs one ledger line below.
    expect(ledgerSteps(28)).toEqual([28]);
    // A note a space below middle C still hangs off the C4 ledger only.
    expect(ledgerSteps(27)).toEqual([28]);
    // Two ledgers below for A3 (26).
    expect(ledgerSteps(26)).toEqual([28, 26]);
    // Above the top line: A5 (40) gets one ledger.
    expect(ledgerSteps(40)).toEqual([40]);
    // The space directly above the top line needs none.
    expect(ledgerSteps(39)).toEqual([]);
  });

  test('buildStaffModel lays notes left-to-right with five ascending lines', () => {
    const model = buildStaffModel(CMAJ9);
    expect(model.columns).toHaveLength(5);
    // Five staff lines, ordered top (smallest y) to bottom.
    expect(model.lineYs).toHaveLength(5);
    for (let i = 1; i < model.lineYs.length; i++) {
      expect(model.lineYs[i]!).toBeGreaterThan(model.lineYs[i - 1]!);
    }
    // Columns ascend in x; higher-pitched notes sit higher (smaller y).
    for (let i = 1; i < model.columns.length; i++) {
      expect(model.columns[i]!.x).toBeGreaterThan(model.columns[i - 1]!.x);
      expect(model.columns[i]!.cy).toBeLessThan(model.columns[i - 1]!.cy);
    }
    // Middle C (first column) hangs below the staff → one ledger line.
    expect(model.columns[0]!.ledgerYs).toHaveLength(1);
    // All-natural chord → no accidental glyphs.
    expect(model.columns.every((c) => c.accKind === null && c.accXs.length === 0)).toBe(true);
  });

  test('buildStaffModel emits one flat glyph per tone for a flat-spelled chord', () => {
    const model = buildStaffModel(EBM7);
    expect(model.columns.every((c) => c.accKind === 'flat' && c.accXs.length === 1)).toBe(true);
  });

  test('buildStaffModel without a key draws no signature', () => {
    const model = buildStaffModel(A_MAJOR);
    expect(model.signature).toHaveLength(0);
  });
});

// -- Key-aware staff ----------------------------------------------

describe('staffKeySignature', () => {
  test('returns null for no key, blank, or a modal / unparseable value', () => {
    expect(staffKeySignature(undefined)).toBeNull();
    expect(staffKeySignature(null)).toBeNull();
    expect(staffKeySignature('   ')).toBeNull();
    expect(staffKeySignature('C dorian')).toBeNull();
    expect(staffKeySignature('not-a-key')).toBeNull();
  });

  test('a natural-signature key is present but empty', () => {
    // C major / A minor: a real key context with zero accidentals — distinct
    // from "no key" so the staff still renders against it.
    expect(staffKeySignature('C')).toEqual({ accidentals: [], alterations: {} });
    expect(staffKeySignature('Am')).toEqual({ accidentals: [], alterations: {} });
  });

  test('maps a sharp key to ordered sharps and per-letter alterations', () => {
    const sig = staffKeySignature('D')!;
    // D major = 2 sharps (F♯ C♯) on their conventional treble steps.
    expect(sig.accidentals).toEqual([
      { step: 38, kind: 'sharp' },
      { step: 35, kind: 'sharp' },
    ]);
    expect(sig.alterations).toEqual({ F: 1, C: 1 });
  });

  test('maps a flat key to ordered flats and per-letter alterations', () => {
    const sig = staffKeySignature('Eb')!;
    // E♭ major = 3 flats (B♭ E♭ A♭).
    expect(sig.accidentals.map((a) => a.kind)).toEqual(['flat', 'flat', 'flat']);
    expect(sig.alterations).toEqual({ B: -1, E: -1, A: -1 });
  });

  test('a minor key resolves to its relative-major signature', () => {
    // E minor shares G major's signature (1 sharp, F♯).
    expect(staffKeySignature('Em')!.alterations).toEqual({ F: 1 });
  });
});

describe('buildStaffModel with a key signature', () => {
  test('draws the signature and suppresses in-key accidentals', () => {
    const model = buildStaffModel(A_MAJOR, staffKeySignature('D'));
    // Two sharps drawn after the clef.
    expect(model.signature).toHaveLength(2);
    expect(model.signature.every((s) => s.kind === 'sharp')).toBe(true);
    // The signature sits left of every notehead.
    const firstNoteX = Math.min(...model.columns.map((c) => c.x));
    expect(Math.max(...model.signature.map((s) => s.x))).toBeLessThan(firstNoteX);
    // C♯ is implied by the D-major signature, and A/E are natural → NO inline
    // accidental on any tone.
    expect(model.columns.every((c) => c.accKind === null)).toBe(true);
  });

  test('without the key the same chord spells its sharp inline', () => {
    const model = buildStaffModel(A_MAJOR);
    const sharps = model.columns.filter((c) => c.accKind === 'sharp');
    expect(sharps).toHaveLength(1); // the C♯
  });

  test('draws a natural to cancel a signature sharp on an out-of-key tone', () => {
    // F major triad in G major (1 sharp, F♯): F♮ contradicts the signature →
    // natural; A and C are not altered by the G signature → no glyph.
    const model = buildStaffModel(F_MAJOR, staffKeySignature('G'));
    const naturals = model.columns.filter((c) => c.accKind === 'natural');
    expect(naturals).toHaveLength(1);
    expect(naturals[0]!.accXs).toHaveLength(1); // a natural is a single glyph
    expect(model.columns.filter((c) => c.accKind === null)).toHaveLength(2);
  });

  test('cancels every tone the signature sharps (D sharps both F and C)', () => {
    // F major triad (F A C) in D major (F♯ C♯): BOTH F♮ and C♮ need naturals.
    const model = buildStaffModel(F_MAJOR, staffKeySignature('D'));
    expect(model.columns.filter((c) => c.accKind === 'natural')).toHaveLength(2);
    expect(model.columns.filter((c) => c.accKind === null)).toHaveLength(1); // A
  });

  test('suppresses only the tones the signature actually covers', () => {
    // E♭m7 (E♭ G♭ B♭ D♭) under E♭ major (B♭ E♭ A♭): E♭ and B♭ are covered;
    // G♭ and D♭ are not and keep their inline flat.
    const model = buildStaffModel(EBM7, staffKeySignature('Eb'));
    const covered = model.columns.filter((c) => c.accKind === null);
    const flats = model.columns.filter((c) => c.accKind === 'flat');
    expect(covered).toHaveLength(2);
    expect(flats).toHaveLength(2);
  });
});

// -- Component -----------------------------------------------------

describe('<ChordStaff>', () => {
  test('renders a labelled five-line staff with one notehead per tone', async () => {
    const { container } = render(
      <ChordStaff chord="Cmaj9" wasmLoader={makeLoader({ Cmaj9: CMAJ9 })} />,
    );
    await waitFor(() => {
      expect(container.querySelector('.chordsketch-staff__svg')).not.toBeNull();
    });
    const svg = container.querySelector('.chordsketch-staff__svg')!;
    expect(svg.getAttribute('aria-label')).toContain('Cmaj9');
    // Five staff lines + ledger line(s); five Bravura noteheads.
    expect(svg.querySelectorAll('.chordsketch-staff__notehead')).toHaveLength(5);
    expect(svg.querySelectorAll('.chordsketch-staff__note')).toHaveLength(5);
    // A treble clef path is drawn.
    expect(svg.querySelector('path')).not.toBeNull();
  });

  test('passes the display name into the accessible label', async () => {
    const { container } = render(
      <ChordStaff
        chord="Ebm7"
        displayName="E♭m7"
        wasmLoader={makeLoader({ Ebm7: EBM7 })}
      />,
    );
    await waitFor(() => {
      expect(container.querySelector('.chordsketch-staff__svg')).not.toBeNull();
    });
    expect(
      container.querySelector('.chordsketch-staff__svg')!.getAttribute('aria-label'),
    ).toContain('E♭m7');
    // One Bravura flat glyph (a `<path>`) accompanies each of the four tones.
    const accidentals = container.querySelectorAll('.chordsketch-staff__accidental');
    expect(accidentals).toHaveLength(4);
    expect(accidentals[0]!.tagName.toLowerCase()).toBe('path');
    expect(accidentals[0]!.getAttribute('d')).toBe(ACCIDENTAL_FLAT.d);
  });

  test('draws the active key signature and names the key in the label', async () => {
    const { container } = render(
      <ChordStaff chord="A" musicKey="D" wasmLoader={makeLoader({ A: A_MAJOR })} />,
    );
    await waitFor(() => {
      expect(container.querySelector('.chordsketch-staff__svg')).not.toBeNull();
    });
    const svg = container.querySelector('.chordsketch-staff__svg')!;
    // Two sharps drawn as signature glyphs, and the key is in the label.
    expect(svg.querySelectorAll('.chordsketch-staff__signature')).toHaveLength(2);
    expect(svg.getAttribute('aria-label')).toContain('in D');
    // C♯ is in the signature, so no inline note accidental is drawn.
    expect(svg.querySelectorAll('.chordsketch-staff__accidental')).toHaveLength(0);
  });

  test('draws a natural glyph for an out-of-key tone', async () => {
    const { container } = render(
      <ChordStaff chord="F" musicKey="G" wasmLoader={makeLoader({ F: F_MAJOR })} />,
    );
    await waitFor(() => {
      expect(container.querySelector('.chordsketch-staff__svg')).not.toBeNull();
    });
    const accidentals = container.querySelectorAll('.chordsketch-staff__accidental');
    // Exactly one inline accidental — the natural cancelling the F♯ signature.
    expect(accidentals).toHaveLength(1);
    expect(accidentals[0]!.getAttribute('d')).toBe(ACCIDENTAL_NATURAL.d);
  });

  test('a modal key falls back to the key-agnostic staff', async () => {
    const { container } = render(
      <ChordStaff chord="Ebm7" musicKey="C dorian" wasmLoader={makeLoader({ Ebm7: EBM7 })} />,
    );
    await waitFor(() => {
      expect(container.querySelector('.chordsketch-staff__svg')).not.toBeNull();
    });
    const svg = container.querySelector('.chordsketch-staff__svg')!;
    // No signature, and every flat tone spells inline (the pre-key behaviour).
    expect(svg.querySelectorAll('.chordsketch-staff__signature')).toHaveLength(0);
    expect(svg.querySelectorAll('.chordsketch-staff__accidental')).toHaveLength(4);
    expect(svg.getAttribute('aria-label')).not.toContain('dorian');
  });

  test('renders an "unavailable" figure when the chord is not parseable', async () => {
    const { container } = render(
      <ChordStaff chord="not-a-chord" wasmLoader={makeLoader({})} />,
    );
    await waitFor(() => {
      const fig = container.querySelector('[role="img"]');
      expect(fig?.getAttribute('aria-label')).toContain('unavailable');
    });
    expect(container.querySelector('.chordsketch-staff__svg')).toBeNull();
  });
});
