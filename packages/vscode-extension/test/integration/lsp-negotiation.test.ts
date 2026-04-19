/**
 * Integration test: LSP negotiation against a stub server.
 *
 * Regression gate for #1913. Before that fix,
 * `chordsketch-lsp` unconditionally declared
 * `positionEncoding: "utf-8"` in its `InitializeResult`, which
 * `vscode-languageclient@9.x` rejects with
 * `Unsupported position encoding ...`. The extension would log the
 * failure and continue; the actual LSP-dependent features
 * (diagnostics, completion, hover) were silently disabled.
 *
 * This test points `chordsketch.lsp.path` at a Node.js stub server
 * (`test/fixtures/stub-lsp-server.mjs`) that returns
 * `positionEncoding: "utf-16"` — the encoding the client accepts.
 * The stub also writes a trace file when `initialize` has been
 * answered, so the test can assert the handshake genuinely succeeded
 * rather than relying on the "extension did not crash" signal alone.
 *
 * The stub is a minimal JSON-RPC speaker: it answers `initialize`
 * with UTF-16 encoding and a textDocumentSync capability, records
 * the event to the trace file, acknowledges `shutdown`, and exits
 * on `exit`. It does NOT implement diagnostics, hover, or
 * completion — just enough to exercise the handshake path that
 * breaks in #1913.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  activateExtension,
  assertAllContributedCommandsRegistered,
  fixture,
} from "./helpers.js";

suite("LSP negotiation (stub server)", () => {
  suiteSetup(async () => {
    await activateExtension();
  });

  test("chordsketch.lsp.path at a Node stub server completes the handshake", async () => {
    // Known limitation: the stub relies on shebang (`#!/usr/bin/env node`)
    // dispatch, which POSIX honours but Windows does not. The #1918
    // phased plan keeps the integration harness Linux-only for the
    // initial rollout; a future phase can add a PowerShell wrapper
    // if Windows matrix coverage is demanded.
    if (process.platform === "win32") {
      return;
    }

    const stubPath = fixture("stub-lsp-server.mjs").fsPath;

    // Trace file the stub touches after answering `initialize`. Placed
    // in a fresh temp dir per test run so a stale file from a previous
    // session cannot mask a failure.
    const traceDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "chordsketch-lsp-stub-"),
    );
    const traceFile = path.join(traceDir, "initialized");

    // The stub reads `CHORDSKETCH_STUB_TRACE_FILE` from its own
    // environment. The extension inherits the test process's env when
    // spawning the LSP child via `ServerOptions.command`, so setting
    // it here propagates through.
    const previousTraceEnv = process.env.CHORDSKETCH_STUB_TRACE_FILE;
    process.env.CHORDSKETCH_STUB_TRACE_FILE = traceFile;

    const config = vscode.workspace.getConfiguration("chordsketch.lsp");
    try {
      await config.update(
        "path",
        stubPath,
        vscode.ConfigurationTarget.Workspace,
      );

      // Poll for the trace file with a generous deadline: the restart
      // path spawns Node, negotiates the JSON-RPC handshake, and
      // writes the trace. 5 s is comfortable even on a cold runner.
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline && !fs.existsSync(traceFile)) {
        await new Promise((r) => setTimeout(r, 100));
      }

      // Two assertions, in strict order — if the handshake did not
      // succeed we want the "handshake" failure first, not the
      // secondary "commands still registered" check.
      const handshakeCompleted = fs.existsSync(traceFile);
      if (!handshakeCompleted) {
        throw new Error(
          `stub server did not write ${traceFile} within 5 s — the ` +
            `extension failed to start the LSP handshake against the ` +
            `stub. Check the ChordSketch LSP output channel in the test ` +
            `host logs for details.`,
        );
      }

      // Sanity regression gate for #1914: even after a successful
      // (or failed) restart, the five contributed commands must
      // remain registered.
      await assertAllContributedCommandsRegistered();
    } finally {
      await config.update(
        "path",
        undefined,
        vscode.ConfigurationTarget.Workspace,
      );
      // Restore the env the way we found it (even if undefined, so
      // other tests in the suite do not pick up a dangling path).
      if (previousTraceEnv === undefined) {
        delete process.env.CHORDSKETCH_STUB_TRACE_FILE;
      } else {
        process.env.CHORDSKETCH_STUB_TRACE_FILE = previousTraceEnv;
      }
      fs.rmSync(traceDir, { recursive: true, force: true });
    }
  });
});
