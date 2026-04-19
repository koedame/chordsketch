//! End-to-end integration tests for the `chordsketch-lsp` binary.
//!
//! These tests spawn the compiled binary as a subprocess, speak raw LSP
//! JSON-RPC over its stdio, and assert on the response stream. Exercises the
//! full wiring — `main.rs` argument parsing, stdio transport, tower-lsp
//! dispatch, and the handler code in `server.rs` — that the in-crate unit
//! tests can only cover in isolation.

use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::{Value, json};

const LSP_BIN: &str = env!("CARGO_BIN_EXE_chordsketch-lsp");

/// Minimal LSP client that speaks JSON-RPC with Content-Length framing over a
/// subprocess's stdio.
struct LspClient {
    child: Child,
    stdin: Option<ChildStdin>,
    stdout: BufReader<ChildStdout>,
    next_id: i64,
}

impl LspClient {
    fn spawn() -> Self {
        let mut child = Command::new(LSP_BIN)
            .arg("--stdio")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            // Server writes tracing output to stderr; discard so tokio
            // line-buffering inside the test runner does not block.
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn chordsketch-lsp");
        let stdin = Some(child.stdin.take().expect("stdin"));
        let stdout = BufReader::new(child.stdout.take().expect("stdout"));
        Self {
            child,
            stdin,
            stdout,
            next_id: 1,
        }
    }

    fn write_message(&mut self, msg: &Value) {
        let body = serde_json::to_string(msg).expect("serialise message");
        let header = format!("Content-Length: {}\r\n\r\n", body.len());
        let stdin = self.stdin.as_mut().expect("stdin open");
        stdin.write_all(header.as_bytes()).expect("write header");
        stdin.write_all(body.as_bytes()).expect("write body");
        stdin.flush().expect("flush stdin");
    }

    fn request(&mut self, method: &str, params: Value) -> i64 {
        let id = self.next_id;
        self.next_id += 1;
        self.write_message(&json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        }));
        id
    }

    fn notify(&mut self, method: &str, params: Value) {
        self.write_message(&json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        }));
    }

    fn read_message(&mut self) -> Value {
        let mut content_length: Option<usize> = None;
        loop {
            let mut line = String::new();
            let n = self.stdout.read_line(&mut line).expect("read header line");
            if n == 0 {
                panic!("LSP server closed stdout unexpectedly");
            }
            let trimmed = line.trim_end_matches(['\r', '\n']);
            if trimmed.is_empty() {
                break;
            }
            if let Some(rest) = trimmed.strip_prefix("Content-Length:") {
                content_length = Some(rest.trim().parse().expect("parse Content-Length"));
            }
        }
        let n = content_length.expect("missing Content-Length header");
        let mut body = vec![0u8; n];
        self.stdout.read_exact(&mut body).expect("read body");
        serde_json::from_slice(&body).expect("parse JSON-RPC body")
    }

    /// Reads messages, skipping notifications, until the response for the
    /// given id arrives. Times out so a buggy server does not hang CI.
    fn wait_for_response(&mut self, id: i64) -> Value {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if Instant::now() > deadline {
                panic!("timed out waiting for response id={id}");
            }
            let msg = self.read_message();
            if msg.get("id").and_then(Value::as_i64) == Some(id) {
                return msg;
            }
            // Notification (e.g. window/logMessage, publishDiagnostics) — drop.
        }
    }

    fn shutdown(&mut self) {
        let id = self.request("shutdown", Value::Null);
        let _ = self.wait_for_response(id);
        self.notify("exit", Value::Null);
        // Drop our side of the pipe so the server sees EOF on stdin and
        // the tower-lsp server loop can terminate. Without this, `child.wait`
        // blocks because the read half still has a writer.
        drop(self.stdin.take());
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            match self.child.try_wait() {
                Ok(Some(_)) => return,
                Ok(None) if Instant::now() > deadline => {
                    let _ = self.child.kill();
                    let _ = self.child.wait();
                    return;
                }
                Ok(None) => std::thread::sleep(Duration::from_millis(50)),
                Err(_) => return,
            }
        }
    }
}

impl Drop for LspClient {
    fn drop(&mut self) {
        // If the test panics before shutdown, kill the child so the runner
        // does not wait on it forever.
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn initialize_params() -> Value {
    json!({
        "processId": Value::Null,
        "rootUri": Value::Null,
        "capabilities": {
            "general": {
                "positionEncodings": ["utf-16"]
            },
            "textDocument": {
                "hover": { "contentFormat": ["markdown", "plaintext"] }
            }
        }
    })
}

#[test]
fn initialize_advertises_expected_capabilities() {
    let mut client = LspClient::spawn();
    let id = client.request("initialize", initialize_params());
    let response = client.wait_for_response(id);

    let caps = &response["result"]["capabilities"];
    assert!(
        caps.get("hoverProvider").is_some(),
        "expected hoverProvider in capabilities, got: {response}"
    );
    assert!(
        caps.get("completionProvider").is_some(),
        "expected completionProvider in capabilities"
    );
    assert!(
        caps.get("textDocumentSync").is_some(),
        "expected textDocumentSync in capabilities"
    );

    client.shutdown();
}

#[test]
fn did_open_then_hover_returns_chord_markdown() {
    let mut client = LspClient::spawn();

    let init_id = client.request("initialize", initialize_params());
    client.wait_for_response(init_id);
    client.notify("initialized", json!({}));

    // `[Am]Hello world` — position column 1 (the `A` of `Am`) should hover the chord.
    let uri = "file:///test.cho";
    let text = "[Am]Hello world\n";
    client.notify(
        "textDocument/didOpen",
        json!({
            "textDocument": {
                "uri": uri,
                "languageId": "chordpro",
                "version": 1,
                "text": text,
            }
        }),
    );

    let hover_id = client.request(
        "textDocument/hover",
        json!({
            "textDocument": { "uri": uri },
            "position": { "line": 0, "character": 1 }
        }),
    );
    let response = client.wait_for_response(hover_id);

    let result = &response["result"];
    assert!(
        !result.is_null(),
        "expected non-null hover result, got: {response}"
    );
    let markdown = result["contents"]["value"]
        .as_str()
        .expect("hover contents should be MarkupContent with a string value");
    assert!(
        markdown.contains("Am") || markdown.contains("A minor"),
        "expected hover markdown to reference the Am chord, got: {markdown:?}"
    );

    client.shutdown();
}

#[test]
fn hover_on_unknown_position_returns_null() {
    let mut client = LspClient::spawn();

    let init_id = client.request("initialize", initialize_params());
    client.wait_for_response(init_id);
    client.notify("initialized", json!({}));

    let uri = "file:///empty.cho";
    client.notify(
        "textDocument/didOpen",
        json!({
            "textDocument": {
                "uri": uri,
                "languageId": "chordpro",
                "version": 1,
                "text": "plain lyrics with no chord\n",
            }
        }),
    );

    // Hover on a plain lyric letter — no chord or directive context.
    let hover_id = client.request(
        "textDocument/hover",
        json!({
            "textDocument": { "uri": uri },
            "position": { "line": 0, "character": 2 }
        }),
    );
    let response = client.wait_for_response(hover_id);
    assert!(
        response["result"].is_null(),
        "expected null hover result for a lyric-only position, got: {response}"
    );

    client.shutdown();
}

#[test]
fn workspace_configuration_change_is_accepted() {
    // Mirrors the VS Code extension's restart-on-config-change flow (#1918
    // phase 4): exercises that the server accepts `workspace/didChangeConfiguration`
    // without crashing even when the settings blob is unexpected. A server
    // that panicked here would break editor integration on every settings
    // save.
    let mut client = LspClient::spawn();

    let init_id = client.request("initialize", initialize_params());
    client.wait_for_response(init_id);
    client.notify("initialized", json!({}));

    client.notify(
        "workspace/didChangeConfiguration",
        json!({
            "settings": { "chordsketch": { "someUnknownKey": true } }
        }),
    );

    // Follow up with a request that exercises a live handler; if the prior
    // notification crashed the server, this round-trip hangs and the
    // wait_for_response timeout fires.
    let uri = "file:///after-config.cho";
    client.notify(
        "textDocument/didOpen",
        json!({
            "textDocument": {
                "uri": uri,
                "languageId": "chordpro",
                "version": 1,
                "text": "[C]ok\n",
            }
        }),
    );
    let hover_id = client.request(
        "textDocument/hover",
        json!({
            "textDocument": { "uri": uri },
            "position": { "line": 0, "character": 1 }
        }),
    );
    let response = client.wait_for_response(hover_id);
    assert!(
        response.get("result").is_some(),
        "hover after didChangeConfiguration should still return a response"
    );

    client.shutdown();
}
