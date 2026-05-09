import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

import init, {
  parseIrealb,
  renderIrealSvg,
  serializeIrealb,
  validate,
  version as wasmVersion,
} from '@chordsketch/wasm';
import { SAMPLE_CHORDPRO, SAMPLE_IREALB } from '@chordsketch/ui-web';
import {
  RendererPreview,
  SourceEditor,
  type PreviewFormat,
  type SourceEditorHandle,
} from '@chordsketch/react';
import '@chordsketch/react/styles.css';
import { createIrealbEditor } from '@chordsketch/ui-irealb-editor';
import '@chordsketch/ui-irealb-editor/style.css';

import './playground.css';

// ---------------------------------------------------------------
// WASM bootstrap.
// ---------------------------------------------------------------

const wasmReady: Promise<unknown> = init();

// Snapshot the wasm version once init resolves so the status bar
// can show it without firing a fresh import on every render. The
// `version()` export is synchronous after wasm init.
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

const SAMPLES: ReadonlyArray<Sample> = [
  {
    id: 'amazing-grace',
    label: 'Amazing Grace',
    source: SAMPLE_CHORDPRO,
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
// localStorage persistence.
// ---------------------------------------------------------------
//
// Per-format key so swapping ChordPro ↔ iRealb does not clobber
// the other format's draft. Reads are guarded against `null`
// (private mode / disabled storage); writes are best-effort.

const STORAGE_KEY_CHORDPRO = 'chordsketch:playground:chordpro:source';
const STORAGE_KEY_IREALB = 'chordsketch:playground:irealb:source';
const STORAGE_KEY_FORMAT = 'chordsketch:playground:input-format';

function loadFromStorage(key: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback;
  try {
    const v = window.localStorage.getItem(key);
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

function saveToStorage(key: string, value: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // QuotaExceeded / disabled storage — ignore.
  }
}

// ---------------------------------------------------------------
// URL hash for input format deep-link.
// ---------------------------------------------------------------

type InputFormat = 'chordpro' | 'irealb';

function readFormatHash(): InputFormat | null {
  if (typeof window === 'undefined') return null;
  const m = window.location.hash.match(/(?:^|[#&])format=(chordpro|irealb)\b/);
  return m ? (m[1] as InputFormat) : null;
}

function writeFormatHash(format: InputFormat): void {
  if (typeof window === 'undefined') return;
  const body = window.location.hash.replace(/^#/, '');
  const params = new URLSearchParams(body || '');
  params.set('format', format);
  window.history.replaceState(window.history.state, '', `#${params.toString()}`);
}

function detectInitialFormat(): InputFormat {
  const fromHash = readFormatHash();
  if (fromHash) return fromHash;
  const fromStorage = loadFromStorage(STORAGE_KEY_FORMAT, '');
  if (fromStorage === 'chordpro' || fromStorage === 'irealb') return fromStorage;
  return 'chordpro';
}

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
// IrealbPane — React wrapper around the imperative bar-grid
// editor. Mirrors the structure used in earlier revisions of the
// playground; restored here per the "全機能" directive.
// ---------------------------------------------------------------

const SVG_FRAME_TEMPLATE = (svg: string, cacheBust: number): string =>
  `<!DOCTYPE html><html><head><meta charset="UTF-8"><!-- r:${cacheBust} --><style>html,body{margin:0;padding:1rem;background:#FFFFFF;font-family:"Noto Sans JP",system-ui,-apple-system,sans-serif}svg{display:block;max-width:100%;height:auto}</style></head><body>${stripXmlProlog(
    svg,
  )}</body></html>`;

function stripXmlProlog(svg: string): string {
  return svg.replace(/^\s*<\?xml[^?]*\?>\s*/u, '');
}

interface IrealbPaneProps {
  initialValue: string;
  onChange: (value: string) => void;
}

function IrealbPane({ initialValue, onChange }: IrealbPaneProps): JSX.Element {
  const editorContainerRef = useRef<HTMLDivElement>(null);
  const previewIframeRef = useRef<HTMLIFrameElement>(null);
  const cacheBustRef = useRef<number>(0);
  const [source, setSource] = useState<string>(initialValue);
  const [svg, setSvg] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const host = editorContainerRef.current;
    if (!host) return;
    let cancelled = false;
    let cleanup: (() => void) | null = null;
    wasmReady
      .then(() => {
        if (cancelled || !host) return;
        const adapter = createIrealbEditor({
          initialValue,
          wasm: { parseIrealb, serializeIrealb },
        });
        host.replaceChildren(adapter.element);
        const off = adapter.onChange((next: string) => {
          setSource(next);
          onChange(next);
        });
        cleanup = () => {
          off();
          adapter.destroy();
        };
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
      cleanup?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let cancelled = false;
    wasmReady
      .then(() => {
        if (cancelled) return;
        try {
          const next = renderIrealSvg(source);
          setSvg(next);
          setError(null);
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        }
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [source]);

  useEffect(() => {
    const iframe = previewIframeRef.current;
    if (!iframe || error !== null) return;
    cacheBustRef.current += 1;
    iframe.srcdoc = SVG_FRAME_TEMPLATE(svg, cacheBustRef.current);
  }, [svg, error]);

  return (
    <main className="editor">
      <section className="pane source">
        <header className="pane-head">
          <p className="eyebrow">Source · iRealb</p>
          <span className="meta">Bar-grid editor</span>
        </header>
        <div ref={editorContainerRef} className="pane-body chordsketch-app__irealb-host" />
      </section>
      <section className="pane preview">
        <header className="pane-head">
          <p className="eyebrow">Preview · SVG</p>
          <span className="meta">Live · iRealb chart</span>
        </header>
        <div className="pane-body">
          {error ? (
            <pre className="chordsketch-app__error" role="alert">
              {error}
            </pre>
          ) : (
            <iframe
              ref={previewIframeRef}
              className="chordsketch-app__irealb-frame"
              title="iRealb chart preview"
              sandbox="allow-popups allow-popups-to-escape-sandbox"
            />
          )}
        </div>
      </section>
    </main>
  );
}

// ---------------------------------------------------------------
// Helpers (download, clipboard, format helpers).
// ---------------------------------------------------------------

const TRANSPOSE_MIN = -11;
const TRANSPOSE_MAX = 11;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function formatTranspose(value: number): string {
  if (value === 0) return '+0';
  return value > 0 ? `+${value}` : String(value);
}

// ---------------------------------------------------------------
// PlaygroundApp
// ---------------------------------------------------------------

type View = 'split' | 'source' | 'preview';

function PlaygroundApp(): JSX.Element {
  // Source state — separate per input format so toggling does
  // not lose either draft. `localStorage` rehydrates on first
  // mount; subsequent edits flush back via an effect.
  const [chordProSource, setChordProSource] = useState<string>(() =>
    loadFromStorage(STORAGE_KEY_CHORDPRO, DEFAULT_SAMPLE.source),
  );
  const [irealbSource, setIrealbSource] = useState<string>(() =>
    loadFromStorage(STORAGE_KEY_IREALB, SAMPLE_IREALB),
  );

  const [inputFormat, setInputFormat] = useState<InputFormat>(detectInitialFormat);
  const [previewFormat, setPreviewFormat] = useState<PreviewFormat>('html');
  const [transpose, setTranspose] = useState<number>(0);
  const [view, setView] = useState<View>('split');
  const [sampleId, setSampleId] = useState<string>(DEFAULT_SAMPLE.id);
  const [warningsExpanded, setWarningsExpanded] = useState<boolean>(false);
  const [version, setVersion] = useState<string | null>(cachedVersion);

  const editorRef = useRef<SourceEditorHandle | null>(null);

  // Persist source + format. Throttling not needed — localStorage
  // writes are synchronous and 10s of KB of source is well under
  // any noticeable cost per keystroke.
  useEffect(() => {
    saveToStorage(STORAGE_KEY_CHORDPRO, chordProSource);
  }, [chordProSource]);
  useEffect(() => {
    saveToStorage(STORAGE_KEY_IREALB, irealbSource);
  }, [irealbSource]);
  useEffect(() => {
    saveToStorage(STORAGE_KEY_FORMAT, inputFormat);
    writeFormatHash(inputFormat);
  }, [inputFormat]);

  // Version — wasm may not be ready at first render; poll once.
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

  const handleChordProChange = useCallback((next: string) => {
    setChordProSource(next);
  }, []);
  const handleIrealbChange = useCallback((next: string) => {
    setIrealbSource(next);
  }, []);

  const stats = useMemo(
    () => computeStats(inputFormat === 'chordpro' ? chordProSource : irealbSource),
    [chordProSource, irealbSource, inputFormat],
  );

  // Validation only applies to ChordPro. iRealb has its own
  // parse error surface inside the bar-grid editor.
  const warnings = useMemo<Warning[]>(
    () => (inputFormat === 'chordpro' ? runValidate(chordProSource) : []),
    [chordProSource, inputFormat],
  );

  const previewMeta = useMemo(() => {
    const transposeLabel = transpose === 0 ? '' : ` · ${formatTranspose(transpose)}`;
    if (previewFormat === 'html') return `Live · HTML${transposeLabel}`;
    if (previewFormat === 'text') return `Live · Text${transposeLabel}`;
    return `On demand · PDF${transposeLabel}`;
  }, [previewFormat, transpose]);

  const handleSamplePick = useCallback(
    (id: string) => {
      const sample = SAMPLES.find((s) => s.id === id);
      if (!sample) return;
      setSampleId(id);
      setChordProSource(sample.source);
      editorRef.current?.setValue(sample.source);
    },
    [],
  );

  const handleResetDraft = useCallback(() => {
    const sample = SAMPLES.find((s) => s.id === sampleId) ?? DEFAULT_SAMPLE;
    setChordProSource(sample.source);
    editorRef.current?.setValue(sample.source);
  }, [sampleId]);

  // Quick-insert helpers — paste a placeholder into the editor at
  // the caret, leaving the placeholder selected so the next
  // keystroke overwrites it. Fires a real user-edit so onChange /
  // localStorage persistence flow normally.
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
          <span className="current">Playground</span>
          <span className="sep">›</span>
          <span>{inputFormat === 'chordpro' ? 'ChordPro' : 'iRealb'}</span>
        </nav>
        <div className="actions">
          <a
            className="btn btn-ghost btn-sm"
            href="https://github.com/koedame/chordsketch"
            target="_blank"
            rel="noreferrer noopener"
          >
            View source
          </a>
        </div>
      </header>

      <div className="toolbar" role="toolbar" aria-label="Editor tools">
        <div className="tool-group">
          <span className="label">Input</span>
          <div className="segmented" role="group" aria-label="Input format">
            {(['chordpro', 'irealb'] as const).map((f) => (
              <button
                key={f}
                type="button"
                aria-pressed={inputFormat === f}
                onClick={() => setInputFormat(f)}
              >
                {f === 'chordpro' ? 'ChordPro' : 'iRealb'}
              </button>
            ))}
          </div>
        </div>

        {inputFormat === 'chordpro' && (
          <>
            <div className="tool-group">
              <span className="label">Format</span>
              <div className="segmented" role="group" aria-label="Render format">
                {(['html', 'text', 'pdf'] as const).map((f) => (
                  <button
                    key={f}
                    type="button"
                    aria-pressed={previewFormat === f}
                    onClick={() => setPreviewFormat(f)}
                  >
                    {f === 'html' ? 'HTML' : f === 'text' ? 'Text' : 'PDF'}
                  </button>
                ))}
              </div>
            </div>

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
              <span className="label">View</span>
              <div className="segmented" role="group" aria-label="Pane visibility">
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
            </div>

            <div className="tool-group">
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
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={handleResetDraft}
                title="Reset the source to the selected sample"
              >
                Reset
              </button>
            </div>

            <div className="tool-group">
              <span className="label">Insert</span>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => insert('[C]')}
              >
                [Chord]
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => insert('{title: }')}
              >
                {'{directive}'}
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() =>
                  insert('\n{start_of_verse}\n\n{end_of_verse}\n', false)
                }
              >
                Section
              </button>
            </div>
          </>
        )}
      </div>

      {inputFormat === 'chordpro' ? (
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
              <div className="pane-body">
                <SourceEditor
                  ref={editorRef}
                  value={chordProSource}
                  onChange={handleChordProChange}
                  placeholder="Paste your ChordPro here…"
                />
              </div>
            </section>
          )}
          {view !== 'source' && (
            <section className="pane preview">
              <header className="pane-head">
                <p className="eyebrow">
                  Preview ·{' '}
                  {previewFormat === 'html' ? 'HTML' : previewFormat === 'text' ? 'Text' : 'PDF'}
                </p>
                <span className="meta">{previewMeta}</span>
              </header>
              <div className="pane-body">
                <RendererPreview
                  source={chordProSource}
                  transpose={transpose}
                  format={previewFormat}
                />
              </div>
            </section>
          )}
        </main>
      ) : (
        <IrealbPane
          key="irealb"
          initialValue={irealbSource}
          onChange={handleIrealbChange}
        />
      )}

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
        <span className="item">{inputFormat === 'chordpro' ? 'ChordPro' : 'iRealb'}</span>
        {version && <span className="item">v{version}</span>}
      </footer>

      {warnings.length > 0 && warningsExpanded && (
        <aside id="status-warnings" className="status-warnings" role="region" aria-label="Validation warnings">
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
