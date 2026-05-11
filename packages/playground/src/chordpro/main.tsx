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
// `chordsketch-chordpro` parses today, ordered roughly by category
// so the rendered output reads top-to-bottom as a guided tour.
// Categories: metadata, transpose, custom chord, comments, sections
// (verse / chorus / bridge / tab / grid / custom), chorus recall,
// font/size/color overrides, page control, image, meta, generic
// `{start_of_X}` custom environment.
const KITCHEN_SINK_SOURCE = `# ChordSketch — Kitchen Sink
# Every directive ChordSketch currently parses, exercised in order.
# Lines starting with '#' are comments stripped before rendering.

# --- Metadata ---------------------------------------------------
{title: All Directives Tour}
{subtitle: A guided tour of every ChordPro directive}
{subtitle: Second subtitle (multiple allowed)}
{artist: ChordSketch Demo}
{composer: J. Composer}
{lyricist: J. Lyricist}
{album: Reference Sheet}
{year: 2026}
{key: G}
{time: 4/4}
{tempo: 120}
{capo: 2}
{duration: 3:30}
{copyright: © 2026 Koedame}
{tag: demo}
{tag: reference}
{meta: arranger Jane Arranger}

# --- Custom chord definition (used below) -----------------------
{define: Gsus4 base-fret 1 frets 3 3 0 0 1 3}
{chord: Gsus4}

# --- Comments ---------------------------------------------------
{comment: Plain comment — italic note above the next line}
{comment_italic: Italic comment variant}
{comment_box: Boxed comment for emphasis}

# --- Verse with inline chords -----------------------------------
{start_of_verse: Verse 1}
[G]This is a [C/G]verse line, [D]chord [Em]over [C]each [G]word.
[Gsus4]Custom-defined chord above [G]resolves home.
{end_of_verse}

# --- Chorus (defined once, recalled below) ----------------------
{start_of_chorus: Chorus}
[C]Sing the [G]chorus, [D]every-[Em]one to-[C]gether [G]now.
{end_of_chorus}

# --- Bridge -----------------------------------------------------
{start_of_bridge: Bridge}
[Am]A bridge takes you [F]somewhere [C]new before the [G]return.
{end_of_bridge}

# --- Verse 2 with directive-as-section-label --------------------
{start_of_verse: Verse 2}
[G]Second verse, [C]different words, [D]same chord [G]shape.
{end_of_verse}

# --- Chorus recall (no body — replays the chorus above) ---------
{chorus}

# --- Tab (verbatim monospace block) -----------------------------
{start_of_tab: Solo}
e|---0---2---3---2---0--------|
B|---0---0---0---0---0--------|
G|---0---0---0---0---0--------|
D|---2---2---0---2---2--------|
A|---3-----------3---3--------|
E|----------------------------|
{end_of_tab}

# --- Grid (chord-grid block) ------------------------------------
{start_of_grid: Outro Riff}
| G . . . | C . . . | D . . . | G . . . |
| Em . . . | C . . . | D . . . | G . . . |
{end_of_grid}

# --- Custom section (generic start_of_X) ------------------------
{start_of_intro: Intro}
[G]Pick [Em]each [C]string [D]gently.
{end_of_intro}

# --- Transpose directive ----------------------------------------
{transpose: 0}

# --- Font / size / colour overrides -----------------------------
{textfont: serif}
{textsize: 14}
{textcolour: #1a1a1a}
{chordfont: monospace}
{chordsize: 12}
{chordcolour: #BD1642}
{titlefont: sans-serif}
{titlesize: 24}
{titlecolour: #1a1a1a}
{chorusfont: serif}
{chorussize: 13}
{choruscolour: #555555}
{footerfont: sans-serif}
{footersize: 9}
{footercolour: #777777}
{headerfont: sans-serif}
{headersize: 9}
{headercolour: #777777}
{labelfont: sans-serif}
{labelsize: 11}
{labelcolour: #BD1642}
{gridfont: monospace}
{gridsize: 11}
{gridcolour: #1a1a1a}
{tabfont: monospace}
{tabsize: 11}
{tabcolour: #1a1a1a}
{tocfont: sans-serif}
{tocsize: 11}
{toccolour: #1a1a1a}

# --- Diagrams toggle --------------------------------------------
{diagrams: true}
{no_diagrams}

# --- Page / layout control --------------------------------------
{columns: 2}
{column_break}
{new_page}
{new_physical_page}

# --- Image ------------------------------------------------------
{image: src="https://raw.githubusercontent.com/koedame/chordsketch/main/assets/logo-128.png" width=64 height=64 title="ChordSketch logo"}

# --- Config override --------------------------------------------
{+config.settings.titles: left}
`;

const SAMPLES: ReadonlyArray<Sample> = [
  {
    id: 'amazing-grace',
    label: 'Amazing Grace',
    source: SAMPLE_CHORDPRO,
  },
  {
    id: 'kitchen-sink',
    label: 'All directives (kitchen sink)',
    source: KITCHEN_SINK_SOURCE,
  },
  {
    id: 'country-roads',
    label: 'Country Roads',
    source: `{title: Country Roads}
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
`,
  },
  {
    id: 'unicode',
    label: 'Unicode (日本語)',
    source: `{title: 桜の歌}
{subtitle: 春の調べ}
{key: D}
{tempo: 92}

{start_of_verse}
[D]さくら [A]さくら、[Bm]春の[F#m]空
[G]霞か[D]雲か、[A]匂い[D]ぞ出ずる
{end_of_verse}
`,
  },
  {
    id: 'minimal',
    label: 'Minimal',
    source: `{title: Minimal}
[C]Just a [G]plain line.
`,
  },
  {
    id: 'empty',
    label: 'Empty',
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
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => insert('{title: }')}
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
                  Directive
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() =>
                    insert('\n{start_of_verse}\n\n{end_of_verse}\n', false)
                  }
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
                  Section
                </button>
              </div>
            </div>
            <div className="pane-body">
              <SourceEditor
                ref={editorRef}
                value={source}
                onChange={handleSourceChange}
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
              <RendererPreview source={source} transpose={transpose} format="html" />
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
