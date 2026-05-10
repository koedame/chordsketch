/// <reference types="vite/client" />
import {
  StrictMode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { createRoot } from 'react-dom/client';

if (import.meta.env.DEV) {
  void import('react-grab');
}

import init, {
  parseIrealb,
  version as wasmVersion,
} from '@chordsketch/wasm';
import '@chordsketch/react/styles.css';

import '../playground.css';
import { IrealChart } from './chart';

// ---------------------------------------------------------------
// WASM bootstrap.
// ---------------------------------------------------------------

const wasmReady: Promise<unknown> = init();

let cachedVersion: string | null = null;
void wasmReady.then(() => {
  try {
    cachedVersion = wasmVersion();
  } catch {
    cachedVersion = null;
  }
});

// ---------------------------------------------------------------
// AST shape (subset of `chordsketch-ireal`'s JSON output).
// ---------------------------------------------------------------

type Accidental = 'natural' | 'sharp' | 'flat';
type KeyMode = 'major' | 'minor';

interface PitchClass {
  note: 'C' | 'D' | 'E' | 'F' | 'G' | 'A' | 'B';
  accidental: Accidental;
}

interface KeySignature {
  root: PitchClass;
  mode: KeyMode;
}

interface TimeSignature {
  numerator: number;
  denominator: number;
}

type BarlineKind = 'single' | 'double' | 'final' | 'repeatStart' | 'repeatEnd';

interface ChordQuality {
  kind: string;
}

interface Chord {
  root: PitchClass;
  quality: ChordQuality;
  bass: PitchClass | null;
}

interface BarChord {
  chord: Chord;
  position: { beat: number; subdivision: number };
}

interface SectionLabel {
  kind: 'letter' | 'named' | 'none';
  value?: string;
}

interface Bar {
  start: BarlineKind | string;
  end: BarlineKind | string;
  chords: BarChord[];
  ending: number | null;
  symbol: string | null;
  /** Mirrors the wasm AST's `repeat_previous` flag — set by the
   * parser when the URL contained a `Kcl` or `x` token. */
  repeat_previous?: boolean;
  /** Mirrors the wasm AST's `no_chord` flag (URL `n`). */
  no_chord?: boolean;
  /** Mirrors the wasm AST's `text_comment` field (URL `<...>`). */
  text_comment?: string | null;
  /** Rich-extension flag forwarded to the React chart's BarCell so
   * the percent-style repeat-1-bar SMuFL glyph (U+E500) renders
   * in this bar's centre. Populated from `repeat_previous`. */
  repeatBars?: 1 | 2;
  /** Rich-extension N.C. flag — populated from `no_chord`. */
  noChord?: boolean;
  /** Rich-extension italic text mark below the bar — populated
   * from `text_comment`. */
  textMark?: string;
}

interface Section {
  label: SectionLabel;
  bars: Bar[];
}

interface IrealSong {
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
// AST helpers — read / mutate / serialize round-trip.
// ---------------------------------------------------------------

function tryParse(source: string): IrealSong | null {
  try {
    const song = JSON.parse(parseIrealb(source)) as IrealSong;
    // Map the canonical wasm-AST flags onto the rich-extension
    // fields the React chart consumes. The parser owns the
    // structured semantics; this layer just re-shapes them into
    // the BarCell's vocabulary.
    for (const section of song.sections) {
      for (const bar of section.bars) {
        if (bar.repeat_previous) {
          bar.repeatBars = 1;
        }
        if (bar.no_chord) {
          bar.noChord = true;
        }
        if (bar.text_comment) {
          bar.textMark = bar.text_comment;
        }
      }
    }
    return song;
  } catch {
    return null;
  }
}

function tryParseError(source: string): string | null {
  try {
    parseIrealb(source);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

function formatKey(sig: KeySignature): string {
  const acc =
    sig.root.accidental === 'sharp'
      ? '♯'
      : sig.root.accidental === 'flat'
        ? '♭'
        : '';
  const m = sig.mode === 'minor' ? 'm' : '';
  return `${sig.root.note}${acc}${m}`;
}

function totalBars(song: IrealSong): number {
  return song.sections.reduce((sum, s) => sum + s.bars.length, 0);
}

// ---------------------------------------------------------------
// Sample charts.
// ---------------------------------------------------------------

interface Sample {
  id: string;
  label: string;
  /** Always `irealb://…` URL — sample data flows through the
   * canonical URL → `parseIrealb` → AST → React chart pipeline
   * so every sample also round-trips through `serializeIrealb`. */
  source: string;
}

// Real-world Autumn Leaves chart taken verbatim from a user-
// supplied iRealb URL (G minor, 4/4, 138 BPM, three sections).
// Exercises the full parse pipeline including endings, repeats,
// custom-tension qualities (`9b7`, `Δ7♯11`, etc.), and section
// breaks.
const AUTUMN_LEAVES_URL =
  'irealb://Autumn%20Leaves%3DKosma%20Joseph%3D%3DMedium%20Swing%3DG-%3D%3D' +
  '1r34LbKcu7%239b7D4C-9Xb7-A%7CQyX9%5EbE%7CQXy9%5EbB%7CQyX31F%7CQy5XyQ%7C' +
  '4TA*%7B9b7D%7CG-9XyAB*%5B%5DQyX%2C9-G2N%7D%7C%20%2C5%237G%209-G1N%7C' +
  'Qh7XyQ%7CQyX5bE%7CQy%7CG-9XB%7CQyX9b31F%7CQyX-9CZL5%237G%209-G%7C' +
  'Qyb%5E13XQyX5%23-AZL9%5D%5B*CA%209-FZL31bG%209-GQ%7CyX5%239%237D%7C' +
  'QyX7hE7b9%23QyX9%5E7b5XyQ%7CD7b9%235XyQ%7CG-11XyQKcl%20%20Z%20%3D' +
  'Jazz-Even%208ths%3D138%3D10';

const SPAIN_URL =
  'irealbook://Spain%3DCorea%20Chick%3DMedium%20Samba%3DB-%3D44%3D' +
  '%5B*AG%5E7%20%20%20%7C%20x%20%20%7CF%237%20%20%20%7C%20x%20%20%7C%2C' +
  'S%2CE-7%20%20%20%7CA7%20%20%20%7CD%5E7%20%20%20%7CG%5E9%2311%20%20%20%5D' +
  '%5B%2CC%237%20%20%20%7CF%237%239%20%20%20%7CBsus%20%20%20%7CB%20%20%20%7C%7C' +
  '%2C*B%2Cn%20%20%20%7C%3C13%20measure%20lead%20break%3E%20%20%20%20%7C' +
  '!Bsus%20%20%20%7C%20%20%20%20%7D%7C%2C*C%2C@G%5E7%20%20%20%7C%20x%20%20' +
  '%7C%20x%20%20%7C%20x%20%20%7CF%237%20%20%20%7C%20x%20%20%7C%20x%20%20' +
  '%7C%20x%20%20%7CE-7%20%20%20%7C%20x%20%20%7CA7%20%20%20%7C%20x%20%20' +
  '%7CD%5E7%20%20%20%7C%20x%20%20%7CG%5E7%20%20%20%7C%20x%20%20%7CC%237%20%20%20' +
  '%7C%20x%20%20%7CF%237%20%20%20%7C%20x%20%20%7CB-%20%20%20%7C%20x%20%20' +
  '%7C%3CD.S.%20al%202nd%20ending%3EB7%20%20%20%7C%20x%20%20%5D%20';

const MOON_RIVER_URL =
  'irealb://Moon%20River=Mancini%20Henry==Waltz=C==' +
  '1r34LbKcu7C%7CQyX4C%5E7XF%7CQyXE%2F7%5EC%7CQyX11%237%5EF%7CQyX7%2DA%7CQy%5E7%23113T%7BA%2A%7CQyX7yQ%7C' +
  'BhXG%2F7%2DA%7CQyX%2DA1NB%5B%2A%5DQyX9b7E%7CQyX7yQ%7CF%5EXE%2F7%5EN%5BC%2A%7D1XyQ%7C' +
  '%2DDZL7A%207%2DEZL9bB7%207h%23FZLG%2F%2DA%20%2DA7%20G7%201%237bB11%237%5EyQ%7C' +
  'A%2DE%2F7%5EC%7CQyX11%237%5E%7CFQyX7h%23F%7CQyXG%2F7XyQ%7C' +
  'FX7%2DA2yX7%2DD%5E7%2FEX9%237A%287%2DA%7CQyX%2997%23E%287%2DE%7CQyX7F%7CQy%29XyQ%7C' +
  'C%7CQyXQ%7CG7XyQ%7CC6XyQ%7CG7%20%20%20Z==0=0===';

const SAMPLES: ReadonlyArray<Sample> = [
  {
    id: 'autumn-leaves',
    label: 'Autumn Leaves',
    source: AUTUMN_LEAVES_URL,
  },
  {
    id: 'spain',
    label: 'Spain',
    source: SPAIN_URL,
  },
  {
    id: 'moon-river',
    label: 'Moon River',
    source: MOON_RIVER_URL,
  },
];

const DEFAULT_SAMPLE = SAMPLES[0]!;

// ---------------------------------------------------------------
// PlaygroundApp
// ---------------------------------------------------------------

const NOTES: PitchClass['note'][] = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
const ACCIDENTALS: Accidental[] = ['natural', 'sharp', 'flat'];
const TIME_DENOMS = [2, 4, 8, 16];

function PlaygroundApp(): JSX.Element {
  const [source, setSource] = useState<string>(DEFAULT_SAMPLE.source);
  const [sampleId, setSampleId] = useState<string>(DEFAULT_SAMPLE.id);
  const [version, setVersion] = useState<string | null>(cachedVersion);
  const [wasmInitDone, setWasmInitDone] = useState<boolean>(cachedVersion !== null);

  useEffect(() => {
    if (wasmInitDone) return;
    void wasmReady.then(() => {
      setWasmInitDone(true);
      try {
        setVersion(wasmVersion());
      } catch {
        /* leave null */
      }
    });
  }, [wasmInitDone]);

  // Every sample flows through the canonical pipeline:
  //   URL → parseIrealb → AST → React chart.
  const song = useMemo<IrealSong | null>(() => {
    if (!wasmInitDone) return null;
    return tryParse(source);
  }, [source, wasmInitDone]);

  const error = useMemo<string | null>(() => {
    if (!wasmInitDone) return null;
    return tryParseError(source);
  }, [source, wasmInitDone]);

  const barCount = song ? totalBars(song) : 0;
  const sectionCount = song ? song.sections.length : 0;

  const [urlCopied, setUrlCopied] = useState<boolean>(false);
  const handleCopyUrl = useCallback(async () => {
    if (!source) return;
    try {
      await navigator.clipboard.writeText(source);
      setUrlCopied(true);
      setTimeout(() => setUrlCopied(false), 1500);
    } catch {
      /* clipboard unavailable — silently no-op */
    }
  }, [source]);

  const handleSamplePick = useCallback((id: string) => {
    const sample = SAMPLES.find((s) => s.id === id);
    if (!sample) return;
    setSampleId(id);
    setSource(sample.source);
  }, []);

  return (
    <div className="chordsketch-app chordsketch-app--irealb">
      <header className="topnav">
        <a className="brand" href="../">
          <span className="mark" aria-hidden="true" />
          ChordSketch
        </a>
        <nav className="crumbs" aria-label="Breadcrumb">
          <a href="../">Playground</a>
          <span className="sep">›</span>
          <span className="current">iReal Pro</span>
        </nav>
        <span className="topnav__save-state" aria-live="polite">
          <span className="dot" />
          {error ? 'Parse error' : 'Live'}
        </span>
        <div className="topnav__tools" role="toolbar" aria-label="Editor tools">
          <div className="tool-group">
            <span className="label">Sample</span>
            <select
              className="chordsketch-app__select"
              value={sampleId}
              onChange={(e) => handleSamplePick(e.currentTarget.value)}
              aria-label="Sample chart"
            >
              {SAMPLES.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>
          <div className="tool-group">
            <span className="label">Layout</span>
            <span className="tool-group__readout">4 bars / line</span>
          </div>
        </div>
        <div className="actions">
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

      <main className="page">
        <div className="page__main">
          <section className="url-card" aria-label="iRealb URL editor">
            <header className="url-card__head">
              <span className="url-card__label">irealb URL</span>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={handleCopyUrl}
                aria-live="polite"
              >
                {urlCopied ? 'Copied' : 'Copy'}
              </button>
            </header>
            <textarea
              className="url-card__textarea"
              value={source}
              onChange={(e) => setSource(e.currentTarget.value)}
              spellCheck={false}
              aria-label="iRealb URL"
            />
          </section>

          {error ? (
            <section className="chart-card" aria-label="Parse error">
              <pre className="chordsketch-app__error" role="alert">
                {error}
              </pre>
            </section>
          ) : song ? (
            <IrealChart song={song} />
          ) : (
            <section className="chart-card" aria-label="Loading chart">
              <p className="chordsketch-app__empty">Loading…</p>
            </section>
          )}

        </div>
      </main>

      <footer className="status" role="status" aria-live="polite">
        <span className={`status__parsed${error ? ' status__parsed--warn' : ''}`}>
          <span className={error ? 'warn' : 'ok'}>●</span>
          {error ? 'Parse error' : song ? 'Parsed · 0 warnings' : 'Loading…'}
        </span>
        <span className="item">
          {sectionCount} {sectionCount === 1 ? 'section' : 'sections'} ·{' '}
          {barCount} {barCount === 1 ? 'bar' : 'bars'}
        </span>
        {song && (
          <span className="item">
            Key {formatKey(song.key_signature)} · {song.time_signature.numerator}/
            {song.time_signature.denominator}
            {song.tempo > 0 ? ` · ${song.tempo} BPM` : ''}
          </span>
        )}
        <span className="spacer" />
        <span className="item">irealb://</span>
        {version && <span className="item">v{version}</span>}
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
