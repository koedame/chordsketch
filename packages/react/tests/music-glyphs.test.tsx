import { describe, expect, test } from 'vitest';
import { render } from '@testing-library/react';

import {
  KeySignatureGlyph,
  MetronomeGlyph,
  TimeSignatureGlyph,
  keySignatureFor,
  relativeMajor,
  tempoMarkingFor,
} from '../src/music-glyphs';

describe('keySignatureFor', () => {
  // Key signature lookups against the Wikipedia "Key signature"
  // table — these are the canonical western-notation values.
  test.each([
    // major
    ['C', 0, 'natural'],
    ['G', 1, 'sharp'],
    ['D', 2, 'sharp'],
    ['A', 3, 'sharp'],
    ['E', 4, 'sharp'],
    ['B', 5, 'sharp'],
    ['F#', 6, 'sharp'],
    ['C#', 7, 'sharp'],
    ['F', 1, 'flat'],
    ['Bb', 2, 'flat'],
    ['Eb', 3, 'flat'],
    ['Ab', 4, 'flat'],
    ['Db', 5, 'flat'],
    ['Gb', 6, 'flat'],
    ['Cb', 7, 'flat'],
  ])('%s maps to %d %s', (input, count, type) => {
    const sig = keySignatureFor(input);
    expect(sig).not.toBeNull();
    expect(sig?.count).toBe(count);
    expect(sig?.type).toBe(type);
  });

  // Minor keys map to relative major (count + type unchanged).
  test.each([
    ['Am', 0, 'natural'],
    ['Em', 1, 'sharp'],
    ['Bm', 2, 'sharp'],
    ['F#m', 3, 'sharp'],
    ['Dm', 1, 'flat'],
    ['Gm', 2, 'flat'],
    ['Cm', 3, 'flat'],
  ])('minor key %s maps to %d %s (relative major)', (input, count, type) => {
    const sig = keySignatureFor(input);
    expect(sig).not.toBeNull();
    expect(sig?.count).toBe(count);
    expect(sig?.type).toBe(type);
  });

  test('accepts unicode ♯ / ♭ accidentals and lowercase trailing m', () => {
    expect(keySignatureFor('F♯')?.count).toBe(6);
    expect(keySignatureFor('B♭')?.count).toBe(2);
    expect(keySignatureFor('e MIN')?.count).toBe(1); // case-insensitive `min` suffix
  });

  test('returns null for unparseable input', () => {
    expect(keySignatureFor('')).toBeNull();
    expect(keySignatureFor('not a key')).toBeNull();
    expect(keySignatureFor('H')).toBeNull(); // German "B" — out of scope
  });
});

// `relativeMajor` is no longer used by `keySignatureFor` (which
// now consults explicit major and minor tables) but is still
// exported for callers that need the chromatic transpose. Its
// flat-vs-sharp spelling preference is conservative: it returns
// a flat spelling only when the input itself was flat-spelled.
// The previous "Cm should map to Eb" expectation was a
// `keySignatureFor` requirement, not a `relativeMajor` invariant
// — that lookup is now table-driven.
describe('tempoMarkingFor', () => {
  test.each([
    [30, 'Grave'],
    [50, 'Largo'],
    [62, 'Larghetto'],
    [70, 'Adagio'],
    [90, 'Andante'],
    [110, 'Moderato'],
    [120, 'Allegro'],
    [140, 'Allegro'],
    [170, 'Vivace'],
    [180, 'Presto'],
    [220, 'Prestissimo'],
  ])('%d BPM → %s', (bpm, marking) => {
    expect(tempoMarkingFor(bpm)).toBe(marking);
  });

  test('rejects non-finite / non-positive BPM', () => {
    expect(tempoMarkingFor(0)).toBeNull();
    expect(tempoMarkingFor(-10)).toBeNull();
    expect(tempoMarkingFor(NaN)).toBeNull();
    expect(tempoMarkingFor(Infinity)).toBeNull();
  });
});

describe('relativeMajor', () => {
  test('Em → G', () => expect(relativeMajor('E', '')).toBe('G'));
  test('Dm → F', () => expect(relativeMajor('D', '')).toBe('F'));
  test('F#m → A', () => expect(relativeMajor('F', '#')).toBe('A'));
  test('Bbm → Db (flat-preferring on flat-spelled input)', () =>
    expect(relativeMajor('B', 'b')).toBe('Db'));
});

describe('<KeySignatureGlyph>', () => {
  test('renders 5 staff lines + treble clef + N accidentals for sharps', () => {
    const { container } = render(<KeySignatureGlyph keyName="A" />);
    const svg = container.querySelector('svg.music-glyph--key');
    expect(svg).not.toBeNull();
    // 5 horizontal staff lines.
    expect(svg?.querySelectorAll('line[y1][y2]').length).toBeGreaterThanOrEqual(5);
    // Each sharp glyph renders as a `<g>` group with 4 inner lines.
    const sharpGroups = svg?.querySelectorAll('g');
    expect(sharpGroups?.length).toBe(3); // 3 sharps for A major + clef? No, clef is path
  });

  test('renders flats for flat keys', () => {
    const { container } = render(<KeySignatureGlyph keyName="Eb" />);
    const svg = container.querySelector('svg.music-glyph--key');
    expect(svg).not.toBeNull();
    // 3 flats for Eb major — each is a `<g>` group.
    expect(svg?.querySelectorAll('g').length).toBe(3);
  });

  test('renders just the staff + clef for C major (no accidentals)', () => {
    const { container } = render(<KeySignatureGlyph keyName="C" />);
    const svg = container.querySelector('svg.music-glyph--key');
    expect(svg).not.toBeNull();
    expect(svg?.querySelectorAll('g').length).toBe(0);
  });

  test('aria-label spells out the key + accidental count for screen readers', () => {
    const { container } = render(<KeySignatureGlyph keyName="A" />);
    expect(container.querySelector('svg')?.getAttribute('aria-label')).toBe(
      'Key A (3 sharps)',
    );
    const cMajor = render(<KeySignatureGlyph keyName="C" />);
    expect(cMajor.container.querySelector('svg')?.getAttribute('aria-label')).toBe(
      'Key C (no accidentals)',
    );
  });

  test('falls back to a label for an unrecognised key', () => {
    const { container } = render(<KeySignatureGlyph keyName="H" />);
    expect(container.querySelector('svg')?.getAttribute('aria-label')).toBe('Key H');
  });
});

describe('<MetronomeGlyph>', () => {
  // The CSS animation runs with `animation-direction: alternate`,
  // so `--cs-metronome-period` is the half-cycle duration (one
  // extreme-to-extreme sweep). Two ticks per full back-and-forth
  // ⇒ one tick every `period` seconds ⇒ exactly `bpm` ticks per
  // minute. A regression that flips the formula back to
  // `60/bpm * 2` would double the period and tick at half speed.
  test('writes the BPM-derived half-cycle period into a CSS custom property', () => {
    const { container } = render(<MetronomeGlyph bpm={120} />);
    const svg = container.querySelector('svg.music-glyph--metronome') as SVGSVGElement | null;
    expect(svg).not.toBeNull();
    // 120 BPM → half-cycle = 60/120 = 0.500s.
    expect(svg?.style.getPropertyValue('--cs-metronome-period')).toBe('0.500s');
  });

  test('60 BPM → 1 s half-cycle (canonical Largo rate)', () => {
    const { container } = render(<MetronomeGlyph bpm={60} />);
    const svg = container.querySelector('svg') as SVGSVGElement | null;
    expect(svg?.style.getPropertyValue('--cs-metronome-period')).toBe('1.000s');
  });

  test('clamps absurd BPM values into a sane animation period', () => {
    const fast = render(<MetronomeGlyph bpm={99999} />);
    const slow = render(<MetronomeGlyph bpm={0.001} />);
    const fastP = parseFloat(
      (fast.container.querySelector('svg') as SVGSVGElement | null)?.style.getPropertyValue(
        '--cs-metronome-period',
      ) ?? '',
    );
    const slowP = parseFloat(
      (slow.container.querySelector('svg') as SVGSVGElement | null)?.style.getPropertyValue(
        '--cs-metronome-period',
      ) ?? '',
    );
    // Clamp range is now [0.05, 5] seconds.
    expect(fastP).toBeGreaterThanOrEqual(0.05);
    expect(slowP).toBeLessThanOrEqual(5);
  });

  test('falls back to 60 BPM for non-finite input', () => {
    const { container } = render(<MetronomeGlyph bpm={NaN} />);
    const svg = container.querySelector('svg') as SVGSVGElement | null;
    expect(svg?.style.getPropertyValue('--cs-metronome-period')).toBe('1.000s');
  });

  test('models an inverted pendulum: pivot at the base, rod extending up', () => {
    const { container } = render(<MetronomeGlyph bpm={120} />);
    const svg = container.querySelector('svg') as SVGSVGElement | null;
    // Static pivot dot at (9, 19).
    const pivot = svg?.querySelector('circle[cx="9"][cy="19"]');
    expect(pivot).not.toBeNull();
    // Rod inside the pendulum group goes from (9, 19) up to (9, 2).
    const rod = svg?.querySelector('.music-glyph--metronome__pendulum line');
    expect(rod?.getAttribute('y1')).toBe('19');
    expect(rod?.getAttribute('y2')).toBe('2');
  });

  test('aria-label exposes the BPM value', () => {
    const { container } = render(<MetronomeGlyph bpm={120} />);
    expect(container.querySelector('svg')?.getAttribute('aria-label')).toBe(
      'Metronome at 120 BPM',
    );
  });
});

describe('<TimeSignatureGlyph>', () => {
  test('renders 4/4 as stacked numerator + denominator spans', () => {
    const { container } = render(<TimeSignatureGlyph value="4/4" />);
    const glyph = container.querySelector('.music-glyph--time');
    expect(glyph).not.toBeNull();
    expect(glyph?.querySelector('.music-glyph--time__num')?.textContent).toBe('4');
    expect(glyph?.querySelector('.music-glyph--time__den')?.textContent).toBe('4');
    expect(glyph?.getAttribute('aria-label')).toBe('Time signature 4 over 4');
  });

  test('renders 6/8 correctly', () => {
    const { container } = render(<TimeSignatureGlyph value="6/8" />);
    expect(container.querySelector('.music-glyph--time__num')?.textContent).toBe('6');
    expect(container.querySelector('.music-glyph--time__den')?.textContent).toBe('8');
  });

  test('renders a horizontal fraction bar between numerator and denominator', () => {
    const { container } = render(<TimeSignatureGlyph value="3/4" />);
    expect(container.querySelector('.music-glyph--time__bar')).not.toBeNull();
  });

  // Conductor's wrist animation is opt-in via the `bpm` prop —
  // omitting BPM leaves the glyph static so it never animates on
  // a song that has no tempo declared.
  test('renders statically (no conductor class, no period) when bpm is unset', () => {
    const { container } = render(<TimeSignatureGlyph value="4/4" />);
    const glyph = container.querySelector('.music-glyph--time') as HTMLElement | null;
    expect(glyph).not.toBeNull();
    expect(
      Array.from(glyph?.classList ?? []).some((c) => c.startsWith('music-glyph--time--conduct-')),
    ).toBe(false);
    expect(glyph?.style.getPropertyValue('--cs-time-period')).toBe('');
  });

  test('writes conductor-N class + period from numerator * (60/bpm)', () => {
    const { container } = render(<TimeSignatureGlyph value="4/4" bpm={120} />);
    const glyph = container.querySelector('.music-glyph--time') as HTMLElement | null;
    expect(glyph?.classList.contains('music-glyph--time--conduct-4')).toBe(true);
    // 4 beats * (60/120) = 2.000s per measure.
    expect(glyph?.style.getPropertyValue('--cs-time-period')).toBe('2.000s');
  });

  test('3/4 at 90 BPM → conduct-3 with 2.000s cycle', () => {
    const { container } = render(<TimeSignatureGlyph value="3/4" bpm={90} />);
    const glyph = container.querySelector('.music-glyph--time') as HTMLElement | null;
    expect(glyph?.classList.contains('music-glyph--time--conduct-3')).toBe(true);
    // 3 * 60/90 = 2.000s.
    expect(glyph?.style.getPropertyValue('--cs-time-period')).toBe('2.000s');
  });

  test('6/8 picks the 6-beat conductor pattern', () => {
    const { container } = render(<TimeSignatureGlyph value="6/8" bpm={120} />);
    const glyph = container.querySelector('.music-glyph--time') as HTMLElement | null;
    expect(glyph?.classList.contains('music-glyph--time--conduct-6')).toBe(true);
  });

  test('5/4 (unsupported numerator) renders statically without a conductor class', () => {
    const { container } = render(<TimeSignatureGlyph value="5/4" bpm={120} />);
    const glyph = container.querySelector('.music-glyph--time') as HTMLElement | null;
    expect(
      Array.from(glyph?.classList ?? []).some((c) => c.startsWith('music-glyph--time--conduct-')),
    ).toBe(false);
  });

  test('clamps the conductor period for absurd BPM', () => {
    const { container } = render(<TimeSignatureGlyph value="4/4" bpm={99999} />);
    const glyph = container.querySelector('.music-glyph--time') as HTMLElement | null;
    const period = parseFloat(glyph?.style.getPropertyValue('--cs-time-period') ?? '');
    expect(period).toBeGreaterThanOrEqual(0.3);
  });

  test('falls back to plain text for non-fraction input ("C", "common", blank)', () => {
    for (const v of ['C', 'common', '']) {
      const { container } = render(<TimeSignatureGlyph value={v} />);
      // No stacked numerator/denominator spans.
      expect(container.querySelector('.music-glyph--time__num')).toBeNull();
      expect(container.querySelector('.music-glyph--time__den')).toBeNull();
    }
  });
});
