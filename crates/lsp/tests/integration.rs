//! End-to-end integration tests for the `chordsketch-lsp` binary.
//!
//! These tests spawn the compiled binary as a subprocess, speak raw LSP
//! JSON-RPC over its stdio, and assert on the response stream. Exercises the
//! full wiring — `main.rs` argument parsing, stdio transport, tower-lsp
//! dispatch, and the handler code in `server.rs` — that the in-crate unit
//! tests can only cover in isolation.

use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use serde_json::{Value, json};

const LSP_BIN: &str = env!("CARGO_BIN_EXE_chordsketch-lsp");

/// Upper bound on any single `read_message`-equivalent call. Applied per
/// framed message, not only per round-trip, so a server that writes a
/// Content-Length header and then hangs before sending the body fails the
/// test deterministically instead of stalling CI until the runner timeout.
/// See #1988 for the bug this guards against.
const READ_TIMEOUT: Duration = Duration::from_secs(10);

/// Minimal LSP client that speaks JSON-RPC with Content-Length framing over a
/// subprocess's stdio. A dedicated reader thread deserialises messages as
/// soon as they arrive on the child's stdout; the test thread receives them
/// through a bounded-wait channel, which gives `read_message` a real I/O
/// timeout that blocking `BufReader::read_line` / `read_exact` calls cannot
/// provide on their own.
struct LspClient {
    child: Child,
    stdin: Option<ChildStdin>,
    rx: Receiver<ReaderEvent>,
    reader: Option<JoinHandle<()>>,
    next_id: i64,
}

/// What the reader thread emits. `Message` is a complete parsed JSON-RPC
/// value; `Error` covers the stream ending or failing to parse. Exactly one
/// `Error` is ever sent before the thread exits.
enum ReaderEvent {
    Message(Value),
    Error(String),
}

fn spawn_reader_thread(stdout: ChildStdout) -> (Receiver<ReaderEvent>, JoinHandle<()>) {
    let (tx, rx) = mpsc::channel();
    let handle = thread::spawn(move || {
        let mut stdout = BufReader::new(stdout);
        loop {
            let mut content_length: Option<usize> = None;
            let mut header_error: Option<String> = None;
            loop {
                let mut line = String::new();
                let n = match stdout.read_line(&mut line) {
                    Ok(n) => n,
                    Err(e) => {
                        header_error = Some(format!("read header line: {e}"));
                        break;
                    }
                };
                if n == 0 {
                    header_error = Some("server closed stdout".to_string());
                    break;
                }
                let trimmed = line.trim_end_matches(['\r', '\n']);
                if trimmed.is_empty() {
                    break;
                }
                if let Some(rest) = trimmed.strip_prefix("Content-Length:") {
                    match rest.trim().parse() {
                        Ok(v) => content_length = Some(v),
                        Err(e) => {
                            header_error = Some(format!("parse Content-Length: {e}"));
                            break;
                        }
                    }
                }
            }
            if let Some(e) = header_error {
                let _ = tx.send(ReaderEvent::Error(e));
                return;
            }
            let Some(n) = content_length else {
                let _ = tx.send(ReaderEvent::Error("missing Content-Length header".into()));
                return;
            };
            let mut body = vec![0u8; n];
            if let Err(e) = stdout.read_exact(&mut body) {
                let _ = tx.send(ReaderEvent::Error(format!("read body: {e}")));
                return;
            }
            let parsed: Value = match serde_json::from_slice(&body) {
                Ok(v) => v,
                Err(e) => {
                    let _ = tx.send(ReaderEvent::Error(format!("parse JSON-RPC body: {e}")));
                    return;
                }
            };
            if tx.send(ReaderEvent::Message(parsed)).is_err() {
                // Receiver dropped — test finished; exit quietly.
                return;
            }
        }
    });
    (rx, handle)
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
        let stdout = child.stdout.take().expect("stdout");
        let (rx, reader) = spawn_reader_thread(stdout);
        Self {
            child,
            stdin,
            rx,
            reader: Some(reader),
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

    /// Receives the next full message with a hard deadline. If the reader
    /// thread is stuck mid-frame (headers received, body not sent), the
    /// channel wait times out and this function panics instead of blocking
    /// CI indefinitely. See #1988 for the scenario this guards against.
    fn read_message_with_deadline(&mut self, deadline: Instant) -> Value {
        let remaining = deadline.saturating_duration_since(Instant::now());
        match self.rx.recv_timeout(remaining) {
            Ok(ReaderEvent::Message(v)) => v,
            Ok(ReaderEvent::Error(e)) => panic!("LSP reader error: {e}"),
            Err(RecvTimeoutError::Timeout) => panic!(
                "timed out after {:?} waiting for next LSP message (server likely hung mid-frame)",
                READ_TIMEOUT
            ),
            Err(RecvTimeoutError::Disconnected) => {
                panic!("LSP reader thread exited before sending a message")
            }
        }
    }

    /// Reads messages, skipping notifications, until the response for the
    /// given id arrives. The overall deadline is the same as a single
    /// `read_message` — if a server sends a stream of log notifications but
    /// never the actual response, this still caps CI latency.
    fn wait_for_response(&mut self, id: i64) -> Value {
        let deadline = Instant::now() + READ_TIMEOUT;
        loop {
            let msg = self.read_message_with_deadline(deadline);
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
        // Reader thread observes stdout EOF once the child exits and
        // terminates on its own; joining here keeps the test process tidy.
        if let Some(handle) = self.reader.take() {
            let _ = handle.join();
        }
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
