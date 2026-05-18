/// <reference types="vite/client" />
import React, { Fragment, useMemo, type JSX } from 'react';

import { chordTypography as wasmChordTypography } from '@chordsketch/wasm';

import './chart.css';

// ---------------------------------------------------------------
// Library bridge: chord glyph translation lives in
// `chordsketch-render-ireal::chord_typography`. We call it via
// `chordTypography` so the chart stays a thin sample of the
// libraries — see `.claude/rules/playground-is-a-sample.md`.
// ---------------------------------------------------------------

interface WasmTypographySpan {
  kind: 'Root' | 'Accidental' | 'Extension' | 'Slash' | 'Bass';
  text: string;
}

function libraryTypography(chord: Chord): WasmTypographySpan[] {
  // The library function takes the canonical AST shape (root /
  // quality / bass) — strip the playground-only `alternate` field
  // before calling. Returns the engraved-glyph spans the chart
  // should paint.
  const chordJson = JSON.stringify({
    root: chord.root,
    quality: chord.quality,
    bass: chord.bass,
  });
  try {
    const json = wasmChordTypography(chordJson);
    const parsed = JSON.parse(json) as { spans: WasmTypographySpan[] };
    return parsed.spans;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------
// AST shape — extends the iReal Pro parser output with optional
// "rich" fields so the chart can reproduce
// `design-system/ui_kits/web/editor-irealb.html` 1:1. Fields not
// emitted by `parseIrealb` are all optional, so a pure
// `parseIrealb` result still satisfies this shape.
// ---------------------------------------------------------------

export type Accidental = 'natural' | 'sharp' | 'flat';
export type KeyMode = 'major' | 'minor';

export interface PitchClass {
  note: 'C' | 'D' | 'E' | 'F' | 'G' | 'A' | 'B';
  accidental: Accidental;
}

export interface KeySignature {
  root: PitchClass;
  mode: KeyMode;
}

export interface TimeSignature {
  numerator: number;
  denominator: number;
}

export type BarlineKind =
  | 'single'
  | 'double'
  | 'final'
  | 'open_repeat'
  | 'close_repeat';

export interface Chord {
  root: PitchClass;
  /** Quality identifier. The parser emits one of the named iReal
   * Pro quality kinds (`major`, `minor7`, `half_diminished`, …) or
   * `{ kind: 'custom', value: '<verbatim text>' }` for tensions
   * the structured enum can't model (`Δ7♯11`, `7♭9`, etc.). */
  quality: { kind: string; value?: string };
  bass: PitchClass | null;
  /** Optional alternate chord rendered ABOVE the primary chord at
   * a smaller size. Mirrors the `chord-stack > .alt` pattern in
   * editor-irealb.html. The wasm AST nests a full `Chord` here so
   * the alternate inherits the same root / quality / bass / nested
   * alternate semantics as the primary. */
  alternate?: Chord | null;
}

/** Per-chord display size, mirroring the Rust AST's `ChordSize`
 * enum. iReal Pro's `s` / `l` markers toggle Small / Default
 * across the chord stream; the wasm AST stamps the active size
 * onto every emitted `BarChord`. Optional + lower-case strings
 * because the JSON layer omits the field when default. */
export type ChordSize = 'default' | 'small';

/** Per-chord paint kind, mirroring the Rust AST's `BarChordKind`
 * enum (#2435). `'played'` (default, omitted by the JSON layer)
 * paints chord typography; `'slash_repeat'` paints a single `/`
 * glyph in place of chord text — the iReal Pro pause-slash
 * meaning "repeat the preceding chord". The `chord` field on a
 * SlashRepeat carries a snapshot of the preceding chord so
 * consumers introspecting harmony see the right value. */
export type BarChordKind = 'played' | 'slash_repeat';

export interface BarChord {
  chord: Chord;
  position: { beat: number; subdivision: number };
  /** Per-chord display size. Omitted by the JSON encoder when
   * `'default'`; consumers should treat absent === default. */
  size?: ChordSize;
  /** Per-chord paint kind. Omitted by the JSON encoder when
   * `'played'`; consumers should treat absent === played. */
  kind?: BarChordKind;
}

export interface SectionLabel {
  kind: 'letter' | 'named' | 'none';
  value?: string;
}

export interface Bar {
  start: BarlineKind | string;
  end: BarlineKind | string;
  chords: BarChord[];
  /** N-th ending bracket attached to this bar.
   * - `null` / `undefined`: no bracket.
   * - `0`: spec's `N0` "no text Ending" — bracket painted without a
   *   digit label (sentinel matching the wasm AST's
   *   `Ending::Untitled`).
   * - `1..=255`: numbered bracket, the digit is painted as the
   *   label. The wasm AST's `Ending::Numbered` is a `NonZeroU8`
   *   so the full `1..=255` range is type-allowed, but the iReal
   *   parser only ever emits `1..=9` (single-digit `N`-prefix
   *   tokens). Values above 9 are reachable only via hand-built
   *   JSON. */
  ending: number | null;
  symbol: string | null;
  // ---- Rich extensions (all optional) ----
  /** Highlights this bar with the active-bar pink fill +
   * crimson outline (editor-irealb.html `.bar.active`). */
  active?: boolean;
  /** Fermata (Bravura `fermataAbove` U+E4C0) above the chord on
   * this bar. */
  fermata?: boolean;
  /** Coda glyph (Bravura U+E048) above the chord on the given
   * beat (or beat 1 if omitted). */
  coda?: { beat?: number };
  /** Italic serif text mark below the bar (e.g. `rit.`,
   * `D.C. al Coda`, `free time`). */
  textMark?: string;
  /** Bold sans-serif text mark below the right barline (e.g.
   * `END`). */
  endMark?: string;
  /** "No-chord" bar — renders the literal `N.C.` glyph in the
   * chord typeface. */
  noChord?: boolean;
  /** Invisible-root chord (held; only the bass moves). Renders a
   * horizontal divider with the bass note below. */
  invisibleRoot?: { bass: PitchClass };
  /** SMuFL repeat-1-bar (U+E500) or repeat-2-bars (U+E501) glyph
   * occupying the bar. */
  repeatBars?: 1 | 2;
}

export interface Section {
  label: SectionLabel;
  bars: Bar[];
  /** Optional vertical spacer in `--sp-N` multiples that the
   * renderer inserts before this section (not the chart-line) — used
   * to push the showcase line in editor-irealb.html. Mainly a hand-
   * authored-AST escape hatch. */
  spacerBefore?: number;
  /** "Coda destination" marker — adds the `coda-line` class on the
   * first chart-line of this section so the inter-section gap is
   * widened (editor-irealb.html convention for the post-D.C. coda
   * destination). */
  codaDestination?: boolean;
}

export interface IrealSong {
  title: string;
  composer: string;
  style: string;
  key_signature: KeySignature;
  time_signature: TimeSignature;
  tempo: number;
  transpose: number;
  sections: Section[];
}

// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------

const BARS_PER_LINE = 4;

function accidentalGlyph(acc: Accidental): string | null {
  if (acc === 'sharp') return '\u{266F}';
  if (acc === 'flat') return '\u{266D}';
  return null;
}

/**
 * Render the quality glyph string with Bravura accidentals. Each
 * `♯` / `♭` is wrapped in a `<span class="smufl">`; everything else
 * runs in the chord text font. Used for both flat qualities
 * ("7♭9", "Δ7♯11") and the stacked quality variants below.
 */
function renderQualityRun(text: string): JSX.Element[] {
  const parts: JSX.Element[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '\u{266F}' || ch === '\u{266D}') {
      parts.push(
        <span key={i} className="smufl">
          {ch}
        </span>,
      );
    } else {
      parts.push(<Fragment key={i}>{ch}</Fragment>);
    }
  }
  return parts;
}

// Quality / accidental glyph translation has moved to the
// library — see `chordsketch-render-ireal::chord_typography` and
// the wasm export `chordTypography`. Per
// `.claude/rules/playground-is-a-sample.md`, this file no longer
// owns translation logic; it only renders the spans the library
// produces.

interface ChordSegmentProps {
  chord: Chord;
  beat?: number;
}

/**
 * Convert the library's typography spans into the engraved-chart
 * HTML structure. Spans are partitioned into "top" (root + acc +
 * extension) and "bot" (bass + bass-acc) for slash chords.
 */
function spansToHtml(
  spans: WasmTypographySpan[],
  isSlash: boolean,
): { top: JSX.Element[]; bot: JSX.Element[] } {
  const top: JSX.Element[] = [];
  const bot: JSX.Element[] = [];
  let inBass = false;
  let key = 0;
  for (const span of spans) {
    switch (span.kind) {
      case 'Root':
        top.push(
          <span key={key++} className="chord-root">
            {span.text}
          </span>,
        );
        break;
      case 'Accidental': {
        // A `♭` / `♯` glyph following a Root is the root's accidental;
        // following a Bass it's the bass's accidental. We track this
        // via `inBass` so each lands in the correct partition.
        const target = inBass ? bot : top;
        target.push(
          <span key={key++} className={inBass ? 'smufl' : 'chord-acc'}>
            {span.text}
          </span>,
        );
        break;
      }
      case 'Extension':
        // The library may emit a stacked-quality marker (`|`) that
        // splits the extension across two lines (e.g. `7♭9|♯5`).
        if (span.text.includes('|')) {
          top.push(
            <span key={key++} className="chord-qual stacked">
              {span.text.split('|').map((line, i) => (
                <span key={i}>{renderQualityRun(line)}</span>
              ))}
            </span>,
          );
        } else {
          top.push(
            <span key={key++} className="chord-qual">
              {renderQualityRun(span.text)}
            </span>,
          );
        }
        break;
      case 'Slash':
        // The slash separator is implicit in the .chord.slash
        // structure; skip it. Only the `top` ends here.
        inBass = true;
        break;
      case 'Bass':
        bot.push(<Fragment key={key++}>{span.text}</Fragment>);
        break;
    }
  }
  // Non-slash chord: collapse `bot` into `top` (no spans should
  // have landed in `bot` without a Slash marker, but stay defensive).
  if (!isSlash && bot.length > 0) {
    top.push(...bot.splice(0, bot.length));
  }
  return { top, bot };
}

/**
 * Render a single chord (root + accidental + quality + optional
 * slash/bass + optional alternate stack).
 */
function ChordSegment({ chord, beat }: ChordSegmentProps): JSX.Element {
  const dataBeat = beat && beat > 1 ? String(beat) : undefined;
  const spans = useMemo(() => libraryTypography(chord), [chord]);
  const isSlash = chord.bass !== null;
  const { top, bot } = spansToHtml(spans, isSlash);

  // Slash chord — `<span class="chord slash"><span class="top">…</span><span class="bot">…</span></span>`
  const body = isSlash ? (
    <span className="chord slash">
      <span className="top">{top}</span>
      <span className="bot">{bot}</span>
    </span>
  ) : (
    <span className="chord">{top}</span>
  );

  // Alternate chord stack — smaller chord rendered ABOVE the primary
  // chord at the same beat position. The wasm AST nests a full
  // `Chord` for the alternate, so build its typography spans the
  // same way as the primary and emit them under the `.alt`
  // wrapper (the CSS shrinks the font-size and dims the colour).
  if (chord.alternate) {
    const alt = chord.alternate;
    const altSpans = libraryTypography(alt);
    const altIsSlash = alt.bass !== null;
    const { top: altTop, bot: altBot } = spansToHtml(altSpans, altIsSlash);
    return (
      <span className="chord-stack" data-beat={dataBeat}>
        <span className="alt">
          {altIsSlash ? (
            <span className="chord slash">
              <span className="top">{altTop}</span>
              <span className="bot">{altBot}</span>
            </span>
          ) : (
            <span className="chord">{altTop}</span>
          )}
        </span>
        {body}
      </span>
    );
  }

  // Otherwise, attach `data-beat` to the chord element itself.
  if (chord.bass) {
    return React.cloneElement(body, { 'data-beat': dataBeat });
  }
  return React.cloneElement(body, { 'data-beat': dataBeat });
}

interface ChartLine {
  /** Section index of the first bar in this line. */
  sectionIndex: number;
  /** Whether this line is a coda destination (gets `.coda-line`). */
  isCodaLine: boolean;
  /** Bar entries in this line. */
  bars: Array<{
    bar: Bar;
    sectionIndex: number;
    barIndexInSection: number;
    isFirstOfSection: boolean;
  }>;
}

function buildChartLines(song: IrealSong): ChartLine[] {
  // iReal Pro lays out bars at exactly 4 per row and lets section
  // boundaries fall mid-row — a section's first bar simply gets the
  // section label above it, the row is otherwise unaware of section
  // breaks. Force-wrapping at every section change (the older
  // behaviour) leaves partial rows that don't match the printed
  // app's output and stretches a 25-bar chart to many more rows
  // than necessary.
  const lines: ChartLine[] = [];
  let line: ChartLine | null = null;
  for (let s = 0; s < song.sections.length; s++) {
    const section = song.sections[s]!;
    for (let b = 0; b < section.bars.length; b++) {
      if (!line || line.bars.length >= BARS_PER_LINE) {
        line = {
          sectionIndex: s,
          isCodaLine: !!section.codaDestination && b === 0,
          bars: [],
        };
        lines.push(line);
      }
      line.bars.push({
        bar: section.bars[b]!,
        sectionIndex: s,
        barIndexInSection: b,
        isFirstOfSection: b === 0,
      });
    }
  }
  return lines;
}

function sectionLabelText(label: SectionLabel): string | null {
  if (label.kind === 'none') return null;
  return label.value ?? null;
}

/** Barline glyph kind painted by `[data-barline-left|right]` CSS
 * selectors. `single` (the default) is encoded by attribute absence
 * so the CSS only needs three explicit values. Mirrors the
 * static design-system reference at
 * `design-system/ui_kits/web/editor-irealb.html`. */
type BarlineSide = 'double' | 'repeat' | 'end';

function barlineSide(kind: Bar['start'] | Bar['end'], side: 'start' | 'end'): BarlineSide | null {
  switch (kind) {
    case 'double':
      return 'double';
    case 'open_repeat':
      return side === 'start' ? 'repeat' : null;
    case 'close_repeat':
      return side === 'end' ? 'repeat' : null;
    case 'final':
      return side === 'end' ? 'end' : null;
    default:
      return null;
  }
}

interface BarVisualState {
  classes: string[];
  barlineLeft: BarlineSide | null;
  barlineRight: BarlineSide | null;
}

function barVisualState(bar: Bar): BarVisualState {
  const classes: string[] = [];
  if (bar.endMark) classes.push('last-bar');
  if (bar.active) classes.push('active');
  if (bar.ending !== null && bar.ending !== undefined) {
    // `0` is the Untitled sentinel — emit a distinct class so CSS
    // hooks can target it explicitly and don't read it as a
    // numbered bracket.
    classes.push('ending');
    classes.push(bar.ending === 0 ? 'ending-untitled' : `ending-${bar.ending}`);
  }
  return {
    classes,
    barlineLeft: barlineSide(bar.start, 'start'),
    barlineRight: barlineSide(bar.end, 'end'),
  };
}

interface BarCellProps {
  bar: Bar;
  isFirstOfSection: boolean;
  sectionLabel: SectionLabel | null;
  beats: number;
}

function BarCell({
  bar,
  isFirstOfSection,
  sectionLabel,
  beats,
}: BarCellProps): JSX.Element {
  const visual = barVisualState(bar);
  const classes = ['bar', ...visual.classes];
  const sectionMarker =
    isFirstOfSection && sectionLabel ? sectionLabelText(sectionLabel) : null;

  // Distribute chords across the bar's beat grid.
  const positions = bar.chords.map((bc) => bc.position.beat);
  const uniquePositions = new Set(positions);
  const useBeatPositioning =
    uniquePositions.size === bar.chords.length && bar.chords.length <= beats;

  // Special bar-content variants render their own glyph instead
  // of chord text — N.C., invisible-root, repeat-1-bar,
  // repeat-2-bars.
  const renderSpecialContent = () => {
    if (bar.noChord) {
      return <span className="chord nc">N.C.</span>;
    }
    if (bar.invisibleRoot) {
      const bassAcc = accidentalGlyph(bar.invisibleRoot.bass.accidental);
      return (
        <span className="chord invisible-root">
          <span className="root-oval" aria-hidden="true" />
          <span className="bass">
            {bar.invisibleRoot.bass.note}
            {bassAcc && <span className="smufl">{bassAcc}</span>}
          </span>
        </span>
      );
    }
    if (bar.repeatBars === 1) {
      return <span className="repeat-bar smufl">{'\u{E500}'}</span>;
    }
    if (bar.repeatBars === 2) {
      return <span className="repeat-bar smufl">{'\u{E501}'}</span>;
    }
    return null;
  };
  const special = renderSpecialContent();

  return (
    <div
      className={classes.join(' ')}
      data-barline-left={visual.barlineLeft ?? undefined}
      data-barline-right={visual.barlineRight ?? undefined}
      style={{ ['--cs-beats' as string]: String(beats) }}
    >
      {sectionMarker !== null && (
        <span className="section-marker">{sectionMarker}</span>
      )}
      {bar.ending !== null && bar.ending !== undefined && (
        // Untitled (spec `N0`, sentinel `0`) renders the bracket
        // without a digit label, matching the SVG renderer's
        // `ending.number() == None` branch.
        <span className="ending-bracket">
          {bar.ending === 0 ? null : `${bar.ending}.`}
        </span>
      )}
      {bar.fermata && (
        <span className="fermata" aria-label="Fermata">
          {'\u{E4C0}'}
        </span>
      )}
      {bar.coda && (
        <span
          className="glyph-mark"
          aria-label="Coda"
          data-beat={bar.coda.beat && bar.coda.beat > 1 ? String(bar.coda.beat) : undefined}
        >
          {'\u{E048}'}
        </span>
      )}
      {/* Canonical `bar.symbol` from the wasm parser. The rich-extension
          fields above (`fermata`, `coda`, `textMark`) take precedence so
          hand-built ASTs keep their explicit overrides; the canonical
          path is the fallback for parser-derived ASTs that don't go
          through a `tryParse` rich-field translation step. */}
      {!bar.coda && bar.symbol === 'coda' && (
        <span className="glyph-mark" aria-label="Coda">
          {'\u{E048}'}
        </span>
      )}
      {bar.symbol === 'segno' && (
        <span className="glyph-mark" aria-label="Segno">
          {'\u{E047}'}
        </span>
      )}
      {!bar.fermata && bar.symbol === 'fermata' && (
        <span className="fermata" aria-label="Fermata">
          {'\u{E4C0}'}
        </span>
      )}
      {special !== null
        ? special
        : bar.chords.length === 0
          ? <span className="chord" data-beat="1" />
          : bar.chords.map((bc, i) => {
              const beat = useBeatPositioning
                ? bc.position.beat
                : Math.min(beats, Math.floor((i * beats) / bar.chords.length) + 1);
              // Pause-slash repeats (#2435) paint a single `/`
              // glyph in place of chord typography. The
              // `BarChord.chord` field carries a snapshot of the
              // preceding chord — consumers introspecting the AST
              // still see the held harmony — but the renderer
              // mirrors the SVG renderer's `class="chord
              // slash-repeat"` output so the visual matches.
              if (bc.kind === 'slash_repeat') {
                const dataBeat = beat > 1 ? String(beat) : undefined;
                return (
                  <span key={i} className="chord slash-repeat" data-beat={dataBeat}>/</span>
                );
              }
              return <ChordSegment key={i} chord={bc.chord} beat={beat} />;
            })}
      {bar.textMark && <span className="text-mark">{bar.textMark}</span>}
      {/* Canonical `bar.symbol` for italic text directives (D.C. / D.S.
          / Fine). Skipped when an explicit `textMark` already covers
          the slot. */}
      {!bar.textMark && (bar.symbol === 'da_capo' || bar.symbol === 'dal_segno' || bar.symbol === 'fine') && (
        <span className="text-mark">
          {bar.symbol === 'da_capo' ? 'D.C.' : bar.symbol === 'dal_segno' ? 'D.S.' : 'Fine'}
        </span>
      )}
      {bar.endMark && <span className="end-mark">{bar.endMark}</span>}
    </div>
  );
}

// ---------------------------------------------------------------
// IrealChart
// ---------------------------------------------------------------

export interface IrealChartProps {
  song: IrealSong;
  /** Whether to render the dense `Compact` chord-width mode (chord
   * glyphs scaled to 72 % horizontal). Mirrors the iReal Pro N/S
   * toggle. Defaults to `false`. */
  compact?: boolean;
}

export function IrealChart({ song, compact }: IrealChartProps): JSX.Element {
  const beats = song.time_signature.numerator || 4;
  const lines = buildChartLines(song);
  const style = song.style || 'Medium Swing';

  return (
    <section className={`chart${compact ? ' compact' : ''}`}>
      <header className="chart-header">
        <span className="style">({style})</span>
        <span className="title">{song.title || 'Untitled'}</span>
        <span className="composer">{song.composer || ''}</span>
      </header>
      <div className="chart-body">
        {lines.map((line, lineIdx) => (
          <div
            className={`chart-line${line.isCodaLine ? ' coda-line' : ''}`}
            key={lineIdx}
          >
            {lineIdx === 0 && (
              <span className="time-sig">
                <span>{song.time_signature.numerator}</span>
                <span>{song.time_signature.denominator}</span>
              </span>
            )}
            {line.bars.map((entry, i) => (
              <BarCell
                key={i}
                bar={entry.bar}
                isFirstOfSection={entry.isFirstOfSection}
                sectionLabel={
                  song.sections[entry.sectionIndex]?.label ?? null
                }
                beats={beats}
              />
            ))}
          </div>
        ))}
      </div>
    </section>
  );
}
