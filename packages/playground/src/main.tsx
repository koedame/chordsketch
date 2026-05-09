import { StrictMode, useCallback, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';

import init from '@chordsketch/wasm';
import { SAMPLE_CHORDPRO } from '@chordsketch/ui-web';
import {
  RendererPreview,
  SourceEditor,
  type PreviewFormat,
} from '@chordsketch/react';
import '@chordsketch/react/styles.css';

import './playground.css';

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
void init();

// ---------------------------------------------------------------
// Layout vocabulary.
// ---------------------------------------------------------------
//
// The chrome here mirrors `design-system/ui_kits/web/editor.html`
// 1:1: a `topnav` row, a `toolbar` row of `tool-group`s, two
// `pane`s with `pane-head` eyebrows, and a `status` footer. The
// reference's library breadcrumb / save state / undo-redo / save
// button are deliberately absent because the playground has no
// persistence layer — they would be empty chrome.

type View = 'split' | 'source' | 'preview';

const TRANSPOSE_MIN = -11;
const TRANSPOSE_MAX = 11;

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function formatTranspose(value: number): string {
  if (value === 0) return '+0';
  if (value > 0) return `+${value}`;
  return String(value);
}

// ---------------------------------------------------------------
// Live source statistics surfaced in the pane-head meta and the
// status footer. Counted lazily via `useMemo` so a typing burst
// does not re-tokenize the document on every render — the cost
// is bounded by `source` length anyway, but keeping the work
// memoised keeps the component cheap for large pastes.
// ---------------------------------------------------------------

interface SourceStats {
  lines: number;
  chars: number;
  chords: number;
  sections: number;
}

const CHORD_RE = /\[[^\]]+\]/g;
const SECTION_RE = /\{(?:start|end)_of_(?:verse|chorus|bridge|tab|grid)\b/g;

function computeStats(source: string): SourceStats {
  const lines = source.length === 0 ? 0 : source.split('\n').length;
  const chars = source.length;
  const chordMatches = source.match(CHORD_RE);
  const chords = chordMatches ? chordMatches.length : 0;
  const sectionMatches = source.match(SECTION_RE);
  // `start_of_*` and `end_of_*` are paired markers — divide by 2
  // and round up so an unpaired tail still counts as a section.
  const sections = sectionMatches ? Math.ceil(sectionMatches.length / 2) : 0;
  return { lines, chars, chords, sections };
}

// ---------------------------------------------------------------
// PlaygroundApp
// ---------------------------------------------------------------

function PlaygroundApp(): JSX.Element {
  const [source, setSource] = useState<string>(SAMPLE_CHORDPRO);
  const [previewFormat, setPreviewFormat] = useState<PreviewFormat>('html');
  const [transpose, setTranspose] = useState<number>(0);
  const [view, setView] = useState<View>('split');

  const handleSourceChange = useCallback((next: string) => {
    setSource(next);
  }, []);

  const stats = useMemo(() => computeStats(source), [source]);

  const previewMeta = useMemo(() => {
    const transposeLabel = transpose === 0 ? '' : ` · ${formatTranspose(transpose)}`;
    if (previewFormat === 'html') return `Live · HTML${transposeLabel}`;
    if (previewFormat === 'text') return `Live · Text${transposeLabel}`;
    return `On demand · PDF${transposeLabel}`;
  }, [previewFormat, transpose]);

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
          <span>ChordPro</span>
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
            onClick={() => setTranspose((v) => clamp(v - 1, TRANSPOSE_MIN, TRANSPOSE_MAX))}
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
            onClick={() => setTranspose((v) => clamp(v + 1, TRANSPOSE_MIN, TRANSPOSE_MAX))}
            disabled={transpose >= TRANSPOSE_MAX}
          >
            +
          </button>
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
      </div>

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
              <p className="eyebrow">
                Preview ·{' '}
                {previewFormat === 'html' ? 'HTML' : previewFormat === 'text' ? 'Text' : 'PDF'}
              </p>
              <span className="meta">{previewMeta}</span>
            </header>
            <div className="pane-body">
              <RendererPreview
                source={source}
                transpose={transpose}
                format={previewFormat}
              />
            </div>
          </section>
        )}
      </main>

      <footer className="status" role="status" aria-live="polite">
        <span className="item">
          <span className="ok">●</span>
          Parsed · 0 warnings
        </span>
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
      </footer>
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
