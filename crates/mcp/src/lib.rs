//! Model Context Protocol (MCP) server for ChordSketch.
//!
//! Exposes ChordPro operations — render, parse, validate, format, chord
//! diagrams, and the directive catalog — as MCP tools an AI assistant can
//! call. The executable entry point is the `chordsketch mcp` subcommand of
//! the [ChordSketch CLI]; this crate is the server behind it, and can also
//! be embedded directly by a Rust host.
//!
//! ```no_run
//! # fn main() -> Result<(), chordsketch_mcp::ServeError> {
//! chordsketch_mcp::serve_stdio()
//! # }
//! ```
//!
//! # Boundaries
//!
//! The server has **no filesystem and no network access**. Every tool
//! takes ChordPro source as a string and renders against the built-in
//! configuration, so there is no path to traverse and no config file to
//! resolve. A caller that wants to render a file reads the file itself
//! and passes the contents.
//!
//! # Layout
//!
//! [`ops`] holds the ChordPro operations as plain functions and knows
//! nothing about MCP. [`ChordSketchServer`] is the protocol adapter over
//! it. The split keeps every tool's behaviour testable without a
//! transport.
//!
//! [ChordSketch CLI]: https://github.com/koedame/chordsketch

pub mod ops;
mod server;

pub use server::{ChordDiagramParams, ChordSketchServer, RenderParams, SourceParams};

use std::fmt;

use rmcp::ServiceExt;
use rmcp::transport::stdio;

/// Why a [`serve_stdio`] session ended abnormally.
#[derive(Debug)]
#[non_exhaustive]
pub enum ServeError {
    /// The async runtime backing the stdio transport could not be built.
    Runtime(std::io::Error),
    /// The MCP handshake did not complete — the peer never sent a usable
    /// `initialize`, or the transport closed during it.
    Handshake(String),
    /// The server stopped for a reason other than the peer disconnecting.
    Task(String),
}

impl fmt::Display for ServeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Runtime(e) => write!(f, "could not start the MCP server runtime: {e}"),
            Self::Handshake(e) => write!(f, "MCP handshake failed: {e}"),
            Self::Task(e) => write!(f, "MCP server stopped: {e}"),
        }
    }
}

impl std::error::Error for ServeError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Runtime(e) => Some(e),
            Self::Handshake(_) | Self::Task(_) => None,
        }
    }
}

/// Serves the MCP protocol over stdin / stdout until the peer
/// disconnects.
///
/// This is the shape an MCP client launches: it spawns the process and
/// speaks JSON-RPC over the pipe. The call blocks for the lifetime of
/// the session and returns `Ok(())` on a clean disconnect.
///
/// Nothing may be written to stdout other than protocol messages — the
/// stream *is* the transport — so this function installs no logging.
///
/// # Errors
///
/// Returns [`ServeError`] when the runtime cannot start, the handshake
/// fails, or the server task ends abnormally.
pub fn serve_stdio() -> Result<(), ServeError> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(ServeError::Runtime)?;
    runtime.block_on(async {
        let service = ChordSketchServer::new()
            .serve(stdio())
            .await
            .map_err(|e| ServeError::Handshake(e.to_string()))?;
        service
            .waiting()
            .await
            .map_err(|e| ServeError::Task(e.to_string()))?;
        Ok(())
    })
}
