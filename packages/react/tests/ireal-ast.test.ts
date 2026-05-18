import { describe, expect, test } from 'vitest';

import {
  irealChordQualityToString,
  irealChordRootToString,
  irealChordToString,
  irealSectionLabelToString,
  type IrealChord,
  type IrealChordQuality,
  type IrealChordRoot,
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
