import { describe, expect, test } from 'vitest';

import {
  irealCanonicalSymbolText,
  irealChordQualityToString,
  irealChordRootToString,
  irealChordToString,
  irealIsDaCapo,
  irealIsDalSegno,
  irealSectionLabelToString,
  type IrealChord,
  type IrealChordQuality,
  type IrealChordRoot,
  type IrealMusicalSymbol,
  type IrealSectionLabel,
} from '../src/ireal-ast';

describe('irealChordRootToString', () => {
  test.each<[IrealChordRoot, string]>([
    [{ note: 'C', accidental: 'natural' }, 'C'],
    [{ note: 'B', accidental: 'flat' }, 'Bb'],
    [{ note: 'F', accidental: 'sharp' }, 'F#'],
  ])('renders %o as %s', (root, expected) => {
    expect(irealChordRootToString(root)).toBe(expected);
  });
});

describe('irealChordQualityToString', () => {
  test.each<[IrealChordQuality, string]>([
    [{ kind: 'major' }, ''],
    [{ kind: 'minor' }, '-'],
    [{ kind: 'diminished' }, 'o'],
    [{ kind: 'augmented' }, '+'],
    [{ kind: 'major7' }, '^7'],
    [{ kind: 'minor7' }, '-7'],
    [{ kind: 'dominant7' }, '7'],
    [{ kind: 'half_diminished' }, 'h7'],
    [{ kind: 'diminished7' }, 'o7'],
    [{ kind: 'suspended2' }, 'sus2'],
    [{ kind: 'suspended4' }, 'sus4'],
    [{ kind: 'custom', value: '7b9' }, '7b9'],
  ])('renders %o as %s', (quality, expected) => {
    expect(irealChordQualityToString(quality)).toBe(expected);
  });
});

describe('irealChordToString', () => {
  test('includes slash-bass when present', () => {
    const chord: IrealChord = {
      root: { note: 'D', accidental: 'natural' },
      quality: { kind: 'minor7' },
      bass: { note: 'G', accidental: 'natural' },
    };
    expect(irealChordToString(chord)).toBe('D-7/G');
  });

  test('omits the slash-bass section when bass is null', () => {
    const chord: IrealChord = {
      root: { note: 'C', accidental: 'sharp' },
      quality: { kind: 'major7' },
      bass: null,
    };
    expect(irealChordToString(chord)).toBe('C#^7');
  });
});

describe('irealSectionLabelToString', () => {
  test.each<[IrealSectionLabel, string]>([
    [{ kind: 'verse' }, 'Verse'],
    [{ kind: 'chorus' }, 'Chorus'],
    [{ kind: 'intro' }, 'Intro'],
    [{ kind: 'outro' }, 'Outro'],
    [{ kind: 'bridge' }, 'Bridge'],
    [{ kind: 'letter', value: 'A' }, 'A'],
    [{ kind: 'custom', value: 'Vamp' }, 'Vamp'],
  ])('renders %o as %s', (label, expected) => {
    expect(irealSectionLabelToString(label)).toBe(expected);
  });
});

describe('irealIsDaCapo', () => {
  test.each<[IrealMusicalSymbol | null, boolean]>([
    [null, false],
    ['segno', false],
    ['coda', false],
    ['fine', false],
    ['fermata', false],
    ['break', false],
    ['da_capo', true],
    ['da_capo_al_coda', true],
    ['da_capo_al_fine', true],
    ['da_capo_al_1st_end', true],
    ['da_capo_al_2nd_end', true],
    ['da_capo_al_3rd_end', true],
    ['da_capo_al_4th_end', true],
    ['dal_segno', false],
    ['dal_segno_al_coda', false],
  ])('classifies %o as %o', (symbol, expected) => {
    expect(irealIsDaCapo(symbol)).toBe(expected);
  });
});

describe('irealIsDalSegno', () => {
  test.each<[IrealMusicalSymbol | null, boolean]>([
    [null, false],
    ['segno', false],
    ['da_capo', false],
    ['da_capo_al_coda', false],
    ['dal_segno', true],
    ['dal_segno_al_coda', true],
    ['dal_segno_al_fine', true],
    ['dal_segno_al_1st_end', true],
    ['dal_segno_al_2nd_end', true],
    ['dal_segno_al_3rd_end', true],
    ['dal_segno_al_4th_end', true],
  ])('classifies %o as %o', (symbol, expected) => {
    expect(irealIsDalSegno(symbol)).toBe(expected);
  });
});

describe('irealCanonicalSymbolText', () => {
  test.each<[IrealMusicalSymbol, string | null]>([
    ['segno', null],
    ['coda', null],
    ['fermata', null],
    ['fine', 'Fine'],
    ['break', 'Break'],
    ['da_capo', 'D.C.'],
    ['da_capo_al_coda', 'D.C. al Coda'],
    ['da_capo_al_fine', 'D.C. al Fine'],
    ['da_capo_al_1st_end', 'D.C. al 1st End.'],
    ['da_capo_al_2nd_end', 'D.C. al 2nd End.'],
    ['da_capo_al_3rd_end', 'D.C. al 3rd End.'],
    ['da_capo_al_4th_end', 'D.C. al 4th End.'],
    ['dal_segno', 'D.S.'],
    ['dal_segno_al_coda', 'D.S. al Coda'],
    ['dal_segno_al_fine', 'D.S. al Fine'],
    ['dal_segno_al_1st_end', 'D.S. al 1st End.'],
    ['dal_segno_al_2nd_end', 'D.S. al 2nd End.'],
    ['dal_segno_al_3rd_end', 'D.S. al 3rd End.'],
    ['dal_segno_al_4th_end', 'D.S. al 4th End.'],
  ])('renders %o as %o', (symbol, expected) => {
    expect(irealCanonicalSymbolText(symbol)).toBe(expected);
  });

  test('returns null for an unrecognised ordinal-bearing variant', () => {
    // The type system would normally prevent this, but a wasm AST
    // produced by a future Rust release could carry an unknown
    // ordinal pattern; the helper must NOT throw on it.
    const malformed = 'da_capo_al_unknown_end' as unknown as IrealMusicalSymbol;
    expect(irealCanonicalSymbolText(malformed)).toBeNull();
  });
});
