/**
 * Integration test: configuration-driven LSP restart path must not
 * crash activation or de-register commands.
 *
 * Regression gate for the class of bug covered by #1914 and #1917:
 * the `onDidChangeConfiguration` listener in `extension.ts` calls
 * `stopLspClient()` → `startLspGuarded()`. If either step propagates an
 * unhandled error, the extension host would log a crash and subsequent
 * commands would silently stop working. This test toggles the relevant
 * settings and confirms:
 *
 *   1. No exception escapes the configuration-change handler.
 *   2. All five contributed commands remain registered afterwards.
 *
 * It does NOT actually launch `chordsketch-lsp` — the binary is almost
 * certainly absent on CI runners — so the test exercises the
 * "binary-not-found" graceful-degradation branch, which is the specific
 * path that was broken in #1917.
 */

import * as vscode from "vscode";
import {
  activateExtension,
  assertAllContributedCommandsRegistered,
} from "./helpers.js";

suite("LSP configuration restart", () => {
  suiteSetup(async () => {
    await activateExtension();
  });

  test("toggling chordsketch.lsp.enabled does not crash the extension or drop commands", async () => {
    const config = vscode.workspace.getConfiguration("chordsketch.lsp");

    // Flip to false, then back to true. Both transitions go through
    // the same restart path in `onDidChangeConfiguration`.
    try {
      await config.update(
        "enabled",
        false,
        vscode.ConfigurationTarget.Workspace,
      );
      // Give the async handler a chance to run; the event is fired
      // synchronously but the handler's `await` chain yields.
      await new Promise((r) => setTimeout(r, 500));
      await assertAllContributedCommandsRegistered();

      await config.update(
        "enabled",
        true,
        vscode.ConfigurationTarget.Workspace,
      );
      await new Promise((r) => setTimeout(r, 500));
      await assertAllContributedCommandsRegistered();
    } finally {
      // Restore default so test state does not leak across tests.
      await config.update(
        "enabled",
        undefined,
        vscode.ConfigurationTarget.Workspace,
      );
    }
  });

  test("pointing chordsketch.lsp.path at a non-existent binary does not crash the extension", async () => {
    // This exercises the exact code path that failed in #1917:
    //   1. `onDidChangeConfiguration` fires.
    //   2. `stopLspClient()` runs against whatever state the client is in.
    //   3. `startLspGuarded()` → `startLspClient()` → `resolveLspBinary`
    //      returns `undefined` for a path that does not exist.
    //   4. The fallback should log to the notFoundChannel and return
    //      without throwing.
    const config = vscode.workspace.getConfiguration("chordsketch.lsp");
    try {
      await config.update(
        "path",
        "/nonexistent/definitely-no-chordsketch-lsp-here",
        vscode.ConfigurationTarget.Workspace,
      );
      await new Promise((r) => setTimeout(r, 500));
      // Core regression gate: commands must still exist after the
      // non-existent-binary restart path runs.
      await assertAllContributedCommandsRegistered();
    } finally {
      await config.update(
        "path",
        undefined,
        vscode.ConfigurationTarget.Workspace,
      );
    }
  });
});
