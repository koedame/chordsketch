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

process.stdin.setEncoding("utf8");

let buffer = "";
const CONTENT_LENGTH = /^Content-Length: (\d+)\r\n/i;

function writeMessage(msg) {
  const body = JSON.stringify(msg);
  const header = `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n`;
  process.stdout.write(header + body);
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
      break;
    case "shutdown":
      writeMessage({ jsonrpc: "2.0", id: msg.id, result: null });
      break;
    default:
      // Any other request: respond with an empty success so the
      // client does not time out waiting for hover/completion etc.
      if (msg.id !== undefined) {
        writeMessage({ jsonrpc: "2.0", id: msg.id, result: null });
      }
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
  buffer += chunk;
  for (;;) {
    const match = buffer.match(CONTENT_LENGTH);
    if (!match) {
      return;
    }
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd < 0) {
      return;
    }
    const length = Number.parseInt(match[1], 10);
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + length;
    if (buffer.length < bodyEnd) {
      return;
    }
    const body = buffer.slice(bodyStart, bodyEnd);
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
