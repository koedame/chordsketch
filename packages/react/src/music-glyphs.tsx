import type { CSSProperties } from 'react';

/**
 * Music-notation glyphs (key signature, metronome, time signature)
 * used as decorative icons inside the `.meta-inline` markers the
 * AST walker emits for positional `{key}` / `{tempo}` / `{time}`
 * directives. The visual style mirrors `design-system/DESIGN.md`
 * §6.1 — no left accent borders, color contrast / typography is
 * the only signal.
 *
 * These are inline SVGs rather than a music font (Bravura) load
 * because:
 * - The React package must work in any consumer bundle without
 *   forcing a font download.
 * - The shapes are simplified caricatures of the real SMuFL
 *   glyphs (treble clef, sharp, flat, metronome) — they read as
 *   "music notation" at 24-32 px without needing the full
 *   Bravura outline detail.
 *
 * Sister-site to `crates/render-html/src/lib.rs`'s embedded
 * stylesheet, which carries the matching `.meta-glyph-*` classes
 * + inline SVG markup.
 */

// ---- Key signature math -----------------------------------------

/**
 * Order of sharps in a key signature, in their actual treble-clef
 * staff position from top → bottom (counted as half-line steps
 * from the top staff line; 0 = top line, 1 = first space, …).
 *
 * Positions are the conventional western-notation key-signature
 * layout (F# on the top line, C# in the third space, G# above the
 * top line, etc.).
 */
const SHARP_ORDER: ReadonlyArray<{ name: string; y: number }> = [
  { name: 'F', y: 0 },   // top line — F#
  { name: 'C', y: 1.5 }, // 3rd space — C#
  { name: 'G', y: -0.5 },// space above top line — G#
  { name: 'D', y: 1 },   // 2nd line — D#
  { name: 'A', y: 2.5 }, // 3rd space below — A#
  { name: 'E', y: 0.5 }, // 1st space — E#
  { name: 'B', y: 2 },   // 3rd line — B#
];

/** Same shape as {@link SHARP_ORDER} for the order-of-flats. */
const FLAT_ORDER: ReadonlyArray<{ name: string; y: number }> = [
  { name: 'B', y: 2 },   // 3rd line — Bb
  { name: 'E', y: 0.5 }, // 1st space — Eb
  { name: 'A', y: 2.5 }, // 3rd space — Ab
  { name: 'D', y: 1 },   // 2nd line — Db
  { name: 'G', y: 3 },   // 4th line — Gb
  { name: 'C', y: 1.5 }, // 2nd space — Cb
  { name: 'F', y: 3.5 }, // bottom space — Fb
];

/**
 * Map a major key name (e.g. `"G"`, `"Bb"`, `"F#"`) to its
 * key-signature size and direction. Returns `null` for an
 * unparseable input so callers can render the marker without
 * accidentals.
 *
 * Minor keys map to their relative major (`"Em"` → `"G"`,
 * `"Dm"` → `"F"`, …) so the displayed signature is the standard
 * key-signature stack, not a per-mode override.
 */
export function keySignatureFor(
  keyName: string,
): { count: number; type: 'sharp' | 'flat' | 'natural' } | null {
  const trimmed = keyName.trim();
  if (trimmed.length === 0) return null;
  // Normalise unicode flat / sharp glyphs to ASCII (chordpro itself
  // accepts both spellings) and collapse NBSP / ideographic spaces.
  const ascii = trimmed
    .replace(/♭/g, 'b')
    .replace(/♯/g, '#')
    .replace(/[ 　]/g, ' ')
    .trim();

  // Accept either the bare-major form (`G`, `Bb`, `F#`) or a minor
  // form with an optional whitespace + `m` / `min` / `minor`
  // suffix (`Em`, `E minor`, `F# min`). `/i` keeps it case-
  // insensitive so `e MIN` parses the same as `Em`.
  const m = /^([A-G])([b#]?)(?:\s*(m|min|minor))?$/i.exec(ascii);
  if (!m) return null;
  const root = m[1]!.toUpperCase();
  const accidental = m[2] ?? '';
  const isMinor = !!m[3];

  // Sharps / flats table (Wikipedia: "Key signature"). Direct
  // lookups for both major AND minor keys — minor keys map to the
  // same accidental count as their relative major, but the
  // *spelling* of the relative major depends on which side of the
  // circle of fifths the minor key sits on. Encode both tables
  // explicitly rather than transposing chromatically (which gets
  // the count right but is ambiguous about sharp-vs-flat spelling
  // for the subsequent lookup).
  const MAJOR: Record<string, [number, 'sharp' | 'flat' | 'natural']> = {
    C: [0, 'natural'],
    G: [1, 'sharp'],
    D: [2, 'sharp'],
    A: [3, 'sharp'],
    E: [4, 'sharp'],
    B: [5, 'sharp'],
    'F#': [6, 'sharp'],
    'C#': [7, 'sharp'],
    F: [1, 'flat'],
    Bb: [2, 'flat'],
    Eb: [3, 'flat'],
    Ab: [4, 'flat'],
    Db: [5, 'flat'],
    Gb: [6, 'flat'],
    Cb: [7, 'flat'],
  };
  const MINOR: Record<string, [number, 'sharp' | 'flat' | 'natural']> = {
    A: [0, 'natural'],
    E: [1, 'sharp'],
    B: [2, 'sharp'],
    'F#': [3, 'sharp'],
    'C#': [4, 'sharp'],
    'G#': [5, 'sharp'],
    'D#': [6, 'sharp'],
    'A#': [7, 'sharp'],
    D: [1, 'flat'],
    G: [2, 'flat'],
    C: [3, 'flat'],
    F: [4, 'flat'],
    Bb: [5, 'flat'],
    Eb: [6, 'flat'],
    Ab: [7, 'flat'],
  };
  const table = isMinor ? MINOR : MAJOR;
  const note = `${root}${accidental}`;
  const hit = table[note];
  if (!hit) return null;
  return { count: hit[0], type: hit[1] };
}

/**
 * Map a minor root to its relative major. Internal helper —
 * exported only for tests.
 *
 * @internal
 */
export function relativeMajor(root: string, accidental: string): string {
  // The minor-third up from a minor root yields the relative major.
  // Implement as a chromatic table for simplicity rather than
  // running a parse_chord on a sub-string we already have.
  const CHROMATIC = [
    'C',
    'C#',
    'D',
    'D#',
    'E',
    'F',
    'F#',
    'G',
    'G#',
    'A',
    'A#',
    'B',
  ];
  const FLAT_TO_SHARP: Record<string, string> = {
    Db: 'C#',
    Eb: 'D#',
    Gb: 'F#',
    Ab: 'G#',
    Bb: 'A#',
  };
  const note = `${root}${accidental}`;
  const sharp = FLAT_TO_SHARP[note] ?? note;
  const idx = CHROMATIC.indexOf(sharp);
  if (idx === -1) return note;
  const rel = CHROMATIC[(idx + 3) % 12]!;
  // Prefer flat spelling when the original key was a flat key, so
  // `Cm` returns `Eb` not `D#` (which would map to 4 flats /
  // 8 sharps oddly).
  const SHARP_TO_FLAT: Record<string, string> = {
    'C#': 'Db',
    'D#': 'Eb',
    'F#': 'Gb',
    'G#': 'Ab',
    'A#': 'Bb',
  };
  if (accidental === 'b' && SHARP_TO_FLAT[rel]) return SHARP_TO_FLAT[rel]!;
  return rel;
}

// ---- Key signature SVG glyph ------------------------------------

/**
 * A mini SMuFL-style key-signature icon: 5-line staff + treble
 * clef silhouette + sharps/flats at conventional staff positions
 * for the given key. Sized for inline use inside
 * `.meta-inline--key` (24-32 px tall by default).
 */
export function KeySignatureGlyph({
  keyName,
  className,
  style,
}: {
  keyName: string;
  className?: string;
  style?: CSSProperties;
}): JSX.Element {
  const sig = keySignatureFor(keyName);
  // SVG coordinate system: width grows with the accidental count
  // so a 7-sharp key (`C#`) doesn't clip; height fits a 5-line
  // staff with breathing room above/below.
  const accidentalCount = sig?.count ?? 0;
  const baseW = 28;
  // Each accidental advances ~5 user units to the right of the
  // clef.
  const w = baseW + accidentalCount * 5;
  const h = 24;
  const order = sig?.type === 'flat' ? FLAT_ORDER : SHARP_ORDER;
  // Top staff line at y=4, line spacing 3, so lines are at 4,7,10,13,16.
  const top = 4;
  const lineGap = 3;

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${w} ${h}`}
      width={w}
      height={h}
      className={['music-glyph', 'music-glyph--key', className].filter(Boolean).join(' ')}
      style={style}
      role="img"
      aria-label={
        sig === null
          ? `Key ${keyName}`
          : sig.type === 'natural'
            ? `Key ${keyName} (no accidentals)`
            : `Key ${keyName} (${sig.count} ${sig.type}${sig.count === 1 ? '' : 's'})`
      }
    >
      {/* 5-line staff */}
      {[0, 1, 2, 3, 4].map((i) => (
        <line
          key={`l${i}`}
          x1={1}
          x2={w - 1}
          y1={top + i * lineGap}
          y2={top + i * lineGap}
          stroke="currentColor"
          strokeWidth={0.6}
        />
      ))}
      {/* Stylised treble clef — a curl that approximately tracks the
          SMuFL gClef shape without claiming pixel accuracy. */}
      <path
        d="M9 19 C 9 21, 5.5 21, 5.5 18.5 C 5.5 16, 9 16, 9 14
           C 9 11, 4.5 9, 4.5 7 C 4.5 4, 8.5 2.5, 9.5 5
           C 10.5 8, 6 9.5, 6 13 C 6 16, 10 16, 10 13.5"
        fill="none"
        stroke="currentColor"
        strokeWidth={1}
        strokeLinecap="round"
      />
      {/* Accidentals */}
      {sig != null && sig.type !== 'natural'
        ? order.slice(0, sig.count).map((acc, i) => {
            const cx = 14 + i * 5;
            const cy = top + acc.y * lineGap;
            return sig.type === 'sharp' ? (
              <SharpGlyph key={`s${i}`} cx={cx} cy={cy} />
            ) : (
              <FlatGlyph key={`f${i}`} cx={cx} cy={cy} />
            );
          })
        : null}
    </svg>
  );
}

function SharpGlyph({ cx, cy }: { cx: number; cy: number }): JSX.Element {
  // A simplified ♯ glyph: two vertical strokes crossed by two
  // slightly upward-slanting horizontal strokes.
  const w = 2.2;
  const h = 4.4;
  return (
    <g stroke="currentColor" strokeWidth={0.55} strokeLinecap="round">
      <line x1={cx - w / 2} y1={cy - h / 2} x2={cx - w / 2} y2={cy + h / 2 + 0.4} />
      <line x1={cx + w / 2} y1={cy - h / 2 - 0.4} x2={cx + w / 2} y2={cy + h / 2} />
      <line x1={cx - w / 2 - 0.3} y1={cy - 0.8} x2={cx + w / 2 + 0.3} y2={cy - 1.4} />
      <line x1={cx - w / 2 - 0.3} y1={cy + 1.4} x2={cx + w / 2 + 0.3} y2={cy + 0.8} />
    </g>
  );
}

function FlatGlyph({ cx, cy }: { cx: number; cy: number }): JSX.Element {
  // A simplified ♭ glyph: a vertical stroke with a teardrop bulb
  // at the bottom right.
  return (
    <g fill="none" stroke="currentColor" strokeWidth={0.55} strokeLinecap="round">
      <line x1={cx - 0.8} y1={cy - 2.5} x2={cx - 0.8} y2={cy + 2.2} />
      <path
        d={`M ${cx - 0.8} ${cy + 0.4}
            C ${cx + 0.6} ${cy - 0.6}, ${cx + 1.4} ${cy + 1.4}, ${cx - 0.8} ${cy + 2.2}`}
      />
    </g>
  );
}

// ---- Time signature glyph ---------------------------------------

/**
 * A stacked numerator/denominator pair styled to read as a real
 * music-notation time signature. The two glyphs sit on the same
 * pair of imaginary staff lines (no visible staff drawn — the
 * surrounding `.meta-inline` chip already provides the visual
 * frame).
 *
 * Falls back to plain text when the input is not a recognisable
 * `<num>/<den>` form (e.g. `"C"` for common time, `"none"`,
 * blank).
 */
export function TimeSignatureGlyph({
  value,
  className,
  style,
}: {
  value: string;
  className?: string;
  style?: CSSProperties;
}): JSX.Element {
  const m = /^\s*(\d{1,3})\s*\/\s*(\d{1,3})\s*$/.exec(value);
  const numerator = m?.[1];
  const denominator = m?.[2];
  if (numerator == null || denominator == null) {
    return (
      <span
        className={['music-glyph', 'music-glyph--time', className].filter(Boolean).join(' ')}
        style={style}
      >
        {value}
      </span>
    );
  }
  return (
    <span
      className={['music-glyph', 'music-glyph--time', className].filter(Boolean).join(' ')}
      style={style}
      role="img"
      aria-label={`Time signature ${numerator} over ${denominator}`}
    >
      <span className="music-glyph--time__num" aria-hidden="true">
        {numerator}
      </span>
      <span className="music-glyph--time__den" aria-hidden="true">
        {denominator}
      </span>
    </span>
  );
}

// ---- Metronome glyph --------------------------------------------

/**
 * A mini metronome icon with a pendulum that swings at the actual
 * `bpm` rate. The animation is gated on
 * `@media (prefers-reduced-motion: reduce)` so users who opt out of
 * motion see a static icon.
 *
 * The pendulum's full left → right → left period equals
 * `2 * (60 / bpm)` seconds (two beats per period); CSS reads the
 * BPM from a custom property so the animation duration scales
 * with the directive value without runtime JS.
 */
export function MetronomeGlyph({
  bpm,
  className,
  style,
}: {
  /** Beats per minute, parsed from the `{tempo}` directive. */
  bpm: number;
  className?: string;
  style?: CSSProperties;
}): JSX.Element {
  const safeBpm = Number.isFinite(bpm) && bpm > 0 ? bpm : 60;
  // Period (seconds) for one full left→right→left swing = two
  // beats. Clamp to a sane range so a typo'd "{tempo: 99999}"
  // doesn't strobe.
  const period = Math.max(0.1, Math.min(10, (60 / safeBpm) * 2));
  const cssVars: CSSProperties = {
    ...(style ?? {}),
    // CSS custom property the keyframes consume. `as any` because
    // CSSProperties does not type custom properties.
    ['--cs-metronome-period' as string]: `${period.toFixed(3)}s`,
  };

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 18 22"
      width={18}
      height={22}
      className={['music-glyph', 'music-glyph--metronome', className].filter(Boolean).join(' ')}
      style={cssVars}
      role="img"
      aria-label={`Metronome at ${safeBpm} BPM`}
    >
      {/* Triangular body */}
      <path
        d="M 3 21 L 15 21 L 12.5 3 L 5.5 3 Z"
        fill="none"
        stroke="currentColor"
        strokeWidth={0.9}
        strokeLinejoin="round"
      />
      {/* Top tick (pivot anchor) */}
      <line
        x1={9}
        y1={3}
        x2={9}
        y2={1}
        stroke="currentColor"
        strokeWidth={0.7}
        strokeLinecap="round"
      />
      {/* Pendulum arm — origin at (9, 3), animated via CSS */}
      <g className="music-glyph--metronome__pendulum">
        <line
          x1={9}
          y1={3}
          x2={9}
          y2={17}
          stroke="currentColor"
          strokeWidth={0.9}
          strokeLinecap="round"
        />
        {/* Weight bead near the pendulum bottom */}
        <circle cx={9} cy={9} r={1.1} fill="currentColor" />
      </g>
    </svg>
  );
}
