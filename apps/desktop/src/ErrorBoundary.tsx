/**
 * Root-level React error boundary for the desktop frontend.
 *
 * Catches uncaught render-phase exceptions in the React tree —
 * e.g. a `createIrealbEditor` failure deep inside
 * `<IrealGridEditor>`, a wasm-init throw during render, or a future
 * component throw — and renders a recovery UI instead of leaving
 * the user staring at a blank Tauri WebView.
 *
 * Forward the caught error to a logging hook (`console.error` plus
 * a native Tauri dialog). The dialog branch is fire-and-forget so a
 * dialog-plugin failure on the failure path does not cascade into a
 * second uncaught throw.
 *
 * The Report button opens the GitHub issues page so a user hitting
 * a hard crash has a one-click path to filing it. The Reload button
 * calls `window.location.reload()` — for a Tauri WebView this is a
 * full webview reload, which re-runs `main.tsx`'s bootstrap.
 *
 * Note: this boundary does NOT catch errors thrown inside event
 * handlers, async callbacks, server-side rendering, or errors
 * thrown by the boundary itself. Those paths must continue to
 * handle their own errors. The boundary is the safety net for
 * uncaught render-phase exceptions only.
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { message } from '@tauri-apps/plugin-dialog';

const REPORT_URL = 'https://github.com/koedame/chordsketch/issues/new';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error('ChordSketch caught a render-phase exception:', error, info);
    // Surface the failure through the native dialog plugin too —
    // a user who has the WebView devtools closed gets feedback
    // immediately. Best-effort: if `message()` itself throws (the
    // dialog plugin is the failure source), we already have the
    // recovery UI rendered below.
    const summary = error.stack ?? error.message;
    message(summary, {
      title: 'ChordSketch encountered an error',
      kind: 'error',
    }).catch(() => {
      // Swallow — the recovery UI is already in place.
    });
  }

  handleReload = (): void => {
    window.location.reload();
  };

  handleReport = (): void => {
    // Anchor `<a>` opens via the WebView; for Tauri the URL is
    // already in the `opener:allow-open-url` allowlist for the
    // project homepage. The issues page lives on the same origin
    // so the same allowlist entry applies (GitHub.com root match
    // includes /issues/new paths).
    window.open(REPORT_URL, '_blank', 'noopener,noreferrer');
  };

  render(): ReactNode {
    const { error } = this.state;
    if (error === null) {
      return this.props.children;
    }

    // Escape via React's default text-node rendering — assigning
    // a string to `{error.message}` does NOT interpret HTML, so a
    // crafted error message cannot inject script tags here.
    return (
      <div
        role="alert"
        style={{
          padding: '2rem',
          maxWidth: '40rem',
          margin: '4rem auto',
          fontFamily:
            "'-apple-system', 'BlinkMacSystemFont', 'Segoe UI', sans-serif",
          color: '#e6e6e6',
          background: '#1f1f1f',
          border: '1px solid #444',
          borderRadius: '0.5rem',
        }}
      >
        <h1 style={{ marginTop: 0 }}>ChordSketch encountered an error</h1>
        <p style={{ whiteSpace: 'pre-wrap', fontFamily: 'ui-monospace, monospace' }}>
          {error.message}
        </p>
        <div style={{ display: 'flex', gap: '0.75rem', marginTop: '1.5rem' }}>
          <button
            type="button"
            onClick={this.handleReload}
            style={{
              padding: '0.5rem 1rem',
              background: '#bd1642',
              color: '#fff',
              border: 'none',
              borderRadius: '0.25rem',
              cursor: 'pointer',
            }}
          >
            Reload
          </button>
          <button
            type="button"
            onClick={this.handleReport}
            style={{
              padding: '0.5rem 1rem',
              background: 'transparent',
              color: '#e6e6e6',
              border: '1px solid #666',
              borderRadius: '0.25rem',
              cursor: 'pointer',
            }}
          >
            Report
          </button>
        </div>
      </div>
    );
  }
}
