import { render, waitFor } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

import { ACCIDENTAL_FLAT } from '../src/bravura-glyphs';
import {
  ChordStaff,
  accidentalGlyph,
  buildStaffModel,
  ledgerSteps,
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
    expect(model.columns.every((c) => c.accidental === '')).toBe(true);
  });

  test('buildStaffModel emits flat glyphs for a flat-spelled chord', () => {
    const model = buildStaffModel(EBM7);
    expect(model.columns.every((c) => c.accidental === '♭')).toBe(true);
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
