//! LSP [`Backend`] implementation.
//!
//! Implements the [`LanguageServer`] trait from `tower-lsp`. Only the
//! capabilities required for parse-error diagnostics are declared; all other
//! requests are left to their default (not-implemented) response so that
//! editors degrade gracefully.

use std::collections::HashMap;
use std::sync::Arc;

use chordsketch_core::parse_multi_lenient;
use tokio::sync::Mutex;
use tower_lsp::jsonrpc::Result;
use tower_lsp::lsp_types::{
    Diagnostic, DidChangeTextDocumentParams, DidCloseTextDocumentParams, DidOpenTextDocumentParams,
    InitializeParams, InitializeResult, InitializedParams, ServerCapabilities,
    TextDocumentSyncKind,
};
use tower_lsp::{Client, LanguageServer};

use crate::convert::parse_error_to_diagnostic;

/// The LSP server backend.
///
/// Holds the active editor documents (URI → source text) and the `tower-lsp`
/// client handle used to push diagnostics back to the editor.
pub struct Backend {
    client: Client,
    documents: Arc<Mutex<HashMap<tower_lsp::lsp_types::Url, String>>>,
}

impl Backend {
    /// Creates a new `Backend` with the given `tower-lsp` client.
    #[must_use]
    pub fn new(client: Client) -> Self {
        Self {
            client,
            documents: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Re-parses `text` and publishes diagnostics for `uri`.
    async fn publish_diagnostics(&self, uri: tower_lsp::lsp_types::Url, text: &str) {
        let result = parse_multi_lenient(text);
        let diagnostics: Vec<Diagnostic> = result
            .all_errors()
            .into_iter()
            .map(parse_error_to_diagnostic)
            .collect();
        self.client
            .publish_diagnostics(uri, diagnostics, None)
            .await;
    }
}

#[tower_lsp::async_trait]
impl LanguageServer for Backend {
    async fn initialize(&self, _params: InitializeParams) -> Result<InitializeResult> {
        Ok(InitializeResult {
            capabilities: ServerCapabilities {
                text_document_sync: Some(tower_lsp::lsp_types::TextDocumentSyncCapability::Kind(
                    TextDocumentSyncKind::FULL,
                )),
                ..Default::default()
            },
            ..Default::default()
        })
    }

    async fn initialized(&self, _params: InitializedParams) {
        self.client
            .log_message(
                tower_lsp::lsp_types::MessageType::INFO,
                "chordsketch-lsp initialized",
            )
            .await;
    }

    async fn shutdown(&self) -> Result<()> {
        Ok(())
    }

    async fn did_open(&self, params: DidOpenTextDocumentParams) {
        let uri = params.text_document.uri;
        let text = params.text_document.text;
        self.documents
            .lock()
            .await
            .insert(uri.clone(), text.clone());
        self.publish_diagnostics(uri, &text).await;
    }

    async fn did_change(&self, params: DidChangeTextDocumentParams) {
        let uri = params.text_document.uri;
        // Full sync: take the last content change (there should be exactly one).
        if let Some(change) = params.content_changes.into_iter().last() {
            let text = change.text;
            self.documents
                .lock()
                .await
                .insert(uri.clone(), text.clone());
            self.publish_diagnostics(uri, &text).await;
        }
    }

    async fn did_close(&self, params: DidCloseTextDocumentParams) {
        let uri = params.text_document.uri;
        self.documents.lock().await.remove(&uri);
        // Clear diagnostics when the document is closed.
        self.client.publish_diagnostics(uri, vec![], None).await;
    }
}
