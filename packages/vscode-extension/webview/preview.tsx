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
 *
 * Pure state-validation helpers (state shape, type guards, clamping, error
 * formatting) live in [`./preview-state`] so they can be unit-tested
 * without the React mount / `acquireVsCodeApi` global.
 */

import { StrictMode, useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import init from '@chordsketch/wasm';
import { ChordProPreview } from '@chordsketch/react';
// The component library's stylesheet is bundled as a text asset
// (see `esbuild.mjs`'s `.css` loader) and injected at runtime into a
// `<style>` element. The WebView CSP allows `'unsafe-inline'` on
// `style-src` for VS Code's own theme injections, so this is safe.
import chordsketchReactCss from '@chordsketch/react/styles.css';
import {
  clamp,
  formatError,
  isExtToWebview,
  safeGetState,
  safeGetStateWithDiagnostics,
  type PanelState,
} from './preview-state';

/** VS Code WebView API acquired from the global injected by the host. */
declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

const vscode = acquireVsCodeApi();

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

/**
 * Root React component for the preview WebView.
 *
 * Wires the extension-host message protocol and persisted-state lifecycle
 * around a single `<ChordProPreview>` from `@chordsketch/react`. The
 * component renders its own toolbar + preview body — this entry only owns
 * external integration (init, message dispatch, state persistence).
 */
function App(): JSX.Element {
  // Resolve initial state once, surfacing a one-shot warning to the
  // extension host if the persisted blob was non-null but contributed
  // zero validated fields — without the diagnostic, a corrupt persisted
  // state would silently reset to defaults and the user would never know
  // their last-used mode / transpose was discarded.
  const saved = useMemo<PanelState>(() => {
    const { state, corrupt } = safeGetStateWithDiagnostics(vscode.getState());
    if (corrupt) {
      vscode.postMessage({
        type: 'warning',
        message: 'Preview restored with corrupt state; resetting to defaults',
      });
    }
    return state;
  }, []);

  const [source, setSource] = useState<string>('');
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

  // Persist transpose whenever it changes.
  useEffect(() => {
    vscode.setState({
      ...safeGetState(vscode.getState()),
      transpose,
    } satisfies PanelState);
  }, [transpose]);

  // Persist the source-document URI on first mount so the
  // `WebviewPanelSerializer` can reopen this panel against the same
  // `TextDocument` after a VS Code restart.
  useEffect(() => {
    const documentUri = readMetaDocumentUri();
    if (documentUri && documentUri !== safeGetState(vscode.getState()).documentUri) {
      vscode.setState({
        ...safeGetState(vscode.getState()),
        documentUri,
      } satisfies PanelState);
    }
  }, []);

  const handleTransposeChange = useCallback((next: number) => {
    setTranspose(clamp(next, -11, 11));
  }, []);

  if (initError !== null) {
    return (
      <div className="cs-vscode-error" role="alert">
        <div className="cs-vscode-error-message">{initError}</div>
        <button
          type="button"
          className="cs-vscode-error-reload"
          onClick={() => {
            // Force the WebView to reload itself — the extension host
            // will reissue the same HTML on the next mount, including a
            // fresh wasm URI / nonce. `location.reload()` is permitted
            // by the WebView CSP and avoids needing a host-side
            // round-trip for the common "transient wasm init failure"
            // case (e.g. cold-cache 503).
            window.location.reload();
          }}
        >
          Reload Preview
        </button>
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

  // The VS Code preview only renders HTML — `<ChordProPreview>`'s
  // format `<select>` is hidden via host CSS in `src/preview.ts`.
  return (
    <ChordProPreview
      className="cs-vscode-preview"
      source={source}
      format="html"
      transpose={transpose}
      onTransposeChange={handleTransposeChange}
      formats={['html']}
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
