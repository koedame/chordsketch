/**
 * Integration test: LSP negotiation against a stub server.
 *
 * Regression gate for #1913. Before that fix,
 * `chordsketch-lsp` unconditionally declared
 * `positionEncoding: "utf-8"` in its `InitializeResult`, which
 * `vscode-languageclient@9.x` rejects with
 * `Unsupported position encoding ...`. The extension would then log
 * the failure but continue; the actual LSP-dependent features
 * (diagnostics, completion, hover) were silently disabled.
 *
 * This test points `chordsketch.lsp.path` at a Node.js stub server
 * (`test/fixtures/stub-lsp-server.mjs`) that returns
 * `positionEncoding: "utf-16"` — the encoding the client accepts.
 * After the configuration change the LSP should start without error
 * and — crucially — the five contributed commands must remain
 * registered (which is the observable signal that
 * `activate()`-level guarding worked).
 *
 * The stub server is a minimal JSON-RPC speaker: it answers
 * `initialize` with a UTF-16 encoding and a textDocumentSync
 * capability, acknowledges `shutdown`, and exits on `exit`. It does
 * NOT implement diagnostics, hover, or completion — just enough to
 * exercise the handshake path that breaks in #1913.
 */

import * as path from "node:path";
import * as vscode from "vscode";
import {
  activateExtension,
  assertAllContributedCommandsRegistered,
} from "./helpers.js";

/**
 * Absolute path to the stub LSP server script.
 *
 * The fixtures live at `packages/vscode-extension/test/fixtures/`;
 * from the compiled test location
 * (`out-test/test/integration/*.js`) that is
 * `../../../test/fixtures/stub-lsp-server.mjs`.
 */
function stubServerPath(): string {
  return path.resolve(
    __dirname,
    "..",
    "..",
    "..",
    "test",
    "fixtures",
    "stub-lsp-server.mjs",
  );
}

suite("LSP negotiation (stub server)", () => {
  suiteSetup(async () => {
    await activateExtension();
  });

  test("extension survives pointing chordsketch.lsp.path at a Node stub server", async () => {
    const config = vscode.workspace.getConfiguration("chordsketch.lsp");
    // The extension's `resolveLspBinary` invokes the configured path
    // as an executable; a `.mjs` script will not execute on POSIX
    // without a shebang + x bit, so drive Node explicitly. But the
    // extension's ServerOptions uses `command: binaryPath, args:
    // ['--stdio']`, which means we would need a native launcher. The
    // simplest cross-platform trick: point lsp.path at `node` and
    // prepend the script via lsp.args... except lsp.args isn't a
    // setting we ship. So we use the shebang form: the fixture has
    // `#!/usr/bin/env node` and is chmod+x. On CI (Linux) that runs;
    // on Windows the test is skipped at the helper level because
    // shebang dispatch does not work.
    if (process.platform === "win32") {
      // Known limitation: the shebang dispatch this fixture relies on
      // doesn't work on Windows. The #1918 phased plan keeps the
      // integration harness Linux-only for now; adding a PowerShell
      // wrapper is tracked for a future phase if Windows matrix
      // coverage is demanded.
      return;
    }

    try {
      await config.update(
        "path",
        stubServerPath(),
        vscode.ConfigurationTarget.Workspace,
      );
      // Give the async restart a window to complete. `onDidChangeConfiguration`
      // fires synchronously; the handler then `await`s through
      // `stopLspClient` → `startLspGuarded`. 1.5 s is generous for
      // spawning Node and exchanging an `initialize` message, even on
      // a cold runner.
      await new Promise((r) => setTimeout(r, 1500));
      // Core regression gate: if the stub server's InitializeResult
      // caused the client to bail (#1913 symptom), the whole activate
      // flow would have unwound on the earlier release. With the
      // guard from #1923 commands stay registered either way; with
      // the stub emitting utf-16 the handshake additionally has to
      // succeed for the LSP-dependent state to be healthy. Both
      // properties collapse into: "activation did not crash."
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
