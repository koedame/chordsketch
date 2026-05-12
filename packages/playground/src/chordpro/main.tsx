/// <reference types="vite/client" />
import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

// React Grab — point at any UI element and press ⌘C / Ctrl-C to
// copy the source-file location + React component name + HTML
// snippet to the clipboard, ready to paste into a coding agent.
// Local dev only; `import.meta.env.DEV` is the Vite-recommended
// gate per https://github.com/aidenybai/react-grab so the script
// is dropped from the production bundle.
if (import.meta.env.DEV) {
  void import('react-grab');
}

import init, { validate, version as wasmVersion } from '@chordsketch/wasm';
import { SAMPLE_CHORDPRO } from '@chordsketch/ui-web';
import {
  PdfExport,
  RendererPreview,
  SourceEditor,
  type SourceEditorHandle,
} from '@chordsketch/react';
import '@chordsketch/react/styles.css';

import '../playground.css';

// ---------------------------------------------------------------
// WASM bootstrap.
// ---------------------------------------------------------------
//
// `init()` must resolve before any wasm-backed function is called.
// `<RendererPreview>` and `<SourceEditor>` from `@chordsketch/react`
// either don't depend on wasm (the editor is pure CodeMirror) or
// gate their first render on the same module's lazy loader, so the
// playground only needs to kick off `init()` once at module load
// to warm the path.

const wasmReady: Promise<unknown> = init();

// Snapshot the wasm version once init resolves so the status bar
// can show it without firing a fresh import on every render.
let cachedVersion: string | null = null;
void wasmReady.then(() => {
  try {
    cachedVersion = wasmVersion();
  } catch {
    cachedVersion = null;
  }
});

// ---------------------------------------------------------------
// Sample songs — quick-load presets the user can pick from to
// exercise different features (Latin-only, multi-byte unicode,
// section-heavy, edge cases).
// ---------------------------------------------------------------

interface Sample {
  id: string;
  label: string;
  source: string;
}

// Exhaustive directive showcase — exercises every directive
// `chordsketch-chordpro` parses today, ordered so each position-
// dependent block precedes the content it actually affects.
// Inline `#` comments in the source double as cardinality /
// scope notes for every directive (see legend at the top of
// `KITCHEN_SINK_SOURCE`).
//
// Spec deviation tracker (see end-of-tour note in the sample):
//  - {key} / {tempo} are spec-wise position-dependent ("each
//    specification applies from where it was specified"). Today
//    `chordsketch-chordpro` stores last-wins in Metadata and the
//    renderers drop mid-song re-declarations, so a mid-song
//    `{key: Am}` only changes the header.
//  - {start_of_grid} bodies render verbatim in monospace today.
//    Spec defines bar / repeat / volta / strum tokens (|, ||,
//    |. |: :| :|: |1 :|2, %, %%, S<...>, ., ~, /) that this
//    renderer does not yet structure.
const KITCHEN_SINK_SOURCE = `# ChordSketch — All Directives Tour
#
# Every directive ChordSketch currently parses. Each category header
# below states the cardinality + scope of the directives in that
# group; outliers get an extra one-line note above them.
#
# Legend (source: https://www.chordpro.org/chordpro/chordpro-directives/):
#   [1x]  at most one effective value per song (multiple = last wins)
#   [Nx]  multiple values accumulate
#   [Glb] position-independent — collected into song-level metadata
#   [Pos] position-dependent — applies forward until reset / end
#
# Source-level '#' comments (this kind) are only recognised when
# '#' is the FIRST character on a line — mid-line '#' is literal.

# === Metadata, once-per-song [1x] [Glb] ==========================
{title: All Directives Tour}
{album: Reference Sheet}
{year: 2026}
{capo: 2}
{duration: 3:30}
{copyright: © 2026 Koedame}

# === Metadata, accumulating [Nx] [Glb] ===========================
{subtitle: A guided tour of every ChordPro directive}
{subtitle: Second subtitle (multiple allowed)}
{artist: ChordSketch Demo}
{composer: J. Composer}
{lyricist: J. Lyricist}
{tag: demo}
{tag: reference}
# {meta: K V} is a generic [Nx] key/value pair.
{meta: arranger Jane Arranger}

# === Metadata, spec [Nx] [Pos] / ChordSketch [Glb] last-wins =====
# Per spec, {key}/{tempo}/{time} apply forward from where placed.
# ChordSketch stores them in song-level Metadata today, so mid-song
# re-declarations only change the header strip — they don't re-
# transpose or re-flow downstream chords. See note at end of file.
{key: G}
{time: 4/4}
{tempo: 120}

# === Config override [Nx] [Glb] ==================================
# {+config.<path>: value} overrides a Config preset key inline.
# Applied at song level regardless of where placed.
{+config.settings.titles: left}

# === Custom chord definition [Nx] [Pos] ==========================
# {define}: introduces a chord (becomes available from this point).
# {chord}: references a chord for the diagram grid below.
{define: Gsus4 base-fret 1 frets 3 3 0 0 1 3}
{chord: Gsus4}

# === Diagrams toggle [Nx] [Pos] ==================================
# Per ChordPro spec the chord-diagrams grid is ON by default
# (https://www.chordpro.org/chordpro/directives-diagrams/).
# Suppressed here so the auto-injected grid does not crowd the
# preview pane; flip to {diagrams: on} (or delete this line) to
# see the grid restored. {no_diagrams} is an equivalent alias.
{diagrams: off}

# === Font / size / colour overrides [Nx] [Pos] ===================
# Placed BEFORE the rendered content so the overrides actually take
# effect on the verses / chorus / labels below.
# Targets:  text* | chord* | title* | chorus* | label*
#           tab*  | grid*  | toc*   | footer* | header*
#    (* = font / size / colour — three suffixes per target.)
{titlecolour: #BD1642}
{titlesize: 26}
{titlefont: sans-serif}
{chordcolour: #BD1642}
{chordsize: 14}
{chordfont: monospace}
{labelcolour: #BD1642}
{labelsize: 12}
{labelfont: sans-serif}
{textcolour: #1a1a1a}
{textsize: 16}
{textfont: serif}
{choruscolour: #1a1a1a}
{chorussize: 15}
{chorusfont: serif}
# Tab / grid / toc / footer / header families take the same tri-
# suffix shape — included so each parser arm is exercised.
{tabcolour: #1a1a1a}
{tabsize: 12}
{tabfont: monospace}
{gridcolour: #1a1a1a}
{gridsize: 12}
{gridfont: monospace}
{toccolour: #1a1a1a}
{tocsize: 11}
{tocfont: sans-serif}
{footercolour: #777777}
{footersize: 9}
{footerfont: sans-serif}
{headercolour: #777777}
{headersize: 9}
{headerfont: sans-serif}

# === Comments [Nx] [Pos] =========================================
# Four rendered comment flavours per ChordPro spec
# (https://www.chordpro.org/chordpro/directives-comment/):
#   {comment} / {c}          — normal (italic by default styling)
#   {comment_italic} / {ci}  — explicit italic alias
#   {comment_box} / {cb}     — boxed variant
#   {highlight}              — stronger visual emphasis (yellow
#                              background / bold weight)
{comment: Plain comment — italic note above the next line}
{comment_italic: Italic comment variant}
{comment_box: Boxed comment for emphasis}
{highlight: Highlighted comment — strongest emphasis}

# === Sections [Nx] [Pos] =========================================
# start_of_X / end_of_X pairs delimit a named block. The optional
# value after ':' is the label rendered above the block.
{start_of_verse: Verse 1}
[G]This is a [C/G]verse line, [D]chord [Em]over [C]each [G]word.
[Gsus4]Custom-defined chord above [G]resolves home.
{end_of_verse}

{start_of_chorus: Chorus}
[C]Sing the [G]chorus, [D]every-[Em]one to-[C]gether [G]now.
{end_of_chorus}

{start_of_bridge: Bridge}
[Am]A bridge takes you [F]somewhere [C]new before the [G]return.
{end_of_bridge}

# === Transpose [Nx] [Pos] ========================================
# Shifts EVERY subsequent chord by N semitones until the next
# {transpose}. Verse 2 below should render +2 (G->A, C->D, D->E).
{transpose: 2}

{start_of_verse: Verse 2 (transposed +2)}
[G]Second verse, [C]different words, [D]same chord [G]shape.
{end_of_verse}

# Reset before the body-less {chorus} so the recall renders un-
# transposed (it would otherwise inherit the +2 shift above).
{transpose: 0}

# === Chorus recall (body-less {chorus}) [Nx] [Pos] ===============
# Replays the body of the most-recently-defined chorus.
{chorus}

# === Tab (verbatim monospace block) [Nx] [Pos] ===================
{start_of_tab: Solo}
e|---0---2---3---2---0--------|
B|---0---0---0---0---0--------|
G|---0---0---0---0---0--------|
D|---2---2---0---2---2--------|
A|---3-----------3---3--------|
E|----------------------------|
{end_of_tab}

# === Grid (chord-grid block) [Nx] [Pos] ==========================
# Per spec (https://www.chordpro.org/chordpro/directives-env_grid/)
# a grid is a rectangular jazz-style chart — chords only, no
# lyrics. The body holds space-separated tokens; everything before
# the first bar line on a row goes to the left margin, everything
# after the last bar line goes to the right margin.
#
# Header forms:
#   {start_of_grid}                       -- inherit prev shape, default 1+4x4+1
#   {start_of_grid shape="cells"}         -- e.g. shape="16"
#   {start_of_grid shape="measures x beats"}  -- e.g. shape="4x4"
#   {start_of_grid shape="left+cells+right"}  -- margin cells, e.g. "1+4x4+1"
#   {start_of_grid label="Intro"}         -- left-margin label
#   {start_of_grid: <text>}               -- legacy: parsed as shape; the
#                                            Perl reference falls back to
#                                            using <text> as the label when
#                                            it does not match the shape
#                                            regex. ChordSketch follows the
#                                            same fallback below.
#
# Bar line tokens:
#   |    single bar       ||  double bar       |.  end / final bar
#   |:   start repeat     :|  stop repeat      :|:  stop+start repeat
#   |1 :|2 :|2>           volta (1st / 2nd ending; colon optional;
#                         the > aligns the volta under the previous
#                         line's volta)
# Cell tokens:
#   <chord>  chord in this cell      .   empty cell placeholder
#   /        must-be-played here     ~   multi-chord cell separator
#   %        repeat previous measure (rest of measure must be blank)
#   %%       repeat previous two measures
# Strums (jazz-strum notation):
#   row beginning with capital S after the first bar symbol switches
#   to strum mode; pseudo-chords u/d/u+/d+/ux/dx/ua/da/us/ds (plus
#   'x' for muted) draw arrow glyphs instead of chord names.
#
# Implementation note: ChordSketch currently renders the grid body
# verbatim in monospace — none of the bar / repeat / volta / strum
# tokens are structurally parsed yet, so what you write below is
# what you see. The example follows the conventional jazz idiom
# "play four bars, on first pass take the 1st ending and repeat;
# on second pass take the 2nd ending to close".
{start_of_grid: Outro Riff (with repeats + ending)}
|: G  .  .  . | C  .  .  . | D  .  .  . | G  .  .  . |
|1 Em .  .  . | C  .  .  . :| |2 Am .  .  . | G  .  .  . |.
{end_of_grid}

# === Custom section [Nx] [Pos] ===================================
# {start_of_X} with any name → generic environment (section-X).
{start_of_intro: Intro}
[G]Pick [Em]each [C]string [D]gently.
{end_of_intro}

# === Page / layout control =======================================
# Affect paged output (most visible in PDF; in HTML, {columns}
# maps to CSS column-count, breaks become spacer elements).
# {columns}: [1x] [Pos]  — sets multi-column flow.
{columns: 2}

{start_of_verse: Column A}
[G]Left column [C]content before [D]the column [G]break.
{end_of_verse}

# {column_break}, {new_page}, {new_physical_page}: [Nx] [Pos]
# (positioned breaks; no value).
{column_break}

{start_of_verse: Column B}
[G]Right column [C]content after [D]the column [G]break.
{end_of_verse}

{new_page}

# === Image [Nx] [Pos] ============================================
# Rendered inline at this location in document flow.
{image: src="https://raw.githubusercontent.com/koedame/chordsketch/main/assets/logo-128.png" width=64 height=64 title="ChordSketch logo"}

{new_physical_page}

# === Legacy: {pagetype} ==========================================
# Page-size directive accepts 'a4' or 'letter'. The official
# ChordPro reference implementation flags this as "Not
# implemented — use the configuration files instead" — ChordSketch
# follows the same policy: parsed for round-trip fidelity but
# every renderer treats it as a no-op.
{pagetype: a4}

# === End of tour =================================================
# Where ChordSketch deviates from spec today:
#  * {key} / {tempo} / {time} are stored last-wins in Metadata.
#    Mid-song re-declarations do not retrigger transpose or
#    re-render the header strip past the first value.
#  * {start_of_grid} body is verbatim text; bar / repeat / volta
#    tokens listed above are not yet parsed into a structured grid.
`;

// `{diagrams: off}` line every non-empty sample is prefixed with.
// Per the ChordPro spec the directive defaults to on
// (https://www.chordpro.org/chordpro/directives-diagrams/):
//   "Diagrams printing is enabled by default, and diagrams are
//    printed on the bottom of the first page."
// Setting it explicitly off at the top of each sample keeps the
// playground preview free of the auto-injected chord-diagrams
// grid by default. Individual users who want to see the grid can
// delete this line in the editor — the React surface respects
// the directive position-by-position via `resolveDiagramsVisible`.
//
// Kitchen Sink owns its own `{diagrams: off}` placement inside
// the "Diagrams toggle" section so the directive's role in the
// directive tour is still readable; this constant is only
// prepended to samples that do not already declare the directive
// themselves.
const DIAGRAMS_OFF_HEADER = '{diagrams: off}\n';

function withDiagramsOff(source: string): string {
  // The directive is position-dependent — placing it at line 1
  // suppresses the grid for the whole song. Idempotent against
  // samples that already include `{diagrams: off}` further down.
  return DIAGRAMS_OFF_HEADER + source;
}

const SAMPLES: ReadonlyArray<Sample> = [
  {
    id: 'amazing-grace',
    label: 'Amazing Grace',
    source: withDiagramsOff(SAMPLE_CHORDPRO),
  },
  {
    id: 'kitchen-sink',
    label: 'All directives (kitchen sink)',
    // Kitchen Sink declares `{diagrams: off}` inside its own
    // Diagrams-toggle section (see KITCHEN_SINK_SOURCE) — no
    // additional prefix needed.
    source: KITCHEN_SINK_SOURCE,
  },
  {
    id: 'country-roads',
    label: 'Country Roads',
    source: withDiagramsOff(`{title: Country Roads}
{artist: John Denver}
{key: G}
{capo: 0}
{tempo: 82}
{time: 4/4}

# Verse 1
{start_of_verse}
[G]Almost heaven, [Em]West Virginia
[D]Blue Ridge Mountains, [C]Shenandoah [G]River
[G]Life is old there, [Em]older than the trees
[D]Younger than the mountains, [C]growin' like a [G]breeze
{end_of_verse}

{start_of_chorus}
[G]Country roads, [D/F#]take me home
[Em7]To the place [C]I belong, [G/D]West Virginia
[G]Mountain mama, [D]take me home
[C]Country [G]roads
{end_of_chorus}
`),
  },
  {
    id: 'unicode',
    label: 'Unicode (日本語)',
    source: withDiagramsOff(`{title: 桜の歌}
{subtitle: 春の調べ}
{key: D}
{tempo: 92}

{start_of_verse}
[D]さくら [A]さくら、[Bm]春の[F#m]空
[G]霞か[D]雲か、[A]匂い[D]ぞ出ずる
{end_of_verse}
`),
  },
  {
    id: 'minimal',
    label: 'Minimal',
    source: withDiagramsOff(`{title: Minimal}
[C]Just a [G]plain line.
`),
  },
  {
    id: 'empty',
    label: 'Empty',
    // Intentionally empty — there is no song to suppress diagrams
    // for, and the directive prefix would itself become the first
    // line of an otherwise blank document.
    source: '',
  },
];

const DEFAULT_SAMPLE = SAMPLES[0]!;

// ---------------------------------------------------------------
// Live source statistics + validation surfaced in the pane-head
// meta and the status footer.
// ---------------------------------------------------------------

interface SourceStats {
  lines: number;
  chars: number;
  chords: number;
  sections: number;
}

interface Warning {
  line: number;
  column: number;
  message: string;
}

const CHORD_RE = /\[[^\]]+\]/g;
const SECTION_RE = /\{(?:start|end)_of_(?:verse|chorus|bridge|tab|grid)\b/g;

function computeStats(source: string): SourceStats {
  const lines = source.length === 0 ? 0 : source.split('\n').length;
  const chars = source.length;
  const chordMatches = source.match(CHORD_RE);
  const chords = chordMatches ? chordMatches.length : 0;
  const sectionMatches = source.match(SECTION_RE);
  const sections = sectionMatches ? Math.ceil(sectionMatches.length / 2) : 0;
  return { lines, chars, chords, sections };
}

function runValidate(source: string): Warning[] {
  // `validate()` may throw before wasm has resolved (the binding
  // panics with a "wasm not initialised" error). Swallow that
  // single race-condition and let the next run after wasm-ready
  // populate the warnings.
  try {
    return validate(source) as Warning[];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------

const TRANSPOSE_MIN = -11;
const TRANSPOSE_MAX = 11;
const CAPO_MIN = 0;
const CAPO_MAX = 12;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function formatTranspose(value: number): string {
  if (value === 0) return '+0';
  return value > 0 ? `+${value}` : String(value);
}

// `{capo: N}` is just a metadata directive in ChordPro — the renderer
// surfaces it in the meta strip below the title but does not transpose
// chords by it. So the playground's Capo control round-trips through
// the source: the UI reads the current capo by parsing the directive,
// and a button click rewrites the source to set / update / remove it.
// Two-way sync stays consistent because the displayed value is always
// derived from `source`, never held as an independent state.
const CAPO_DIRECTIVE_RE = /\{capo:\s*(-?\d+)\s*\}\s*\n?/;

function readCapo(source: string): number {
  const match = source.match(CAPO_DIRECTIVE_RE);
  if (!match) return 0;
  const n = parseInt(match[1], 10);
  return Number.isFinite(n) ? clamp(n, CAPO_MIN, CAPO_MAX) : 0;
}

function setCapoInSource(source: string, capo: number): string {
  const directive = capo === 0 ? '' : `{capo: ${capo}}\n`;
  if (CAPO_DIRECTIVE_RE.test(source)) {
    return source.replace(CAPO_DIRECTIVE_RE, directive);
  }
  if (capo === 0) return source;
  // No existing capo directive — insert one. Try to slot it in
  // alongside the other metadata directives at the top: after
  // `{key: …}` if present, otherwise after `{title: …}`, otherwise
  // at the very start. This keeps `{capo}` next to its conceptual
  // siblings instead of dropping it on a random line in the lyrics.
  const anchorRe = /^(\{(?:title|subtitle|artist|key|tempo|time)[^}]*\}\s*\n)+/;
  const anchor = source.match(anchorRe);
  if (anchor) {
    const idx = anchor.index! + anchor[0].length;
    return `${source.slice(0, idx)}${directive}${source.slice(idx)}`;
  }
  return `${directive}${source}`;
}

// ---------------------------------------------------------------
// PlaygroundApp
// ---------------------------------------------------------------

type View = 'split' | 'source' | 'preview';

function PlaygroundApp(): JSX.Element {
  const [source, setSource] = useState<string>(DEFAULT_SAMPLE.source);
  // Editor caret position relayed into the preview. `null` until the
  // user focuses the editor — the preview shows no active-line
  // highlight or caret-marker overlay in that state.
  const [caret, setCaret] = useState<
    { line: number; column: number; lineLength: number } | null
  >(null);
  const [transpose, setTranspose] = useState<number>(0);
  const [view, setView] = useState<View>('split');
  const [sampleId, setSampleId] = useState<string>(DEFAULT_SAMPLE.id);
  const [warningsExpanded, setWarningsExpanded] = useState<boolean>(false);
  const [version, setVersion] = useState<string | null>(cachedVersion);

  const editorRef = useRef<SourceEditorHandle | null>(null);

  useEffect(() => {
    if (version !== null) return;
    void wasmReady.then(() => {
      try {
        setVersion(wasmVersion());
      } catch {
        /* leave null */
      }
    });
  }, [version]);

  const handleSourceChange = useCallback((next: string) => {
    setSource(next);
  }, []);

  const stats = useMemo(() => computeStats(source), [source]);

  const warnings = useMemo<Warning[]>(() => runValidate(source), [source]);

  // Capo is derived from the source so manual edits to `{capo: N}`
  // and toolbar button clicks stay in sync without an explicit
  // `useEffect`.
  const capo = useMemo(() => readCapo(source), [source]);

  // Bump capo with the functional `setSource` form so rapid clicks
  // in the same event-loop tick read the latest value, not the
  // closure-captured one. The controlled `<SourceEditor value>`
  // prop syncs the CodeMirror doc on the next render via
  // `<SourceEditor>`'s value-sync effect, so we don't need to call
  // `editorRef.current?.setValue` here.
  const stepCapo = useCallback((delta: number) => {
    setSource((current) => {
      const next = clamp(readCapo(current) + delta, CAPO_MIN, CAPO_MAX);
      return setCapoInSource(current, next);
    });
  }, []);

  const resetCapo = useCallback(() => {
    setSource((current) => setCapoInSource(current, 0));
  }, []);

  const previewMeta = useMemo(() => {
    const transposeLabel = transpose === 0 ? '' : ` · ${formatTranspose(transpose)}`;
    return `Live · HTML${transposeLabel}`;
  }, [transpose]);

  const handleSamplePick = useCallback((id: string) => {
    const sample = SAMPLES.find((s) => s.id === id);
    if (!sample) return;
    setSampleId(id);
    setSource(sample.source);
    editorRef.current?.setValue(sample.source);
  }, []);

  const insert = useCallback((text: string, selectInside = true) => {
    editorRef.current?.insertAtCursor(text, selectInside);
  }, []);

  return (
    <div className="chordsketch-app">
      <header className="topnav">
        <a className="brand" href="https://github.com/koedame/chordsketch">
          <span className="mark" aria-hidden="true" />
          ChordSketch
        </a>
        <nav className="crumbs" aria-label="Breadcrumb">
          <a href="../">Playground</a>
          <span className="sep">›</span>
          <span className="current">ChordPro</span>
        </nav>
        <div className="actions">
          <div className="topnav__view segmented" role="group" aria-label="Pane visibility">
            {(['split', 'source', 'preview'] as const).map((v) => (
              <button
                key={v}
                type="button"
                aria-pressed={view === v}
                onClick={() => setView(v)}
              >
                {v === 'split' ? 'Split' : v === 'source' ? 'Source' : 'Preview'}
              </button>
            ))}
          </div>
          <label className="topnav__sample">
            <span className="label">Sample</span>
            <select
              className="chordsketch-app__select"
              value={sampleId}
              onChange={(e) => handleSamplePick(e.currentTarget.value)}
              aria-label="Sample song"
            >
              {SAMPLES.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
          <a
            className="btn btn-ghost btn-sm"
            href="https://github.com/koedame/chordsketch"
            target="_blank"
            rel="noreferrer noopener"
            aria-label="View source on GitHub (opens in a new tab)"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="currentColor"
              aria-hidden="true"
              focusable="false"
            >
              <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.56v-2.04c-3.2.7-3.87-1.36-3.87-1.36-.52-1.32-1.27-1.67-1.27-1.67-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.18 1.76 1.18 1.02 1.75 2.69 1.24 3.34.95.1-.74.4-1.24.72-1.53-2.55-.29-5.23-1.27-5.23-5.66 0-1.25.45-2.27 1.18-3.07-.12-.29-.51-1.46.11-3.04 0 0 .96-.31 3.16 1.18a10.93 10.93 0 0 1 5.74 0c2.2-1.49 3.16-1.18 3.16-1.18.62 1.58.23 2.75.11 3.04.74.8 1.18 1.82 1.18 3.07 0 4.4-2.69 5.36-5.25 5.65.41.36.78 1.06.78 2.13v3.16c0 .31.21.67.8.56C20.71 21.39 24 17.08 24 12 24 5.65 18.85.5 12 .5z" />
            </svg>
            View source
          </a>
        </div>
      </header>


      <main
        className={`editor${view === 'source' ? ' editor--source-only' : ''}${
          view === 'preview' ? ' editor--preview-only' : ''
        }`}
      >
        {view !== 'preview' && (
          <section className="pane source">
            <header className="pane-head">
              <p className="eyebrow">Source · ChordPro</p>
              <span className="meta">
                UTF-8 · LF · {stats.lines} {stats.lines === 1 ? 'line' : 'lines'}
              </span>
            </header>
            <div className="pane-toolbar" role="toolbar" aria-label="Editor insert helpers">
              <div className="tool-group">
                <span className="label">Insert</span>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => insert('[C]')}
                >
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    aria-hidden="true"
                    focusable="false"
                  >
                    <path d="M12 5v14M5 12h14" />
                  </svg>
                  Chord
                </button>
                <select
                  className="chordsketch-app__select insert-picker"
                  aria-label="Insert ChordPro directive"
                  value=""
                  onChange={(e) => {
                    const snippet = e.currentTarget.value;
                    e.currentTarget.value = '';
                    if (snippet) insert(snippet);
                  }}
                >
                  <option value="" disabled>
                    + Directive
                  </option>
                  <option value="{title: }">title</option>
                  <option value="{subtitle: }">subtitle</option>
                  <option value="{artist: }">artist</option>
                  <option value="{composer: }">composer</option>
                  <option value="{key: }">key</option>
                  <option value="{tempo: }">tempo</option>
                  <option value="{time: }">time</option>
                  <option value="{capo: }">capo</option>
                  <option value="{comment: }">comment</option>
                  <option value="{comment_italic: }">comment_italic</option>
                  <option value="{comment_box: }">comment_box</option>
                  <option value="{define: }">define</option>
                  <option value="{image: }">image</option>
                </select>
                <select
                  className="chordsketch-app__select insert-picker"
                  aria-label="Insert ChordPro section"
                  value=""
                  onChange={(e) => {
                    const snippet = e.currentTarget.value;
                    e.currentTarget.value = '';
                    if (snippet) insert(snippet, false);
                  }}
                >
                  <option value="" disabled>
                    + Section
                  </option>
                  <option value={'\n{start_of_verse}\n\n{end_of_verse}\n'}>
                    verse
                  </option>
                  <option value={'\n{start_of_chorus}\n\n{end_of_chorus}\n'}>
                    chorus
                  </option>
                  <option value={'\n{start_of_bridge}\n\n{end_of_bridge}\n'}>
                    bridge
                  </option>
                  <option value={'\n{start_of_tab}\n\n{end_of_tab}\n'}>tab</option>
                  <option value={'\n{start_of_grid}\n\n{end_of_grid}\n'}>grid</option>
                </select>
              </div>
            </div>
            <div className="pane-body">
              <SourceEditor
                ref={editorRef}
                value={source}
                onChange={handleSourceChange}
                onCaretChange={setCaret}
                placeholder="Paste your ChordPro here…"
              />
            </div>
          </section>
        )}
        {view !== 'source' && (
          <section className="pane preview">
            <header className="pane-head">
              <p className="eyebrow">Preview · HTML</p>
              <span className="meta">{previewMeta}</span>
            </header>
            <div
              className="pane-toolbar"
              role="toolbar"
              aria-label="Preview performance controls"
            >
              <div className="tool-group">
                <span className="label">Transpose</span>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  aria-label="Transpose down one semitone"
                  onClick={() =>
                    setTranspose((v) => clamp(v - 1, TRANSPOSE_MIN, TRANSPOSE_MAX))
                  }
                  disabled={transpose <= TRANSPOSE_MIN}
                >
                  −
                </button>
                <span className="transpose-value" aria-live="polite">
                  {formatTranspose(transpose)}
                </span>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  aria-label="Transpose up one semitone"
                  onClick={() =>
                    setTranspose((v) => clamp(v + 1, TRANSPOSE_MIN, TRANSPOSE_MAX))
                  }
                  disabled={transpose >= TRANSPOSE_MAX}
                >
                  +
                </button>
                {transpose !== 0 && (
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => setTranspose(0)}
                  >
                    Reset
                  </button>
                )}
              </div>

              <div className="tool-group">
                <span className="label">Capo</span>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  aria-label="Capo down one fret"
                  onClick={() => stepCapo(-1)}
                  disabled={capo <= CAPO_MIN}
                >
                  −
                </button>
                <span className="transpose-value" aria-live="polite">
                  {capo}
                </span>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  aria-label="Capo up one fret"
                  onClick={() => stepCapo(1)}
                  disabled={capo >= CAPO_MAX}
                >
                  +
                </button>
                {capo !== 0 && (
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={resetCapo}
                  >
                    Reset
                  </button>
                )}
              </div>

              <div className="tool-group">
                <span className="label">Export</span>
                <PdfExport
                  source={source}
                  options={{ transpose }}
                  filename="chordsketch-output.pdf"
                  className="btn btn-secondary btn-sm"
                >
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                    focusable="false"
                  >
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="7 10 12 15 17 10" />
                    <line x1="12" y1="15" x2="12" y2="3" />
                  </svg>
                  Download PDF
                </PdfExport>
              </div>
            </div>
            <div className="pane-body">
              <RendererPreview
                source={source}
                transpose={transpose}
                format="html"
                chordDiagramsInstrument="guitar"
                activeSourceLine={caret?.line}
                caretColumn={caret?.column}
                caretLineLength={caret?.lineLength}
              />
            </div>
          </section>
        )}
      </main>

      <footer className="status" role="status" aria-live="polite">
        <button
          type="button"
          className={`status__parsed${warnings.length > 0 ? ' status__parsed--warn' : ''}`}
          onClick={() => setWarningsExpanded((v) => !v)}
          aria-expanded={warnings.length > 0 ? warningsExpanded : undefined}
          aria-controls={warnings.length > 0 ? 'status-warnings' : undefined}
          disabled={warnings.length === 0}
        >
          <span className={warnings.length === 0 ? 'ok' : 'warn'}>●</span>
          {warnings.length === 0
            ? 'Parsed · 0 warnings'
            : `Parsed · ${warnings.length} ${warnings.length === 1 ? 'warning' : 'warnings'}`}
        </button>
        <span className="item">
          {stats.lines} {stats.lines === 1 ? 'line' : 'lines'} · {stats.chars}{' '}
          {stats.chars === 1 ? 'char' : 'chars'}
        </span>
        <span className="item">
          {stats.chords} {stats.chords === 1 ? 'chord' : 'chords'} · {stats.sections}{' '}
          {stats.sections === 1 ? 'section' : 'sections'}
        </span>
        <span className="spacer" />
        <span className="item">UTF-8</span>
        <span className="item">ChordPro</span>
        {version && <span className="item">v{version}</span>}
      </footer>

      {warnings.length > 0 && warningsExpanded && (
        <aside
          id="status-warnings"
          className="status-warnings"
          role="region"
          aria-label="Validation warnings"
        >
          <ul>
            {warnings.map((w, i) => (
              <li key={i}>
                <span className="status-warnings__loc">
                  Line {w.line}
                  {w.column > 0 ? `, Col ${w.column}` : ''}
                </span>
                <span className="status-warnings__msg">{w.message}</span>
              </li>
            ))}
          </ul>
        </aside>
      )}
    </div>
  );
}

const root = document.getElementById('app');
if (!root) {
  throw new Error('Playground entry point #app element missing from index.html');
}

createRoot(root).render(
  <StrictMode>
    <PlaygroundApp />
  </StrictMode>,
);
