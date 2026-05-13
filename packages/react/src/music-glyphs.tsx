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
  //
  // Layout: clef occupies x=1..12, accidentals start at x=14
  // with 4-unit spacing, plus a 3-unit tail so the staff lines
  // extend just past the last accidental. The previous 5-unit
  // spacing + 28 base width left ~19 user units of empty staff
  // on the right for a 1-sharp key — visibly wasteful — so the
  // chip strip looked horizontally bloated.
  const accidentalCount = sig?.count ?? 0;
  const accidentalStart = 14;
  const accidentalSpacing = 4;
  const tailRight = 3;
  const w =
    accidentalCount > 0
      ? Math.max(18, accidentalStart + (accidentalCount - 1) * accidentalSpacing + tailRight)
      : 18;
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
            const cx = accidentalStart + i * accidentalSpacing;
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
/**
 * Beat pattern for a conductor's wrist gesture. Maps a time-
 * signature numerator to the simple-pattern count the icon
 * should animate. Returns `null` for numerators outside the
 * 2/3/4/6 set so callers can render a static glyph.
 */
function conductorBeatsFor(numerator: number): 2 | 3 | 4 | 6 | null {
  // 6/8 is canonically conducted in 2; we model it as 6 here
  // because the icon's animation is visual flavour rather than a
  // teaching tool, and seeing six small movements per measure
  // reads more clearly than two when the user has explicitly
  // written 6 in the numerator. Same idea for 12/8 / 9/8 —
  // use the numerator directly when it's in our supported set.
  if (numerator === 2 || numerator === 3 || numerator === 4 || numerator === 6) return numerator;
  return null;
}

export function TimeSignatureGlyph({
  value,
  bpm,
  className,
  style,
}: {
  value: string;
  /**
   * Current beats-per-minute used to size the conductor's wrist
   * animation. One full conductor cycle = `numerator * (60 /
   * bpm)` seconds (the duration of one measure). `null` /
   * undefined disables the animation (the glyph renders
   * statically), which is also what `prefers-reduced-motion:
   * reduce` triggers via CSS.
   */
  bpm?: number | null;
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
  const numInt = Number.parseInt(numerator, 10);
  const beats = conductorBeatsFor(numInt);
  const safeBpm = typeof bpm === 'number' && Number.isFinite(bpm) && bpm > 0 ? bpm : null;
  // One full conductor cycle = the duration of one measure =
  // `numerator * (60 / bpm)` seconds, clamped to a sane range so
  // a typo'd `{tempo: 99999}` doesn't strobe the glyph.
  const period =
    safeBpm != null && beats != null
      ? Math.max(0.3, Math.min(30, numInt * (60 / safeBpm)))
      : null;
  // The conductor-pattern dot animation was retired per
  // playground feedback — it competed with the music-notation
  // typography of the digits without adding actionable
  // information. The glyph is now just the stacked num / bar /
  // den; `bpm` remains in the API for future positional use
  // but no animation is emitted today.
  void beats;
  void period;
  const classes = ['music-glyph', 'music-glyph--time', className].filter(Boolean).join(' ');
  return (
    <span
      className={classes}
      style={style}
      role="img"
      aria-label={`Time signature ${numerator} over ${denominator}`}
    >
      <span className="music-glyph--time__num" aria-hidden="true">
        {numerator}
      </span>
      {/* Visual fraction bar between numerator and denominator —
          real engraved time signatures don't include a bar, but
          we add one so the stacked digits read unambiguously as
          a "N over M" at the small icon size. */}
      <span className="music-glyph--time__bar" aria-hidden="true" />
      <span className="music-glyph--time__den" aria-hidden="true">
        {denominator}
      </span>
    </span>
  );
}

// ---- Attribution role icons ------------------------------------

/**
 * Tiny inline SVG icons used next to the header attribution
 * lines so the role each name plays (artist / composer /
 * lyricist / tag) is visible at a glance. Hand-coded simplified
 * shapes — at 1em they read as "mic / note / pen / tag" without
 * needing an icon font.
 */
export function RoleIcon({
  kind,
  className,
}: {
  kind: 'artist' | 'composer' | 'lyricist' | 'tag' | 'album';
  className?: string;
}): JSX.Element {
  const classes = ['role-icon', `role-icon--${kind}`, className].filter(Boolean).join(' ');
  switch (kind) {
    case 'artist':
      // Microphone — capsule head + small stand.
      return (
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 16 16"
          width={14}
          height={14}
          className={classes}
          aria-hidden="true"
        >
          <rect
            x={6}
            y={2}
            width={4}
            height={8}
            rx={2}
            fill="none"
            stroke="currentColor"
            strokeWidth={1.2}
          />
          <path
            d="M 4 8 C 4 11, 6 12, 8 12 C 10 12, 12 11, 12 8"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.2}
            strokeLinecap="round"
          />
          <line x1={8} y1={12} x2={8} y2={15} stroke="currentColor" strokeWidth={1.2} />
          <line x1={5.5} y1={15} x2={10.5} y2={15} stroke="currentColor" strokeWidth={1.2} />
        </svg>
      );
    case 'composer':
      // Eighth note (♪) — stem with a beam flag and a filled head.
      return (
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 16 16"
          width={14}
          height={14}
          className={classes}
          aria-hidden="true"
        >
          <line x1={9} y1={3} x2={9} y2={12} stroke="currentColor" strokeWidth={1.4} />
          <path
            d="M 9 3 C 11 4, 13 5, 12 8"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.4}
            strokeLinecap="round"
          />
          <ellipse cx={6.5} cy={12} rx={3} ry={2.2} fill="currentColor" />
        </svg>
      );
    case 'lyricist':
      // Pencil — long thin body (hex barrel approximation), with
      // a triangular graphite tip at the bottom-left and a small
      // metal ferrule + eraser at the top-right. Reads as
      // "pencil" rather than the earlier knife-like silhouette.
      return (
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 16 16"
          width={14}
          height={14}
          className={classes}
          aria-hidden="true"
        >
          {/* Barrel — slanted rectangle from upper-right to lower-left */}
          <path
            d="M 12 2 L 14 4 L 6 12 L 4 10 Z"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.2}
            strokeLinejoin="round"
          />
          {/* Graphite tip — small filled triangle past the barrel */}
          <path
            d="M 4 10 L 6 12 L 3 13 Z"
            fill="currentColor"
            stroke="currentColor"
            strokeWidth={1}
            strokeLinejoin="round"
          />
          {/* Ferrule / eraser band — short line across the top end */}
          <line
            x1={11}
            y1={3}
            x2={13}
            y2={5}
            stroke="currentColor"
            strokeWidth={1.4}
            strokeLinecap="round"
          />
        </svg>
      );
    case 'tag':
      // Hash / number sign — the cleanest visual cue for "tag"
      // in modern typography. Two horizontal + two vertical
      // lines, slightly slanted so it reads as a `#` glyph
      // without depending on a specific font's hash shape.
      return (
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 16 16"
          width={12}
          height={12}
          className={classes}
          aria-hidden="true"
        >
          <line
            x1={3}
            y1={6}
            x2={14}
            y2={6}
            stroke="currentColor"
            strokeWidth={1.4}
            strokeLinecap="round"
          />
          <line
            x1={2}
            y1={10}
            x2={13}
            y2={10}
            stroke="currentColor"
            strokeWidth={1.4}
            strokeLinecap="round"
          />
          <line
            x1={7}
            y1={3}
            x2={5}
            y2={13}
            stroke="currentColor"
            strokeWidth={1.4}
            strokeLinecap="round"
          />
          <line
            x1={11}
            y1={3}
            x2={9}
            y2={13}
            stroke="currentColor"
            strokeWidth={1.4}
            strokeLinecap="round"
          />
        </svg>
      );
    case 'album':
      // LP album cover — square sleeve with a disc peeking out
      // to the right (the record half-pulled from the sleeve).
      // Reads as "album release" more specifically than a bare
      // disc, which also implies "single track / recording".
      return (
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 16 16"
          width={14}
          height={14}
          className={classes}
          aria-hidden="true"
        >
          {/* Sleeve — square with slightly rounded corners */}
          <rect
            x={2}
            y={3}
            width={9}
            height={10}
            rx={0.8}
            fill="none"
            stroke="currentColor"
            strokeWidth={1.2}
          />
          {/* Disc — circle protruding from the right edge of the
              sleeve, with a small centre spindle to disambiguate
              from a generic circle. */}
          <circle
            cx={11}
            cy={8}
            r={3}
            fill="none"
            stroke="currentColor"
            strokeWidth={1.2}
          />
          <circle cx={11} cy={8} r={0.8} fill="currentColor" />
        </svg>
      );
  }
}

// ---- Tempo-marking lookup --------------------------------------

/**
 * Italian tempo-marking name for a BPM value. Boundaries follow
 * the conventional ranges (Grave < 40, Largo 40-59, Larghetto
 * 60-65, Adagio 66-75, Andante 76-107, Moderato 108-119,
 * Allegro 120-167, Vivace 168-176, Presto 177-199, Prestissimo
 * ≥ 200). Returns `null` for non-finite / non-positive input.
 *
 * Sister-site to `crates/render-html/src/music_glyphs.rs::tempo_marking_for`.
 */
export function tempoMarkingFor(bpm: number): string | null {
  if (!Number.isFinite(bpm) || bpm <= 0) return null;
  if (bpm < 40) return 'Grave';
  if (bpm < 60) return 'Largo';
  if (bpm < 66) return 'Larghetto';
  if (bpm < 76) return 'Adagio';
  if (bpm < 108) return 'Andante';
  if (bpm < 120) return 'Moderato';
  if (bpm < 168) return 'Allegro';
  if (bpm < 177) return 'Vivace';
  if (bpm < 200) return 'Presto';
  return 'Prestissimo';
}

// ---- Metronome glyph --------------------------------------------

/**
 * A mini Wittner-style metronome icon: a triangular body with an
 * inverted-pendulum rod that pivots near the BASE (like a real
 * mechanical metronome, not a hanging-pendulum clock). The rod
 * sweeps wiper-style with the weight bead near the top, ticking
 * once at each extreme = 2 ticks per full cycle = 2 beats per
 * cycle. With `animation-direction: alternate` and an
 * `animation-duration` of `60 / bpm` seconds (one half-cycle),
 * the rod arrives at the opposite extreme every `60/bpm`
 * seconds — exactly one beat at the requested BPM.
 *
 * The animation is gated on
 * `@media (prefers-reduced-motion: reduce)` so users who opt out
 * of motion see a static icon.
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
  // Half-cycle duration in seconds — the time the rod takes to
  // travel from one extreme to the other. With
  // `animation-direction: alternate` this is the
  // `animation-duration`. The full back-and-forth cycle is
  // `2 * period` seconds. Two ticks per cycle ⇒ one tick every
  // `period` seconds ⇒ exactly `bpm` ticks per minute.
  // Clamp to a sane range so a typo'd `{tempo: 99999}` doesn't
  // strobe and `{tempo: 0.001}` doesn't freeze.
  const period = Math.max(0.05, Math.min(5, 60 / safeBpm));
  const cssVars: CSSProperties = {
    ...(style ?? {}),
    // CSS custom property the keyframes consume. The cast keeps
    // CSSProperties happy (custom properties are not in its type).
    ['--cs-metronome-period' as string]: `${period.toFixed(3)}s`,
  };

  // The SVG models a mechanical (Wittner-style) metronome: the
  // rod is an INVERTED pendulum mounted on a pivot near the base
  // of the triangular body, with the weight near the top of the
  // rod. The pivot sits at (9, 19); the rod extends UPWARD
  // through the body's tip (y=5) and beyond (y=2) so the upper
  // portion of the rod and the weight bead are clearly visible
  // sweeping across the top of the icon.
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
      {/* Triangular body — narrow top, wide base. */}
      <path
        d="M 3 21 L 15 21 L 12.5 5 L 5.5 5 Z"
        fill="none"
        stroke="currentColor"
        strokeWidth={0.9}
        strokeLinejoin="round"
      />
      {/* Static pivot dot at the base of the rod. */}
      <circle cx={9} cy={19} r={0.7} fill="currentColor" />
      {/* Inverted-pendulum rod — `transform-origin: 9px 19px`
          is set in the stylesheet so the rotation pivots at the
          base. */}
      <g className="music-glyph--metronome__pendulum">
        <line
          x1={9}
          y1={19}
          x2={9}
          y2={2}
          stroke="currentColor"
          strokeWidth={0.9}
          strokeLinecap="round"
        />
        {/* Weight bead near the TOP of the rod (a real
            metronome's adjustable slider). */}
        <circle cx={9} cy={6} r={1.1} fill="currentColor" />
      </g>
    </svg>
  );
}
