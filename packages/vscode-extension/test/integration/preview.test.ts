/**
 * Integration test: preview panel creation via `chordsketch.openPreview`
 * and `chordsketch.openPreviewToSide`.
 *
 * Regression gate for #1916 (caller-supplied `ViewColumn` must reach
 * `createWebviewPanel`): a refactor that accidentally hardcoded
 * `ViewColumn.Active` again would cause `openPreviewToSide` to land in
 * the same column as the source document instead of the beside column,
 * which this test detects via `webviewPanel.viewColumn`.
 *
 * The test only observes the panel lifecycle — it does not drive the
 * WebView script or assert rendered preview content (the WASM bundle
 * runs inside a sandboxed iframe and is not reachable from the extension
 * host). See issue #1918 for the phased plan.
 */

import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import { activateExtension, fixture } from "./helpers.js";

const OPEN_PREVIEW = "chordsketch.openPreview";
const OPEN_PREVIEW_TO_SIDE = "chordsketch.openPreviewToSide";
const PREVIEW_VIEW_TYPE = "chordsketchPreview";

/**
 * Poll until the tab group surface reports a webview tab of the expected
 * type. Returns the tab once seen; rejects with a descriptive error on
 * timeout. VS Code creates the panel asynchronously, so a bounded poll
 * is more robust than a one-shot read.
 */
async function waitForPreviewTab(timeoutMs = 10_000): Promise<vscode.Tab> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const input = tab.input;
        if (
          input instanceof vscode.TabInputWebview &&
          input.viewType.endsWith(PREVIEW_VIEW_TYPE)
        ) {
          return tab;
        }
      }
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(
    `no ChordSketch preview tab appeared within ${timeoutMs} ms`,
  );
}

/** Close every preview tab so tests do not pollute each other. */
async function closeAllPreviewTabs(): Promise<void> {
  const toClose: vscode.Tab[] = [];
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const input = tab.input;
      if (
        input instanceof vscode.TabInputWebview &&
        input.viewType.endsWith(PREVIEW_VIEW_TYPE)
      ) {
        toClose.push(tab);
      }
    }
  }
  if (toClose.length > 0) {
    await vscode.window.tabGroups.close(toClose);
  }
}

suite("preview panel", () => {
  suiteSetup(async () => {
    await activateExtension();
  });

  setup(async () => {
    await closeAllPreviewTabs();
    // Start from a known state: close every non-preview tab, then open the
    // fixture fresh in column 1. Uses `showTextDocument` with an explicit
    // column so subsequent preview-to-side lands predictably.
    const doc = await vscode.workspace.openTextDocument(fixture("hello.cho"));
    await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
  });

  teardown(async () => {
    await closeAllPreviewTabs();
  });

  test("openPreview lands in the active column (same as source)", async () => {
    await vscode.commands.executeCommand(OPEN_PREVIEW);
    const tab = await waitForPreviewTab();
    // With no beside split, Active resolves to column 1 — the column
    // the source document sits in. The panel title is also checked as
    // a sanity guard.
    assert.equal(
      tab.group.viewColumn,
      vscode.ViewColumn.One,
      `openPreview must land in the active column (got ${tab.group.viewColumn})`,
    );
    assert.ok(
      tab.label.toLowerCase().includes("hello"),
      `preview tab label should reference the source fixture; got: ${tab.label}`,
    );
  });

  test("openPreviewToSide lands in a column beside the source, not on top of it", async () => {
    // Regression gate for #1916: the caller-supplied `ViewColumn.Beside`
    // must propagate through `createOrShow` → `PreviewPanel.createNew`
    // → `vscode.window.createWebviewPanel`. A hardcoded
    // `ViewColumn.Active` would land the preview on top of the source
    // and cause the briefly-visible flash reported in the issue.
    await vscode.commands.executeCommand(OPEN_PREVIEW_TO_SIDE);
    const tab = await waitForPreviewTab();
    assert.notEqual(
      tab.group.viewColumn,
      vscode.ViewColumn.One,
      "openPreviewToSide must land in a column OTHER than the source column",
    );
    // The preview must land in a real, user-visible column — not the
    // sentinel `ViewColumn.Beside` (-2, which VS Code only uses at
    // reveal time to mean "pick something beside") or any other
    // non-positive value. `viewColumn` is typed as a number enum at
    // compile time so only the lower-bound check is load-bearing.
    assert.ok(
      tab.group.viewColumn >= 1,
      `preview must have a positive ViewColumn; got ${tab.group.viewColumn}`,
    );
  });

  test("repeated openPreviewToSide re-reveals the existing panel instead of opening a duplicate", async () => {
    // The `createOrShow` helper in `preview.ts` keeps one panel per
    // document URI. Invoking the command twice must not leave two
    // preview tabs in the workspace.
    await vscode.commands.executeCommand(OPEN_PREVIEW_TO_SIDE);
    await waitForPreviewTab();
    // Second invocation: no `waitForPreviewTab` needed. `createOrShow`
    // detects the existing panel and calls `existing.reveal(column)`
    // synchronously — no new async panel-creation work is queued, so
    // the tab count is already stable by the time `executeCommand`
    // resolves. A poll here would obscure that invariant.
    await vscode.commands.executeCommand(OPEN_PREVIEW_TO_SIDE);

    // Count preview tabs across every group.
    let previewTabs = 0;
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (
          tab.input instanceof vscode.TabInputWebview &&
          tab.input.viewType.endsWith(PREVIEW_VIEW_TYPE)
        ) {
          previewTabs += 1;
        }
      }
    }
    assert.equal(
      previewTabs,
      1,
      `exactly one preview tab must exist for the same document; found ${previewTabs}`,
    );
  });
});
