#!/usr/bin/env node
/**
 * Minimal LSP stub used by the #1918 integration tests.
 *
 * Answers `initialize` with a `positionEncoding` that the client
 * should accept (UTF-16, the default and the only encoding
 * `vscode-languageclient@9.x` tolerates) and `initialized` with a
 * shutdown-friendly capability set. Everything else is ignored — the
 * test only cares that the LSP handshake completes without VS Code
 * logging `Unsupported position encoding ...` (the #1913 regression).
 *
 * Reads Content-Length-framed JSON-RPC on stdin, writes on stdout.
 * Exits on `shutdown` / `exit` so the extension host can terminate
 * the child cleanly at test teardown.
 *
 * NOT a real chordsketch-lsp replacement: does not implement
 * diagnostics, hover, completion, or formatting. The test harness
 * monkey-patches or asserts at the client-capabilities layer, not
 * the server-response layer.
 */

/* eslint-disable no-console */

import { writeFileSync } from "node:fs";

// Optional trace file: when `CHORDSKETCH_STUB_TRACE_FILE` is set, the
// stub touches the file on successful `initialize`. Lets the integration
// test assert the handshake actually completed (not just that activation
// survived), addressing the Low-2 finding in #1967.
const TRACE_FILE = process.env.CHORDSKETCH_STUB_TRACE_FILE;

// Consume stdin as raw bytes. `setEncoding("utf8")` would decode
// incoming chunks and break Content-Length byte-count framing if the
// body ever contained multi-byte characters.
let buffer = Buffer.alloc(0);
const CONTENT_LENGTH = /^Content-Length: (\d+)\r\n/i;

function writeMessage(msg) {
  const body = JSON.stringify(msg);
  const header = `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n`;
  process.stdout.write(header + body);
}

function recordInitialized() {
  if (!TRACE_FILE) return;
  try {
    writeFileSync(TRACE_FILE, "initialized\n", "utf8");
  } catch {
    // Test fixture: failure to write the trace is not fatal and must
    // not break the LSP handshake.
  }
}

function handleRequest(msg) {
  switch (msg.method) {
    case "initialize":
      writeMessage({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          capabilities: {
            // Declare UTF-16 explicitly so we exercise the negotiation
            // path — the server-side #1913 fix picks the client's
            // preferred encoding; for `vscode-languageclient@9.x` that
            // is always UTF-16.
            positionEncoding: "utf-16",
            textDocumentSync: 1,
          },
          serverInfo: {
            name: "chordsketch-lsp-stub",
            version: "0.0.0",
          },
        },
      });
      recordInitialized();
      break;
    case "shutdown":
      writeMessage({ jsonrpc: "2.0", id: msg.id, result: null });
      break;
    default:
      // Any other request gets an empty success reply so the client
      // does not time out waiting for hover/completion/etc. The
      // switch reaches here only for messages that carry an `id` —
      // `handleRequest` is called from the id-branch of the outer
      // dispatcher in the stdin handler below.
      writeMessage({ jsonrpc: "2.0", id: msg.id, result: null });
  }
}

function handleNotification(msg) {
  if (msg.method === "exit") {
    process.exit(0);
  }
  // Other notifications (initialized, didOpen, didChange, didClose) —
  // silently ignore. The stub does not maintain document state.
}

process.stdin.on("data", (chunk) => {
  // Accumulate as raw bytes — `Content-Length` is a byte count, so
  // concatenating via a decoded string would miscount for multi-byte
  // characters. The only ASCII scan we need is for the header
  // terminator, which the `toString` inside the conditional handles
  // narrowly before slicing bytes.
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const header = buffer.toString("latin1", 0, Math.min(buffer.length, 256));
    const match = header.match(CONTENT_LENGTH);
    if (!match) {
      return;
    }
    const headerEndChar = header.indexOf("\r\n\r\n");
    if (headerEndChar < 0) {
      return;
    }
    const length = Number.parseInt(match[1], 10);
    const bodyStart = headerEndChar + 4;
    const bodyEnd = bodyStart + length;
    if (buffer.length < bodyEnd) {
      return;
    }
    const body = buffer.slice(bodyStart, bodyEnd).toString("utf8");
    buffer = buffer.slice(bodyEnd);
    try {
      const msg = JSON.parse(body);
      if (typeof msg.id === "number" || typeof msg.id === "string") {
        handleRequest(msg);
      } else {
        handleNotification(msg);
      }
    } catch (err) {
      console.error("stub-lsp: parse error", err);
    }
  }
});

process.stdin.on("end", () => {
  process.exit(0);
});
