/**
 * Integration test: `WebviewPanelSerializer` restart round-trip.
 *
 * Regression gate for the serializer follow-up issue spun out of #1918.
 * VS Code persists a JSON state object per open WebView panel and, on
 * the next launch, hands that state back to the registered
 * `WebviewPanelSerializer`. If the extension's deserializer silently
 * ignores the source-document URI, users see a blank preview every
 * time they reopen VS Code.
 *
 * The extension-host test runner cannot trigger a real restart inside a
 * single test run, so this test instead calls the serializer's
 * `deserializeWebviewPanel` callback directly with a fabricated panel
 * and a state object identical to what VS Code would persist.
 * `preview.ts` exposes the serializer via the `createPreviewSerializer`
 * factory for exactly this purpose — the function returned to VS Code
 * by `registerPreviewSerializer` is otherwise unreachable from tests.
 *
 * What the test asserts:
 *
 *   1. A state object with a valid `documentUri` restores the panel
 *      against the intended document (HTML is set, no "unavailable"
 *      message is rendered, the panel remains in its original view
 *      column).
 *   2. A state object whose `documentUri` points at a deleted file
 *      rewrites the panel with the friendly "file could no longer be
 *      opened" message instead of crashing.
 *   3. A malformed state object (missing `documentUri`) renders the
 *      generic "could not be determined" message.
 *
 * Together, these three cases lock the three branches in
 * `createPreviewSerializer` so a future refactor that drops one of
 * them breaks CI.
 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";

import { activateExtension, fixture } from "./helpers.js";

const EXTENSION_ID = "koedame.chordsketch";
// Read from the compiled bundle in `suiteSetup` below rather than
// hard-coding. That way a future rename of `PREVIEW_VIEW_TYPE` in
// `preview.ts` cannot silently drift the test into creating panels
// with the old identifier while the serializer binds to the new one.
let PREVIEW_VIEW_TYPE: string;

/**
 * Build a minimal `ExtensionContext` using the real extension's
 * `extensionUri`. The serializer only reads `extensionUri` directly
 * (for `localResourceRoots`); the inner `PreviewPanel` constructor
 * needs the same field. Other fields are intentionally left empty —
 * VS Code would not allow this on arbitrary API calls, but the
 * serializer and preview constructor never touch them.
 */
function fakeContext(): vscode.ExtensionContext {
  const ext = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(ext, `${EXTENSION_ID} must be installed in the extension-dev host`);
  return {
    extensionUri: ext.extensionUri,
    extensionPath: ext.extensionUri.fsPath,
    subscriptions: [],
  } as unknown as vscode.ExtensionContext;
}

/**
 * Build a disposable webview panel that behaves like one VS Code hands
 * to `deserializeWebviewPanel` on restore. The real VS Code call
 * passes a panel that has already had its viewType + title set; we
 * match that shape with `createWebviewPanel`.
 */
function makePanel(): vscode.WebviewPanel {
  return vscode.window.createWebviewPanel(
    PREVIEW_VIEW_TYPE,
    "Preview (restored)",
    vscode.ViewColumn.Beside,
    { enableScripts: false },
  );
}

suite("preview panel serializer", () => {
  let serializer: vscode.WebviewPanelSerializer;

  suiteSetup(async () => {
    await activateExtension();
    // The extension is bundled as CJS (`dist/extension.js`); `require`
    // returns its `module.exports` directly. `extension.ts` re-exports
    // `createPreviewSerializer` so the integration harness can reach
    // the serializer object that `registerWebviewPanelSerializer`
    // otherwise swallows.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const previewModule = require(
      path.resolve(__dirname, "..", "..", "..", "dist", "extension.js"),
    );
    assert.equal(
      typeof previewModule.createPreviewSerializer,
      "function",
      "dist/extension.js must export createPreviewSerializer — check extension.ts re-export and preview.ts factory",
    );
    assert.equal(
      typeof previewModule.PREVIEW_VIEW_TYPE,
      "string",
      "dist/extension.js must export PREVIEW_VIEW_TYPE — check extension.ts re-export",
    );
    PREVIEW_VIEW_TYPE = previewModule.PREVIEW_VIEW_TYPE;
    serializer = previewModule.createPreviewSerializer(fakeContext());
  });

  test("restores a preview panel with the persisted documentUri", async () => {
    const helloUri = fixture("hello.cho");
    const panel = makePanel();
    try {
      await serializer.deserializeWebviewPanel(panel, {
        documentUri: helloUri.toString(),
      });

      // The preview HTML should reference the document (the serializer
      // builds an HTML body that embeds the fileName in the title and
      // the content in a <pre>/WebView message). We intentionally
      // assert on a substring that the "unavailable" branch never
      // produces, so the happy path is distinguishable from either
      // error branch.
      assert.match(
        panel.webview.html,
        /hello\.cho/i,
        "restored panel HTML should mention the source file name",
      );
      assert.doesNotMatch(
        panel.webview.html,
        /could no longer be opened|could not be determined/i,
        "happy path must not render the unavailable fallback",
      );
    } finally {
      panel.dispose();
    }
  });

  test("falls back to an unavailable message when the source file is gone", async () => {
    // Stage a temporary `.cho`, open it (so VS Code registers the URI as a
    // real resource), then delete it before calling deserialize. The
    // serializer must render the "file no longer opens" message rather
    // than throwing.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "chordsketch-serializer-"));
    const missing = path.join(tmp, "missing.cho");
    fs.writeFileSync(missing, "{title: Missing}\n[C]x\n");
    const missingUri = vscode.Uri.file(missing);
    fs.unlinkSync(missing);
    fs.rmdirSync(tmp);

    const panel = makePanel();
    try {
      await serializer.deserializeWebviewPanel(panel, {
        documentUri: missingUri.toString(),
      });
      assert.match(
        panel.webview.html,
        /could no longer be opened/i,
        "panel should render the 'file could no longer be opened' fallback",
      );
    } finally {
      panel.dispose();
    }
  });

  test("falls back gracefully when the persisted state is malformed", async () => {
    const panel = makePanel();
    try {
      // Missing `documentUri` entirely — parseSerializedState returns
      // undefined and the serializer should render the generic
      // "could not be determined" message.
      await serializer.deserializeWebviewPanel(panel, { somethingElse: 42 });
      assert.match(
        panel.webview.html,
        /could not be determined/i,
        "malformed state should render the 'could not be determined' fallback",
      );
    } finally {
      panel.dispose();
    }
  });

  test("restores a preview for a document with parse errors without crashing", async () => {
    // Regression gate for #2025. ChordPro parse errors are reported as
    // diagnostics by the LSP but do not prevent the preview renderer
    // from producing output — the parser is lenient. The serializer
    // therefore must still take the happy path and embed the filename
    // in the restored HTML even when the source file is deliberately
    // malformed. If a future refactor makes the renderer throw on
    // parse errors, this test fails and the regression is caught
    // before users see a blank preview panel on restart.
    const brokenUri = fixture("broken.cho");
    const panel = makePanel();
    try {
      await serializer.deserializeWebviewPanel(panel, {
        documentUri: brokenUri.toString(),
      });
      assert.match(
        panel.webview.html,
        /broken\.cho/i,
        "restored panel HTML should mention the broken fixture's file name",
      );
      assert.doesNotMatch(
        panel.webview.html,
        /could no longer be opened|could not be determined/i,
        "broken but present file must not render the unavailable fallback",
      );
    } finally {
      panel.dispose();
    }
  });
});
