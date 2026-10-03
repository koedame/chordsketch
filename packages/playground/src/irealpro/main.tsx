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
import { Button } from '@chordsketch/react-ui';
import '@chordsketch/react-ui/styles.css';

import '../fonts.css';
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
  } catch (e) {
    // `wasm-bindgen` panics surface as `JsValue`s and would
    // otherwise vanish silently — log so a version-string
    // mismatch shows up in devtools instead of just falling
    // through to the chrome's `irealb:// v?` fallback.
    cachedVersion = null;
    if (typeof console !== 'undefined') {
      console.warn('[chordsketch-playground] wasmVersion() failed', e);
    }
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
  /** Mirrors the wasm AST's `staff_texts` array (URL `<...>` tokens).
   * Each entry is one staff-text token from the source URL; see
   * `crates/ireal/src/ast.rs::StaffText` for the variant shapes. */
  staff_texts?: StaffText[];
  /** Rich-extension flag forwarded to the React chart's BarCell so
   * the percent-style repeat-1-bar SMuFL glyph (U+E500) renders
   * in this bar's centre. Populated from `repeat_previous`. */
  repeatBars?: 1 | 2;
  /** Rich-extension N.C. flag — populated from `no_chord`. */
  noChord?: boolean;
  /** Rich-extension italic text mark below the bar — populated
   * by joining every text-typed entry in `staff_texts`. */
  textMark?: string;
}

/** Mirrors the Rust `StaffText` enum (#2426). The `type` discriminant
 * distinguishes free-form captions (`text`, optionally raised by
 * `vertical_position` in 0..=74) from the spec's `<Nx>` repeat-count
 * override. */
type StaffText =
  | { type: 'text'; text: string; vertical_position?: number | null }
  | { type: 'repeat_count'; count: number };

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
  // Narrow `catch` over the wasm call only — `JSON.parse` and
  // the rich-extension mapping below run against
  // parser-trusted output and any failure there is a
  // chordsketch-side bug, not a user-input error. Logging it
  // surfaces the mismatch via devtools instead of stranding
  // the UI on the `Loading…` placeholder forever.
  let json: string;
  try {
    json = parseIrealb(source);
  } catch {
    return null;
  }
  try {
    const song = JSON.parse(json) as IrealSong;
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
        if (bar.staff_texts && bar.staff_texts.length > 0) {
          // Join every plain-text staff entry with `; ` — the same
          // separator the pre-#2426 single-string `text_comment`
          // field used so existing chart visuals stay byte-stable.
          // `repeat_count` entries surface as `Nx` so the directive
          // intent survives the projection.
          const parts = bar.staff_texts
            .map((st) => (st.type === 'text' ? st.text : `${st.count}x`))
            .filter((s) => s.length > 0);
          if (parts.length > 0) {
            bar.textMark = parts.join('; ');
          }
        }
      }
    }
    return song;
  } catch (e) {
    if (typeof console !== 'undefined') {
      console.error(
        '[chordsketch-playground] parseIrealb succeeded but post-processing failed; this is a bug',
        e,
      );
    }
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
  /** Always an `irealb://…` or `irealbook://…` URL — sample data
   * flows through the canonical URL → `parseIrealb` → AST → React
   * chart pipeline so every sample also round-trips through
   * `serializeIrealb`. */
  source: string;
}

// Public-domain charts written out in the plain-text `irealbook://`
// open-protocol shape (title=composer=style=key=n=chart). Together
// they exercise section markers, repeat bars, a numbered ending and
// both 4/4 and 3/4.
const TWELVE_BAR_BLUES_URL =
  'irealbook://' +
  'Twelve-Bar%20Blues%3DTraditional%3DMedium%20Swing%3DC%3Dn%3D%5B' +
  '%2AAT44C7%20%7CF7%20%7CC7%20%7CC7%20%7CF7%20%7CF7%20%7CC7%20%7CC' +
  '7%20%7CG7%20%7CF7%20%7CC7%20%7CG7%20Z';

const AMAZING_GRACE_URL =
  'irealbook://' +
  'Amazing%20Grace%3DNewton%20John%3DWaltz%3DG%3Dn%3D%5B%2AAT34G%20' +
  '%7CG7%20%7CC%20%7CG%20%7CG%20%7CEm%20%7CD%20%7CD7%20%5D%5B%2ABG' +
  '%20%7CG7%20%7CC%20%7CG%20%7CEm%20%7CD%20%7CG%20%7CG%20Z';

const SAINTS_URL =
  'irealbook://' +
  'When%20the%20Saints%20Go%20Marching%20In%3DTraditional%3DMedium' +
  '%20Up%20Swing%3DC%3Dn%3D%7B%2AAT44C%20%7CC%20%7CC%20%7CC7%20%7CF' +
  '%20%7CF%20%7CC%20%7CC%20%7CC%20%7CG7%20%7CN1C%20%7CG7%20%7D%7CN2' +
  'C%20Z';

const SAMPLES: ReadonlyArray<Sample> = [
  {
    id: 'twelve-bar-blues',
    label: 'Twelve-Bar Blues',
    source: TWELVE_BAR_BLUES_URL,
  },
  {
    id: 'amazing-grace',
    label: 'Amazing Grace',
    source: AMAZING_GRACE_URL,
  },
  {
    id: 'saints',
    label: 'When the Saints Go Marching In',
    source: SAINTS_URL,
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
      } catch (e) {
        // Same rationale as the module-level `wasmVersion()`
        // above — log so a regression in the wasm version
        // surface is at least visible in devtools rather than
        // disappearing into the chrome's `?` fallback.
        if (typeof console !== 'undefined') {
          console.warn('[chordsketch-playground] wasmVersion() failed in effect', e);
        }
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
    } catch (e) {
      // Clipboard API is gated on secure context (HTTPS) and
      // user activation. The UX fallback (no-op) is the right
      // call here, but log so a debugging maintainer can find
      // the failure when the button silently does nothing on
      // an `http://` deployment.
      if (typeof console !== 'undefined') {
        console.warn('[chordsketch-playground] clipboard write failed', e);
      }
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
        <a className="brand" href="https://github.com/koedame/chordsketch">
          <span className="mark" aria-hidden="true" />
          ChordSketch
        </a>
        <nav className="crumbs" aria-label="Breadcrumb">
          <a href="../">Playground</a>
          <span className="sep">›</span>
          <span className="current">iReal Pro</span>
        </nav>
        <div className="actions">
          <label className="topnav__sample">
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
          </label>
          <Button as="a" variant="ghost" size="sm" href="../docs/">
            Docs
          </Button>
          <Button
            as="a"
            variant="ghost"
            size="sm"
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
          </Button>
        </div>
      </header>

      <main className="page">
        <div className="page__main">
          <section className="url-card" aria-label="iRealb URL editor">
            <header className="url-card__head">
              <span className="url-card__label">irealb URL</span>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={handleCopyUrl}
                aria-live="polite"
              >
                {urlCopied ? 'Copied' : 'Copy'}
              </Button>
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

      {/* `role="status"` is not one of the roles ARIA in HTML allows on
          `<footer>`, and setting it there cost the route an
          `aria-allowed-role` failure. `aria-live` is a global attribute,
          so a polite live region survives dropping the role — and the
          element keeps its `contentinfo` landmark. */}
      <footer className="status" aria-live="polite">
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
        <a
          className="item status__link"
          href="https://github.com/koedame/chordsketch#privacy"
          target="_blank"
          rel="noreferrer noopener"
          aria-label="Privacy: ChordSketch collects nothing (opens in a new tab)"
        >
          Privacy
        </a>
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
