import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { describe, expect, test } from 'vitest';
import { render } from '@testing-library/react';

import {
  KeySignatureGlyph,
  MetronomeGlyph,
  TimeSignatureGlyph,
  keySignatureFor,
  metronomePeriodCss,
  metronomePeriodSeconds,
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

  // Dbm / Gbm / Cbm arise from `transposed_key_prefers_flat`
  // landings (e.g. `{key: Am}` +4 with prefer-flat → `Dbm`,
  // #2526). They have no standalone key signature — by convention
  // the glyph borrows the sharp-side enharmonic's signature
  // (Dbm ↔ C#m = 4 sharps, Gbm ↔ F#m = 3 sharps, Cbm ↔ Bm = 2
  // sharps). Without these entries the glyph emitted an empty
  // staff that contradicted `aria-label="Key Dbm"`.
  test.each([
    ['Dbm', 4, 'sharp'],
    ['Gbm', 3, 'sharp'],
    ['Cbm', 2, 'sharp'],
    ['D♭m', 4, 'sharp'],
  ])('enharmonic flat-side minor %s maps to %d %s', (input, count, type) => {
    const sig = keySignatureFor(input);
    expect(sig).not.toBeNull();
    expect(sig?.count).toBe(count);
    expect(sig?.type).toBe(type);
  });

  test('accepts unicode ♯ / ♭ accidentals and attached minor markers', () => {
    expect(keySignatureFor('F♯')?.count).toBe(6);
    expect(keySignatureFor('B♭')?.count).toBe(2);
    // Strict, attached minor markers (sister-site to Rust `parse_key`, #2665).
    expect(keySignatureFor('Em')?.count).toBe(1);
    expect(keySignatureFor('Emin')?.count).toBe(1);
    expect(keySignatureFor('E-')?.count).toBe(1);
  });

  test('a slash-bass key is looked up by its tonic', () => {
    // The bass note does not change the key signature (#2665).
    expect(keySignatureFor('G/B')).toEqual({ count: 1, type: 'sharp' });
  });

  test('returns null for unparseable input', () => {
    expect(keySignatureFor('')).toBeNull();
    expect(keySignatureFor('not a key')).toBeNull();
    expect(keySignatureFor('H')).toBeNull(); // German "B" — out of scope
  });

  test('returns null for malformed key notation (#2665)', () => {
    // A space before the marker, a spelled-out word, or a lowercase root is
    // not a valid key — the strict grammar rejects them, so there is no
    // signature (matching the Rust `parse_key` sister-site).
    expect(keySignatureFor('E minor')).toBeNull();
    expect(keySignatureFor('E m')).toBeNull();
    expect(keySignatureFor('Eminor')).toBeNull();
    expect(keySignatureFor('e min')).toBeNull();
    // A modal key has no single conventional signature here.
    expect(keySignatureFor('C dorian')).toBeNull();
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

  test('Dbm renders 4 sharps via the enharmonic C#m signature (#2526)', () => {
    // Before the gap was filled, Dbm rendered an empty staff
    // (0 accidental groups) while the aria-label still announced
    // "Key Dbm" — a silent visual + accessibility mismatch.
    const { container } = render(<KeySignatureGlyph keyName="Dbm" />);
    const svg = container.querySelector('svg.music-glyph--key');
    expect(svg).not.toBeNull();
    expect(svg?.querySelectorAll('g').length).toBe(4);
    expect(svg?.getAttribute('aria-label')).toBe('Key Dbm (4 sharps)');
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

  // Sharps sit above the top staff line at y≈1.4 and the clef
  // tail descends to y≈20.9. The viewBox MUST start at y=1 (not
  // y=0) so the visible content range is symmetric about the
  // viewBox center — otherwise the staff drifts visually high
  // inside a `.meta-inline` chip whose flex `align-items: center`
  // centers the SVG bounding box.
  test('viewBox y origin starts at 1, height 20 — content visually centered', () => {
    const { container } = render(<KeySignatureGlyph keyName="G" />);
    const svg = container.querySelector('svg.music-glyph--key');
    expect(svg?.getAttribute('viewBox')).toBe('0 1 18 20');
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
    expect(rod?.getAttribute('y2')).toBe('7');
  });

  // The triangular body occupies y=5..21 in user units and the
  // pendulum hardware fits inside that range. The viewBox MUST
  // be vertically tight around those bounds (`viewBox="0 4 18
  // 18"`) so the visual content center coincides with the SVG
  // bounding-box center — otherwise `align-items: center` on a
  // `.meta-inline` chip centers the empty viewBox padding rather
  // than the metronome itself, drifting the icon below the text.
  test('viewBox is vertically tight around the visible metronome body', () => {
    const { container } = render(<MetronomeGlyph bpm={120} />);
    const svg = container.querySelector('svg.music-glyph--metronome');
    expect(svg?.getAttribute('viewBox')).toBe('0 4 18 18');
  });

  test('aria-label exposes the BPM value', () => {
    const { container } = render(<MetronomeGlyph bpm={120} />);
    expect(container.querySelector('svg')?.getAttribute('aria-label')).toBe(
      'Metronome at 120 BPM',
    );
  });

  // The beat dot is a sibling of the pendulum group so it stays
  // put (only its opacity animates) while the rod swings. If a
  // regression nests it inside `.music-glyph--metronome__pendulum`
  // it would swing with the rod, breaking the "static LED" intent.
  test('emits a static top-left beat dot outside the swinging pendulum group', () => {
    const { container } = render(<MetronomeGlyph bpm={120} />);
    const svg = container.querySelector('svg.music-glyph--metronome');
    const beat = svg?.querySelector('circle.music-glyph--metronome__beat');
    expect(beat).not.toBeNull();
    // Top-left corner inside the existing viewBox.
    expect(beat?.getAttribute('cx')).toBe('2.4');
    expect(beat?.getAttribute('cy')).toBe('6.2');
    // The dot must NOT be a descendant of the pendulum group.
    expect(
      svg?.querySelector('.music-glyph--metronome__pendulum .music-glyph--metronome__beat'),
    ).toBeNull();
  });

  // Phase-sync invariant (sister-site to the render-html assertion
  // in `crates/render-html/src/lib.rs`): the beat blink and the
  // pendulum swing MUST both be driven by `--cs-metronome-period`,
  // and a `-period/2` animation-delay phase-shifts the flash to the
  // rod's center crossing (not its extremes). The blink lives in
  // styles.css (not inline), so assert it against the stylesheet
  // source rather than the rendered DOM. A regression that gives the
  // beat a hardcoded duration would desync the flash from the swing,
  // and one that drops the delay would move the flash back to the
  // extremes — neither would fail the DOM-level tests above.
  test('beat blink and swing share --cs-metronome-period in styles.css', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const css = readFileSync(resolve(here, '../src/styles.css'), 'utf8');
    expect(css).toContain('@keyframes cs-metronome-beat');
    expect(css).toMatch(
      /\.music-glyph--metronome__beat\s*\{\s*animation:\s*cs-metronome-beat var\(--cs-metronome-period/,
    );
    // The `-period/2` delay that puts the flash on the center crossing.
    expect(css).toMatch(
      /\.music-glyph--metronome__beat\s*\{[^}]*animation-delay:\s*calc\(var\(--cs-metronome-period, 1s\) \* -0\.5\)/,
    );
    expect(css).toMatch(
      /\.music-glyph--metronome__pendulum\s*\{[^}]*animation:\s*cs-metronome-swing var\(--cs-metronome-period/,
    );
    // Reduced-motion must disable the blink and pin a visible dot.
    expect(css).toMatch(
      /prefers-reduced-motion: reduce[\s\S]*\.music-glyph--metronome__beat\s*\{\s*animation:\s*none;\s*opacity:\s*1;/,
    );
    // Crisp on/off blink (no fade): the beat dot uses `step-end`
    // timing so every keyframe boundary is an instantaneous jump,
    // and the keyframe snaps from full opacity to 0 with no
    // interpolated dim resting state. A regression to an eased fade
    // (e.g. `ease-out` decaying to a 0.12 glow) would fail here.
    expect(css).toMatch(
      /\.music-glyph--metronome__beat\s*\{\s*animation:\s*cs-metronome-beat var\(--cs-metronome-period, 1s\) step-end infinite;/,
    );
    expect(css).toMatch(
      /@keyframes cs-metronome-beat\s*\{\s*0%\s*\{\s*opacity:\s*1;\s*\}\s*12%\s*\{\s*opacity:\s*0;\s*\}\s*100%\s*\{\s*opacity:\s*0;\s*\}\s*\}/,
    );
  });
});

describe('metronomePeriodSeconds / metronomePeriodCss', () => {
  test('one beat per second-derived period for common tempos', () => {
    expect(metronomePeriodSeconds(120)).toBeCloseTo(0.5, 6);
    expect(metronomePeriodSeconds(60)).toBeCloseTo(1, 6);
    expect(metronomePeriodCss(120)).toBe('0.500s');
    expect(metronomePeriodCss(90)).toBe('0.667s');
  });

  test('clamps absurd tempos so the animation neither strobes nor freezes', () => {
    // Fast end clamps to 0.05s; slow end clamps to 5s.
    expect(metronomePeriodSeconds(99999)).toBe(0.05);
    expect(metronomePeriodSeconds(0.001)).toBe(5);
  });

  test('falls back to 60 BPM for non-finite / non-positive input', () => {
    expect(metronomePeriodSeconds(Number.NaN)).toBeCloseTo(1, 6);
    expect(metronomePeriodSeconds(0)).toBeCloseTo(1, 6);
    expect(metronomePeriodSeconds(-120)).toBeCloseTo(1, 6);
    expect(metronomePeriodSeconds(Number.POSITIVE_INFINITY)).toBeCloseTo(1, 6);
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

  // The conductor-pattern animation was retired — the time-
  // signature glyph is now just stacked digits + a fraction
  // bar, regardless of the `bpm` prop.
  test('renders statically — no conductor class, no period — irrespective of bpm', () => {
    for (const props of [{ value: '4/4' }, { value: '4/4', bpm: 120 }, { value: '3/4', bpm: 90 }]) {
      const { container } = render(<TimeSignatureGlyph {...props} />);
      const glyph = container.querySelector('.music-glyph--time') as HTMLElement | null;
      expect(glyph).not.toBeNull();
      expect(
        Array.from(glyph?.classList ?? []).some((c) =>
          c.startsWith('music-glyph--time--conduct-'),
        ),
      ).toBe(false);
      expect(glyph?.style.getPropertyValue('--cs-time-period')).toBe('');
    }
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
