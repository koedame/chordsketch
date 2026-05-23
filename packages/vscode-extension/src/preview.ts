/**
 * WebView preview panel for ChordPro files.
 *
 * Manages a `vscode.WebviewPanel` that renders the active ChordPro document as
 * HTML using `@chordsketch/wasm` loaded in the WebView context. Updates are
 * debounced at 300 ms to avoid flooding the WASM renderer on every keystroke.
 *
 * Panel state (transpose offset, source document URI) is persisted via the
 * WebView's `vscode.setState` API so that preview tabs are restored across
 * VS Code restarts by [`ChordSketchPreviewSerializer`].
 */

import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as path from 'path';
import { escapeHtmlAttr, parseSerializedState } from './preview-helpers.js';
import { setCapoInSource } from './capo-edit.js';

/** Message types sent from the extension host to the WebView. */
type ExtToWebview = { type: 'update'; text: string } | { type: 'transpose'; delta: 1 | -1 };

/** Message types received from the WebView in the extension host. */
type WebviewToExt =
  | { type: 'ready' }
  | { type: 'error'; message: string }
  | { type: 'warning'; message: string }
  | { type: 'edit-capo'; capo: number };

/**
 * Type guard for messages received from the WebView.
 *
 * Validates the shape of `raw` before casting to `WebviewToExt` so that
 * field accesses are safe even if the WebView sends a malformed message.
 */
function isWebviewToExt(raw: unknown): raw is WebviewToExt {
  if (typeof raw !== 'object' || raw === null) {
    return false;
  }
  const r = raw as Record<string, unknown>;
  if (r['type'] === 'ready') {
    return true;
  }
  if (r['type'] === 'error' || r['type'] === 'warning') {
    return typeof r['message'] === 'string';
  }
  if (r['type'] === 'edit-capo') {
    return typeof r['capo'] === 'number' && Number.isFinite(r['capo']);
  }
  return false;
}

/** Debounce delay in milliseconds. */
const DEBOUNCE_MS = 300;

/** WebView-panel `viewType` identifier — also the key under which VS Code
 *  looks up the registered serializer. */
export const PREVIEW_VIEW_TYPE = 'chordsketchPreview';

/** Tracks all open preview panels keyed by document URI string. */
const panels = new Map<string, PreviewPanel>();

/**
 * Opens or reveals the preview panel for the given document.
 *
 * If a panel already exists for the document it is revealed; otherwise a new
 * panel is created in the specified view column.
 */
export function createOrShow(
  context: vscode.ExtensionContext,
  document: vscode.TextDocument,
  column: vscode.ViewColumn,
): void {
  const key = document.uri.toString();
  const existing = panels.get(key);
  if (existing) {
    existing.reveal(column);
    return;
  }
  const panel = PreviewPanel.createNew(context, document, column);
  panels.set(key, panel);
}

/**
 * Notifies all open preview panels about a document change.
 * Called from the `onDidChangeTextDocument` handler in `extension.ts`.
 */
export function notifyDocumentChanged(event: vscode.TextDocumentChangeEvent): void {
  const key = event.document.uri.toString();
  const panel = panels.get(key);
  if (panel) {
    panel.scheduleUpdate(event.document.getText());
  }
}

/**
 * Sends a transpose delta to the preview panel for the given document URI.
 *
 * Looks up the panel by URI string (the key used in `panels`). No-op if no
 * panel is currently open for that document — the command degrades gracefully
 * when no preview is open.
 */
export function notifyTranspose(documentUri: string, delta: 1 | -1): void {
  const panel = panels.get(documentUri);
  if (panel) {
    panel.transpose(delta);
  }
}

/** Disposes all open preview panels. Called on extension deactivation. */
export function disposeAll(): void {
  for (const panel of panels.values()) {
    panel.dispose();
  }
  panels.clear();
}

/**
 * Builds the `WebviewPanelSerializer` invoked on VS Code restart.
 *
 * On deserialization the source `vscode.TextDocument` is looked up via the
 * persisted `documentUri`; if the document is no longer available (file
 * moved or deleted) the panel renders a friendly message and is left open
 * so the user can close it without error.
 *
 * Exposed as a separate factory so integration tests can invoke
 * `deserializeWebviewPanel` directly with a fabricated panel and state —
 * VS Code's extension host has no way to trigger the real restart
 * lifecycle inside a single test run, and the serializer instance
 * returned by `registerWebviewPanelSerializer` is not accessible once
 * it's been handed off.
 */
export function createPreviewSerializer(
  context: vscode.ExtensionContext,
): vscode.WebviewPanelSerializer {
  return {
    async deserializeWebviewPanel(panel: vscode.WebviewPanel, state: unknown): Promise<void> {
      const parsed = parseSerializedState(state);
      if (!parsed) {
        renderUnavailableMessage(
          panel,
          'The previewed document could not be determined from the restored state.',
        );
        return;
      }

      let documentUri: vscode.Uri;
      try {
        documentUri = vscode.Uri.parse(parsed.documentUri, /* strict */ true);
      } catch {
        renderUnavailableMessage(
          panel,
          `Could not parse the restored preview source URI: ${parsed.documentUri}`,
        );
        return;
      }

      let document: vscode.TextDocument;
      try {
        document = await vscode.workspace.openTextDocument(documentUri);
      } catch {
        renderUnavailableMessage(
          panel,
          `The file previously previewed could no longer be opened:\n${documentUri.fsPath}`,
        );
        return;
      }

      // Make sure localResourceRoots still matches the extension install path —
      // VS Code restores the panel options but we re-apply to stay safe.
      panel.webview.options = {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview')],
      };

      PreviewPanel.restore(context, document, panel);
    },
  };
}

/**
 * Registers the preview-panel serializer with VS Code so preview tabs
 * survive restarts. Call once from `activate()`; the returned
 * `Disposable` must be pushed onto the extension context subscriptions
 * so the serializer is unregistered at deactivation.
 *
 * The restoration logic itself lives in [`createPreviewSerializer`].
 */
export function registerPreviewSerializer(context: vscode.ExtensionContext): vscode.Disposable {
  return vscode.window.registerWebviewPanelSerializer(
    PREVIEW_VIEW_TYPE,
    createPreviewSerializer(context),
  );
}

function renderUnavailableMessage(panel: vscode.WebviewPanel, message: string): void {
  panel.webview.options = { enableScripts: false };
  // Reuse the same escape routine as `<meta>` attribute injection. Running
  // the attribute-level escape on body content is safe (and strictly
  // stronger than strictly necessary): it escapes `&`, `<`, `>`, `"`, `'`,
  // none of which can re-introduce markup when written into a `<p>` text
  // node. Line breaks in the input become `<br>` so multi-line messages
  // stay readable.
  const escaped = escapeHtmlAttr(message).replace(/\n/g, '<br>');
  panel.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
  <title>ChordSketch Preview</title>
  <style>
    body {
      font-family: var(--vscode-font-family, sans-serif);
      padding: 1.5rem;
      color: var(--vscode-descriptionForeground, #888);
      line-height: 1.5;
    }
  </style>
</head>
<body>
  <p>${escaped}</p>
  <p>You can close this tab safely.</p>
</body>
</html>`;
}

/** Manages a single WebView preview panel for one ChordPro document. */
class PreviewPanel {
  private readonly panel: vscode.WebviewPanel;
  private readonly context: vscode.ExtensionContext;
  private readonly document: vscode.TextDocument;
  private debounceTimer: NodeJS.Timeout | undefined;
  private pendingText: string | undefined;
  /** Lazily created output channel for surfacing render errors from this panel. */
  private outputChannel: vscode.OutputChannel | undefined;
  /** Set to true once the panel is disposed so stale timer callbacks are no-ops. */
  private disposed = false;

  private constructor(
    context: vscode.ExtensionContext,
    document: vscode.TextDocument,
    panel: vscode.WebviewPanel,
  ) {
    this.context = context;
    this.document = document;
    this.panel = panel;

    // `buildHtml` is called on every (re)attach so the injected
    // `<meta name="chordsketch-document-uri">` matches this instance's
    // document; the WebView persists the URI via `vscode.setState` on
    // startup so the serializer can find it after a restart.
    this.panel.webview.html = this.buildHtml();
    this.wireMessageHandling();
    this.wireDisposal();
  }

  /** Creates a fresh panel for `document` and displays it in `column`. */
  static createNew(
    context: vscode.ExtensionContext,
    document: vscode.TextDocument,
    column: vscode.ViewColumn,
  ): PreviewPanel {
    const fileName = path.basename(document.uri.fsPath);
    const panel = vscode.window.createWebviewPanel(
      PREVIEW_VIEW_TYPE,
      `Preview: ${fileName}`,
      column,
      {
        enableScripts: true,
        // Restrict the WebView to loading resources only from dist/webview/.
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview')],
        // Retain context across hide/show cycles (Phase A simplicity).
        retainContextWhenHidden: true,
      },
    );
    return new PreviewPanel(context, document, panel);
  }

  /**
   * Reattaches to a `vscode.WebviewPanel` handed back by VS Code's
   * `WebviewPanelSerializer`. The panel already exists — we rebuild its HTML
   * and re-register message and dispose handlers.
   */
  static restore(
    context: vscode.ExtensionContext,
    document: vscode.TextDocument,
    panel: vscode.WebviewPanel,
  ): PreviewPanel {
    const restored = new PreviewPanel(context, document, panel);
    panels.set(document.uri.toString(), restored);
    return restored;
  }

  private wireMessageHandling(): void {
    this.panel.webview.onDidReceiveMessage((raw: unknown) => {
      if (this.disposed) {
        return;
      }
      if (!isWebviewToExt(raw)) {
        // Unknown or malformed message — silently ignore.
        return;
      }
      if (raw.type === 'ready') {
        // WebView is ready — send the current document content.
        this.sendUpdate(this.document.getText());
      } else if (raw.type === 'error') {
        // The WebView surfaces render errors; they are also displayed inline
        // in the panel so we only log here and don't show a notification.
        // The channel lifetime tracks this panel — disposed in onDidDispose (tab
        // close) and in dispose() (extension deactivation via disposeAll()).
        if (!this.outputChannel) {
          this.outputChannel = vscode.window.createOutputChannel('ChordSketch Preview');
        }
        this.outputChannel.appendLine(`Preview render error: ${raw.message}`);
      } else if (raw.type === 'warning') {
        // Non-fatal diagnostics from the WebView (e.g. "corrupt persisted
        // state dropped"). Surface via the same output channel as errors so
        // the user can review them without an intrusive notification.
        if (!this.outputChannel) {
          this.outputChannel = vscode.window.createOutputChannel('ChordSketch Preview');
        }
        this.outputChannel.appendLine(`Preview warning: ${raw.message}`);
      } else if (raw.type === 'edit-capo') {
        // Capo +/− was clicked in the WebView toolbar. Recompute the new
        // document text against the LIVE `TextDocument` (not the snapshot
        // the WebView held when the user clicked) so concurrent edits in
        // the editor pane are not clobbered.
        void this.applyCapoEdit(raw.capo);
      }
    });
  }

  /**
   * Rewrites the source document so its `{capo: N}` directive matches
   * `nextCapo`. Applied via `WorkspaceEdit` against the live
   * `TextDocument`; the resulting `onDidChangeTextDocument` echoes a
   * fresh `update` message back to the WebView through the regular
   * debounced path.
   */
  private async applyCapoEdit(nextCapo: number): Promise<void> {
    if (this.disposed) return;
    const current = this.document.getText();
    const updated = setCapoInSource(current, nextCapo);
    if (updated === current) return;
    const edit = new vscode.WorkspaceEdit();
    const fullRange = new vscode.Range(
      this.document.positionAt(0),
      this.document.positionAt(current.length),
    );
    edit.replace(this.document.uri, fullRange, updated);
    await vscode.workspace.applyEdit(edit);
  }

  private wireDisposal(): void {
    // Remove this panel from the map when the user closes it, and clean up
    // associated resources immediately so they do not outlive the panel tab.
    // Setting disposed=true before clearTimeout guards against a stale timer
    // callback that may already be queued when onDidDispose fires.
    this.panel.onDidDispose(() => {
      this.disposed = true;
      panels.delete(this.document.uri.toString());
      if (this.debounceTimer !== undefined) {
        clearTimeout(this.debounceTimer);
        this.debounceTimer = undefined;
      }
      this.outputChannel?.dispose();
      this.outputChannel = undefined;
    });
  }

  /** Reveals the panel in the given column (no-op if already visible). */
  reveal(column: vscode.ViewColumn): void {
    this.panel.reveal(column);
  }

  /**
   * Schedules a debounced update with new document text.
   * Clears any pending timer before setting a new one.
   */
  scheduleUpdate(text: string): void {
    this.pendingText = text;
    if (this.debounceTimer !== undefined) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      if (this.pendingText !== undefined && !this.disposed) {
        this.sendUpdate(this.pendingText);
        this.pendingText = undefined;
      }
    }, DEBOUNCE_MS);
  }

  /** Sends an update message to the WebView immediately. */
  private sendUpdate(text: string): void {
    const msg: ExtToWebview = { type: 'update', text };
    void this.panel.webview.postMessage(msg);
  }

  /**
   * Sends a transpose delta to the WebView.
   *
   * The WebView applies the delta to its own in-memory transpose state (clamped
   * to [−11, +11]) and re-renders. No-op if the panel is already disposed.
   */
  transpose(delta: 1 | -1): void {
    if (this.disposed) {
      return;
    }
    const msg: ExtToWebview = { type: 'transpose', delta };
    void this.panel.webview.postMessage(msg);
  }

  /** Disposes the panel, its output channel, and any pending debounce timer. */
  dispose(): void {
    this.disposed = true;
    if (this.debounceTimer !== undefined) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
    this.outputChannel?.dispose();
    this.outputChannel = undefined;
    this.panel.dispose();
  }

  /**
   * Builds the WebView HTML.
   *
   * Uses a CSP nonce to allow only the bundled script. Extension-provided
   * values are injected via `<meta>` elements so the WebView script can read
   * them at runtime:
   *   - `chordsketch-wasm-uri`: the WASM binary URI (VS Code WebView URI)
   *   - `chordsketch-document-uri`: the source-document URI. The WebView
   *     persists this via `vscode.setState` on startup so that
   *     [`registerPreviewSerializer`] can reopen the correct document after
   *     a VS Code restart.
   *
   * A `data-` attribute on `<script type="module">` cannot be used because
   * `document.currentScript` is always `null` for ES module scripts (HTML spec).
   *
   * The body itself is a single `<div id="app">` root that the React entry
   * (`webview/preview.tsx`) mounts into via `createRoot`. The bespoke
   * iframe-srcdoc / plain-text dual-pane HTML the WebView used pre-#2527
   * is retired in favour of the `<ChordProPreview>` component from
   * `@chordsketch/react`, which renders the AST directly without an
   * intermediate iframe (per ADR-0017).
   */
  private buildHtml(): string {
    const webview = this.panel.webview;

    // Stable random nonce for this session (regenerated on each HTML build).
    const nonce = crypto.randomBytes(16).toString('hex');

    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', 'preview.js'),
    );
    const wasmUri = webview.asWebviewUri(
      vscode.Uri.joinPath(
        this.context.extensionUri,
        'dist',
        'webview',
        'chordsketch_wasm_bg.wasm',
      ),
    );

    // Escape EVERY interpolated value in the HTML template, even those
    // derived from VS Code internals (`wasmUri.toString()`,
    // `scriptUri.toString()`, `webview.cspSource`, the crypto-generated
    // `nonce`). VS Code's own values are well-formed today, but applying
    // the escape symmetrically defends against any future drift in
    // either VS Code's behaviour or our derivation logic — per
    // `.claude/rules/sanitizer-security.md` §"Security Asymmetry".
    const documentUriAttr = escapeHtmlAttr(this.document.uri.toString());
    const wasmUriAttr = escapeHtmlAttr(wasmUri.toString());
    const scriptUriAttr = escapeHtmlAttr(scriptUri.toString());
    const nonceAttr = escapeHtmlAttr(nonce);
    // cspSource includes the extension's own dist/webview/ origin.
    const cspAttr = escapeHtmlAttr(webview.cspSource);

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="
    default-src 'none';
    script-src 'nonce-${nonceAttr}' 'wasm-unsafe-eval';
    style-src ${cspAttr} 'unsafe-inline';
    img-src ${cspAttr} data:;
    font-src ${cspAttr};
    connect-src ${cspAttr};
  ">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="chordsketch-wasm-uri" content="${wasmUriAttr}">
  <meta name="chordsketch-document-uri" content="${documentUriAttr}">
  <title>ChordSketch Preview</title>
  <style>
    /* Minimal host shell — every visual style for the preview itself
       lives in @chordsketch/react/styles.css (bundled into preview.js)
       so VS Code, the playground, and the desktop app share the same
       look. The rules below only own the WebView body framing and the
       fallback / error states the entry component renders before the
       React tree mounts. */
    html, body { height: 100%; margin: 0; padding: 0; }
    body {
      font-family: var(--vscode-font-family, sans-serif);
      color: var(--vscode-foreground, #ccc);
      background: var(--vscode-editor-background, #1e1e1e);
    }
    #app { height: 100vh; display: flex; flex-direction: column; }
    #app > .chordsketch-chord-pro-preview {
      flex: 1;
      min-height: 0;
      display: flex;
      flex-direction: column;
    }
    /* The VS Code preview only renders HTML; the Format <select>
       rendered by @chordsketch/react's <ChordProPreview> header is
       hidden so the toolbar shows just the Transpose control. */
    #app .chordsketch-chord-pro-preview__control-label { display: none; }
    .cs-vscode-loading {
      padding: 1rem;
      color: var(--vscode-descriptionForeground, #888);
      font-style: italic;
    }
    .cs-vscode-error,
    .cs-vscode-render-error {
      padding: 0.75rem 1rem;
      background: var(--vscode-inputValidation-errorBackground, #f2dede);
      border-left: 4px solid var(--vscode-inputValidation-errorBorder, #c00);
      color: var(--vscode-inputValidation-errorForeground, #c00);
      font-size: 0.875rem;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .cs-vscode-error-message { margin-bottom: 0.75rem; }
    .cs-vscode-error-reload {
      font-family: inherit;
      font-size: 0.875rem;
      padding: 0.35rem 0.75rem;
      border: 1px solid var(--vscode-button-border, transparent);
      background: var(--vscode-button-background, #0e639c);
      color: var(--vscode-button-foreground, #fff);
      cursor: pointer;
      border-radius: 2px;
    }
    .cs-vscode-error-reload:hover {
      background: var(--vscode-button-hoverBackground, #1177bb);
    }
    .cs-vscode-error-reload:focus-visible {
      outline: 1px solid var(--vscode-focusBorder, #007fd4);
      outline-offset: 1px;
    }
  </style>
</head>
<body>
  <div id="app"></div>
  <script nonce="${nonceAttr}" src="${scriptUriAttr}" type="module"></script>
</body>
</html>`;
  }
}

