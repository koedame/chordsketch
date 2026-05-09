import { StrictMode, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

import init, {
  parseIrealb,
  renderIrealSvg,
  serializeIrealb,
} from '@chordsketch/wasm';
import { SAMPLE_CHORDPRO, SAMPLE_IREALB } from '@chordsketch/ui-web';
import {
  RendererPreview,
  SourceEditor,
  SplitLayout,
  Transpose,
  type PreviewFormat,
} from '@chordsketch/react';
import '@chordsketch/react/styles.css';
import { createIrealbEditor } from '@chordsketch/ui-irealb-editor';
import '@chordsketch/ui-irealb-editor/style.css';

import { parseFormatHash, writeFormatHash, type InputFormat } from './_hash';
import './playground.css';

// ---------------------------------------------------------------
// WASM bootstrap.
// ---------------------------------------------------------------
//
// `init()` must resolve before any wasm-backed function is called.
// React effects fire after the first render, so we kick off init
// at module load and let consumers `await` the same promise. The
// `<SourceEditor>` factory is synchronous and does not depend on
// wasm; the iRealb editor's parse / serialize hooks DO call into
// wasm and gate their first construction on this promise (see
// `IrealbPane` below).
const wasmReady: Promise<unknown> = init();

// ---------------------------------------------------------------
// Format toggle hash sync.
// ---------------------------------------------------------------

function detectInitialFormat(seed: string): InputFormat {
  const hash = parseFormatHash(window.location.hash);
  if (hash !== null) return hash;
  const trimmed = seed.trimStart();
  if (trimmed.startsWith('irealb://') || trimmed.startsWith('irealbook://')) {
    return 'irealb';
  }
  return 'chordpro';
}

// ---------------------------------------------------------------
// IrealbPane — React wrapper around the imperative bar-grid editor.
// ---------------------------------------------------------------
//
// `@chordsketch/ui-irealb-editor` exposes a vanilla DOM editor via
// `createIrealbEditor`. To consume it from React we mount the
// editor's element inside a ref'd `<div>` in a `useEffect` and tear
// it down on unmount. The editor manages its own DOM; React only
// owns the host slot. The pane also renders the SVG preview to the
// right of the editor — iRealb does not flow through the
// chord-text-pdf renderer trio, so `<RendererPreview>` does not
// apply.
//
// The SVG preview is rendered inside a sandboxed iframe via
// `srcDoc` rather than injected into the parent DOM. The renderer
// already escapes user-supplied tokens before emitting markup, but
// iframe isolation gives an additional structural boundary so any
// future markup the renderer emits cannot reach the parent
// document's CSS or JS — a defence-in-depth choice consistent
// with `@chordsketch/ui-web`'s existing iframe-based preview.

interface IrealbPaneProps {
  initialValue: string;
  onChange: (value: string) => void;
}

function stripXmlProlog(svg: string): string {
  // `renderIrealSvg` emits a stand-alone document beginning with
  // `<?xml version="1.0" encoding="UTF-8"?>`. Inside an HTML
  // document body the prolog parses as a processing instruction,
  // which most browsers preserve as a node but render as nothing
  // — and crucially, the SVG following it ends up outside the
  // body in some quirks-mode paths. Stripping the prolog lets
  // the SVG embed cleanly as inline HTML.
  return svg.replace(/^\s*<\?xml[^?]*\?>\s*/u, '');
}

const SVG_FRAME_TEMPLATE = (svg: string, cacheBust: number): string =>
  `<!DOCTYPE html><html><head><meta charset="UTF-8"><!-- r:${cacheBust} --><style>html,body{margin:0;padding:1rem;background:#FFFFFF;font-family:"Noto Sans JP",system-ui,-apple-system,sans-serif}svg{display:block;max-width:100%;height:auto}</style></head><body>${stripXmlProlog(svg)}</body></html>`;

function IrealbPane({ initialValue, onChange }: IrealbPaneProps): JSX.Element {
  const editorContainerRef = useRef<HTMLDivElement>(null);
  const previewIframeRef = useRef<HTMLIFrameElement>(null);
  const cacheBustRef = useRef<number>(0);
  const [source, setSource] = useState<string>(initialValue);
  const [svg, setSvg] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  // Mount the bar-grid editor once; tear it down on unmount.
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
        // `replaceChildren()` is the modern, XSS-safe way to clear
        // a host node before reattaching the adapter's DOM. The
        // adapter element itself is constructed by trusted code in
        // `@chordsketch/ui-irealb-editor`, never from an HTML
        // string.
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
    // The iRealb editor is only re-mounted on unmount/remount of
    // the pane (i.e. when the user switches input format). Editing
    // flows through `adapter.onChange`, which keeps `source` in
    // sync without a re-mount. `initialValue` / `onChange` are
    // captured by the closure on first run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-render the SVG whenever the source changes.
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

  // Imperative `iframe.srcdoc =` write — React's `srcDoc` prop
  // reflects the same attribute, but on some browser / React
  // version combinations the attribute is set so quickly after
  // mount that the iframe's load event fires before the value is
  // observed; an explicit assignment after the SVG state has
  // settled avoids that race. Mirrors the pattern in
  // `@chordsketch/react`'s `<HtmlPreview>` and ui-web's
  // `HTML_FRAME_TEMPLATE` writer.
  useEffect(() => {
    const iframe = previewIframeRef.current;
    if (!iframe) return;
    if (error !== null) return;
    cacheBustRef.current += 1;
    iframe.srcdoc = SVG_FRAME_TEMPLATE(svg, cacheBustRef.current);
  }, [svg, error]);

  return (
    <SplitLayout
      className="chordsketch-app__split"
      start={
        <div ref={editorContainerRef} className="chordsketch-app__irealb-host" />
      }
      end={
        <div className="chordsketch-app__irealb-preview">
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
      }
    />
  );
}

// ---------------------------------------------------------------
// ChordProPane — design-system playground for the ChordPro path.
// ---------------------------------------------------------------

interface ChordProPaneProps {
  initialValue: string;
  format: PreviewFormat;
  transpose: number;
  onChange: (value: string) => void;
}

function ChordProPane({
  initialValue,
  format,
  transpose,
  onChange,
}: ChordProPaneProps): JSX.Element {
  const [source, setSource] = useState<string>(initialValue);
  const handleChange = useCallback(
    (next: string) => {
      setSource(next);
      onChange(next);
    },
    [onChange],
  );
  return (
    <SplitLayout
      className="chordsketch-app__split"
      start={
        <SourceEditor
          value={source}
          onChange={handleChange}
          placeholder="Paste your ChordPro here…"
        />
      }
      end={
        <RendererPreview
          source={source}
          transpose={transpose}
          format={format}
        />
      }
    />
  );
}

// ---------------------------------------------------------------
// PlaygroundApp — top-level shell with format toggle, transpose,
// and renderer-format select. Composes the two panes above.
// ---------------------------------------------------------------

function PlaygroundApp(): JSX.Element {
  const [inputFormat, setInputFormat] = useState<InputFormat>(() =>
    detectInitialFormat(SAMPLE_CHORDPRO),
  );
  const [previewFormat, setPreviewFormat] = useState<PreviewFormat>('html');
  const [transpose, setTranspose] = useState<number>(0);

  // Persist the chosen input format in the URL hash so a reload
  // lands on the same editor.
  useEffect(() => {
    writeFormatHash(inputFormat);
  }, [inputFormat]);

  // Keep both source seeds in module-scope state across format
  // swaps — switching to iRealb and back should not reset the
  // ChordPro draft, and vice versa.
  const [chordProSource] = useState<string>(SAMPLE_CHORDPRO);
  const [irealbSource] = useState<string>(SAMPLE_IREALB);

  const formatSelectId = useId();
  const inputFormatSelectId = useId();

  const seed = useMemo(
    () => (inputFormat === 'chordpro' ? chordProSource : irealbSource),
    [inputFormat, chordProSource, irealbSource],
  );

  return (
    <div className="chordsketch-app">
      <header className="chordsketch-app__header">
        <h1 className="chordsketch-app__title">
          <span className="chordsketch-app__brand-mark" aria-hidden="true" />
          <span>ChordSketch Playground</span>
        </h1>
        <div className="chordsketch-app__controls">
          <label
            htmlFor={formatSelectId}
            className="chordsketch-app__control-label"
          >
            Format
            <select
              id={formatSelectId}
              className="chordsketch-app__select"
              value={previewFormat}
              onChange={(e) =>
                setPreviewFormat(e.currentTarget.value as PreviewFormat)
              }
              disabled={inputFormat === 'irealb'}
            >
              <option value="html">HTML</option>
              <option value="text">Text</option>
              <option value="pdf">PDF</option>
            </select>
          </label>
          <Transpose
            className="chordsketch-app__transpose"
            value={transpose}
            onChange={setTranspose}
            label="Transpose"
          />
          <label
            htmlFor={inputFormatSelectId}
            className="chordsketch-app__control-label"
          >
            Input
            <select
              id={inputFormatSelectId}
              className="chordsketch-app__select"
              value={inputFormat}
              onChange={(e) =>
                setInputFormat(e.currentTarget.value as InputFormat)
              }
            >
              <option value="chordpro">ChordPro</option>
              <option value="irealb">iRealb</option>
            </select>
          </label>
        </div>
      </header>

      {inputFormat === 'chordpro' ? (
        <ChordProPane
          key="chordpro"
          initialValue={seed}
          format={previewFormat}
          transpose={transpose}
          onChange={() => {
            /* draft persistence is a future follow-up. */
          }}
        />
      ) : (
        <IrealbPane
          key="irealb"
          initialValue={seed}
          onChange={() => {
            /* draft persistence is a future follow-up. */
          }}
        />
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
