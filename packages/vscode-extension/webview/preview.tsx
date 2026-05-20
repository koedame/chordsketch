/**
 * WebView-side React entry point for the ChordSketch preview panel.
 *
 * Runs in the sandboxed WebView context (browser environment). Initialises
 * the `@chordsketch/wasm` module once using the binary URI provided by the
 * extension host via `<meta name="chordsketch-wasm-uri">`, then mounts a
 * single `<ChordProPreview>` component from `@chordsketch/react`.
 *
 * Prior to #2527 / #2528 this file was a bespoke vanilla-TS implementation
 * (~487 lines) that managed an iframe-srcdoc HTML view, plain-text view,
 * and toolbar by hand. The retire-bespoke cut-over per
 * [ADR-0017](../../../docs/adr/0017-react-renders-from-ast.md) hands rendering
 * to the React component library so VS Code, the playground, and the desktop
 * app all share the same preview surface.
 *
 * The WebView still owns the lifecycle wiring — message protocol with the
 * extension host, persisted state (view mode + transpose + source-document
 * URI) via `vscode.setState`, and the one-shot wasm init — but everything
 * inside the `<div id="app">` element is React-driven.
 */

import { StrictMode, useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import init from '@chordsketch/wasm';
import { ChordProPreview, type PreviewFormat } from '@chordsketch/react';
// The component library's stylesheet is bundled as a text asset
// (see `esbuild.mjs`'s `.css` loader) and injected at runtime into a
// `<style>` element. The WebView CSP allows `'unsafe-inline'` on
// `style-src` for VS Code's own theme injections, so this is safe.
import chordsketchReactCss from '@chordsketch/react/styles.css';

/** VS Code WebView API acquired from the global injected by the host. */
declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

const vscode = acquireVsCodeApi();

/** View mode for the preview panel. */
type ViewMode = 'html' | 'text';

/** Persisted panel state saved and restored via the VS Code WebView API. */
interface PanelState {
  mode?: ViewMode;
  /** Semitone transposition offset; clamped to [-11, +11]. */
  transpose?: number;
  /**
   * URI string of the source document this panel is previewing.
   *
   * Written on first run so that VS Code's `WebviewPanelSerializer` can look
   * up the document when restoring the panel after a restart. See
   * `registerPreviewSerializer` in `../src/preview.ts`.
   */
  documentUri?: string;
}

/** Message types received from the extension host. */
type ExtToWebview =
  | { type: 'update'; text: string }
  | { type: 'transpose'; delta: 1 | -1 };

/**
 * Type guard for messages received from the extension host.
 *
 * Validates the shape of `event.data` before field access so that unknown
 * or malformed messages are silently ignored rather than causing TypeErrors.
 */
function isExtToWebview(raw: unknown): raw is ExtToWebview {
  if (typeof raw !== 'object' || raw === null) {
    return false;
  }
  const r = raw as Record<string, unknown>;
  if (r['type'] === 'update') {
    return typeof r['text'] === 'string';
  }
  if (r['type'] === 'transpose') {
    return r['delta'] === 1 || r['delta'] === -1;
  }
  return false;
}

/**
 * Formats a thrown value into a readable error message.
 *
 * Prefers `.message` from Error instances to avoid `[object Object]` on
 * structured JsError objects with line/col info — mirrors the same helper
 * inside `packages/ui-web/src/index.ts` (see #1060, #1087).
 */
function formatError(e: unknown): string {
  if (e instanceof Error) {
    return e.message;
  }
  return String(e);
}

/**
 * Returns a validated copy of the persisted WebView state.
 *
 * `vscode.getState()` returns `unknown`; this function narrows the result to a
 * well-typed `PanelState` with each field individually validated, so that a
 * corrupted or forward-incompatible stored value cannot bypass type-level checks.
 */
function safeGetState(): PanelState {
  const raw = vscode.getState() as Record<string, unknown> | null;
  const result: PanelState = {};
  if (raw?.['mode'] === 'html' || raw?.['mode'] === 'text') {
    result.mode = raw['mode'] as ViewMode;
  }
  if (typeof raw?.['transpose'] === 'number' && Number.isFinite(raw['transpose'])) {
    result.transpose = Math.max(-11, Math.min(11, raw['transpose'] as number));
  }
  if (typeof raw?.['documentUri'] === 'string' && raw['documentUri'].length > 0) {
    result.documentUri = raw['documentUri'];
  }
  return result;
}

/** Reads the host-injected default-mode `<meta>` element. */
function readMetaDefaultMode(): ViewMode | undefined {
  const meta = document.querySelector<HTMLMetaElement>(
    'meta[name="chordsketch-default-mode"]',
  );
  const value = meta?.content;
  return value === 'html' || value === 'text' ? value : undefined;
}

/** Reads the host-injected document-URI `<meta>` element. */
function readMetaDocumentUri(): string | undefined {
  const meta = document.querySelector<HTMLMetaElement>(
    'meta[name="chordsketch-document-uri"]',
  );
  const value = meta?.content;
  return value && value.length > 0 ? value : undefined;
}

/** Reads the host-injected wasm-binary URI `<meta>` element. */
function readMetaWasmUri(): string | undefined {
  const meta = document.querySelector<HTMLMetaElement>(
    'meta[name="chordsketch-wasm-uri"]',
  );
  const value = meta?.content;
  return value && value.length > 0 ? value : undefined;
}

/** Clamps `n` into the inclusive `[lo, hi]` range. */
function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Root React component for the preview WebView.
 *
 * Wires the extension-host message protocol and persisted-state lifecycle
 * around a single `<ChordProPreview>` from `@chordsketch/react`. The
 * component renders its own toolbar + preview body — this entry only owns
 * external integration (init, message dispatch, state persistence).
 */
function App(): JSX.Element {
  const saved = useMemo(() => safeGetState(), []);
  const initialMode: ViewMode = saved.mode ?? readMetaDefaultMode() ?? 'html';

  const [source, setSource] = useState<string>('');
  const [format, setFormat] = useState<PreviewFormat>(initialMode);
  const [transpose, setTranspose] = useState<number>(saved.transpose ?? 0);
  const [wasmReady, setWasmReady] = useState<boolean>(false);
  const [initError, setInitError] = useState<string | null>(null);

  // Initialise wasm once with the host-provided binary URI.
  //
  // `@chordsketch/wasm`'s `default()` (a.k.a. `init`) is idempotent —
  // subsequent calls (including those made by React's `useChordRender`
  // and `useChordproAst` default loaders) return immediately. We pre-init
  // here with the explicit URI so the in-tree dynamic-import loaders
  // do not have to guess the binary location from `import.meta.url`.
  useEffect(() => {
    let cancelled = false;
    const wasmUri = readMetaWasmUri();
    const promise = wasmUri ? init(wasmUri) : init();
    promise.then(
      () => {
        if (!cancelled) {
          setWasmReady(true);
        }
      },
      (e: unknown) => {
        if (cancelled) return;
        const message = `Failed to initialize ChordSketch WASM: ${formatError(e)}`;
        setInitError(message);
        vscode.postMessage({ type: 'error', message });
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  // Register the extension-host message listener and announce readiness.
  //
  // The listener is set up eagerly (before wasm finishes loading) so a
  // `transpose` message sent in the narrow window between panel creation
  // and wasm readiness is not silently dropped — `setTranspose` mutates
  // React state and the first render after `wasmReady` flips picks up
  // the updated value.
  useEffect(() => {
    function onMessage(event: MessageEvent): void {
      if (!isExtToWebview(event.data)) {
        // Unknown or malformed message — silently ignore.
        return;
      }
      const data = event.data;
      if (data.type === 'update') {
        setSource(data.text);
      } else if (data.type === 'transpose') {
        setTranspose((prev) => clamp(prev + data.delta, -11, 11));
      }
    }
    window.addEventListener('message', onMessage);
    vscode.postMessage({ type: 'ready' });
    return () => {
      window.removeEventListener('message', onMessage);
    };
  }, []);

  // Persist mode + transpose whenever they change. The `formats`
  // allowlist below restricts `format` to `html` / `text`, so the
  // narrowing here is a defensive consistency check rather than a
  // user-visible code path — `pdf` is excluded from the selector.
  useEffect(() => {
    const modeForState: ViewMode | undefined =
      format === 'html' || format === 'text' ? format : undefined;
    vscode.setState({
      ...safeGetState(),
      mode: modeForState,
      transpose,
    } satisfies PanelState);
  }, [format, transpose]);

  // Persist the source-document URI on first mount so the
  // `WebviewPanelSerializer` can reopen this panel against the same
  // `TextDocument` after a VS Code restart.
  useEffect(() => {
    const documentUri = readMetaDocumentUri();
    if (documentUri && documentUri !== safeGetState().documentUri) {
      vscode.setState({ ...safeGetState(), documentUri } satisfies PanelState);
    }
  }, []);

  const handleFormatChange = useCallback((next: PreviewFormat) => {
    // Only `html` / `text` are configured in the `formats` allowlist below,
    // but `PreviewFormat` itself includes `pdf` — narrow defensively.
    if (next === 'html' || next === 'text') {
      setFormat(next);
    }
  }, []);

  const handleTransposeChange = useCallback((next: number) => {
    setTranspose(clamp(next, -11, 11));
  }, []);

  if (initError !== null) {
    return (
      <div className="cs-vscode-error" role="alert">
        {initError}
      </div>
    );
  }

  if (!wasmReady) {
    return (
      <div className="cs-vscode-loading" aria-busy="true">
        Initializing ChordSketch preview…
      </div>
    );
  }

  // VS Code's `convertToPdf` command exports PDFs through a separate code
  // path in the extension host, so the in-pane PDF format is intentionally
  // excluded from the format selector here.
  return (
    <ChordProPreview
      className="cs-vscode-preview"
      source={source}
      format={format}
      onFormatChange={handleFormatChange}
      transpose={transpose}
      onTransposeChange={handleTransposeChange}
      formats={['html', 'text']}
      errorFallback={(err) => (
        <div className="cs-vscode-render-error" role="alert">
          {err.message}
        </div>
      )}
    />
  );
}

/** Injects the bundled `@chordsketch/react` stylesheet into a `<style>` tag. */
function injectChordsketchReactStyles(): void {
  if (document.getElementById('chordsketch-react-styles') !== null) {
    return;
  }
  const styleEl = document.createElement('style');
  styleEl.id = 'chordsketch-react-styles';
  styleEl.appendChild(document.createTextNode(chordsketchReactCss));
  document.head.appendChild(styleEl);
}

injectChordsketchReactStyles();

const rootEl = document.getElementById('app');
if (rootEl) {
  createRoot(rootEl).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
