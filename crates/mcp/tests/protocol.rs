//! End-to-end protocol tests.
//!
//! These drive a real MCP client against a real [`ChordSketchServer`] over
//! an in-memory duplex pipe — the same code path a client gets over stdio,
//! with only the pipe swapped. Nothing is stubbed, so a regression in the
//! handshake, the generated tool schemas, or the argument decoding fails
//! here rather than in a user's editor.

use rmcp::model::{CallToolRequestParams, CallToolResult, ContentBlock};
use rmcp::service::{RunningService, ServiceExt};
use rmcp::{RoleClient, RoleServer};

use chordsketch_mcp::ChordSketchServer;

const SONG: &str = "{title: Scarborough Fair}\nAre you [Em]going to [G]Scarborough [Em]Fair\n";

/// Starts a server and a client joined by an in-memory pipe, and returns
/// both so the test can shut them down in order.
async fn connect() -> (
    RunningService<RoleClient, ()>,
    RunningService<RoleServer, ChordSketchServer>,
) {
    let (client_io, server_io) = tokio::io::duplex(64 * 1024);
    let server = tokio::spawn(async move {
        ChordSketchServer::new()
            .serve(server_io)
            .await
            .expect("the server completes the handshake")
    });
    let client = ().serve(client_io).await.expect("the client completes the handshake");
    (client, server.await.expect("the server task did not panic"))
}

/// Calls `name` with `arguments` and returns the result.
async fn call(
    client: &RunningService<RoleClient, ()>,
    name: &'static str,
    arguments: serde_json::Value,
) -> CallToolResult {
    let arguments = match arguments {
        serde_json::Value::Object(map) => map,
        other => panic!("tool arguments must be a JSON object, got {other}"),
    };
    client
        .call_tool(CallToolRequestParams::new(name).with_arguments(arguments))
        .await
        .expect("the call reaches the tool")
}

/// The concatenated text of a tool result.
fn body(result: &CallToolResult) -> String {
    result
        .content
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Text(text) => Some(text.text.clone()),
            _ => None,
        })
        .collect()
}

#[tokio::test]
async fn a_connected_client_is_offered_every_tool_the_server_declares() {
    let (client, server) = connect().await;

    let tools = client.list_all_tools().await.expect("tools are listed");
    let mut names: Vec<&str> = tools.iter().map(|t| t.name.as_ref()).collect();
    names.sort_unstable();
    assert_eq!(
        names,
        [
            "chord_diagram_svg",
            "format_chordpro",
            "list_directives",
            "parse_chordpro",
            "render_chordpro",
            "validate_chordpro",
        ]
    );
    assert!(
        tools
            .iter()
            .all(|t| t.description.as_ref().is_some_and(|d| !d.trim().is_empty())),
        "every tool describes itself to the model"
    );

    client.cancel().await.expect("the client shuts down");
    server.waiting().await.expect("the server shuts down");
}

#[tokio::test]
async fn the_render_tool_declares_source_as_required_and_the_rest_as_optional() {
    let (client, server) = connect().await;

    let tools = client.list_all_tools().await.expect("tools are listed");
    let render = tools
        .iter()
        .find(|t| t.name == "render_chordpro")
        .expect("render_chordpro is offered");
    let schema = serde_json::to_value(&render.input_schema).expect("the schema serialises");
    assert_eq!(
        schema["required"],
        serde_json::json!(["source"]),
        "got {schema}"
    );
    for property in ["source", "format", "transpose"] {
        assert!(
            schema["properties"].get(property).is_some(),
            "{property} is on the schema, got {schema}"
        );
    }

    client.cancel().await.expect("the client shuts down");
    server.waiting().await.expect("the server shuts down");
}

#[tokio::test]
async fn calling_render_over_the_wire_returns_the_chart_for_the_requested_format() {
    let (client, server) = connect().await;

    let text = call(
        &client,
        "render_chordpro",
        serde_json::json!({ "source": SONG }),
    )
    .await;
    assert_eq!(text.is_error, Some(false));
    assert!(body(&text).contains("Scarborough Fair"));

    let html = call(
        &client,
        "render_chordpro",
        serde_json::json!({ "source": SONG, "format": "html" }),
    )
    .await;
    assert!(body(&html).contains("<html"), "got {}", body(&html));

    client.cancel().await.expect("the client shuts down");
    server.waiting().await.expect("the server shuts down");
}

#[tokio::test]
async fn calling_render_with_a_format_the_server_does_not_have_fails_the_request() {
    let (client, server) = connect().await;

    let error = client
        .call_tool(
            CallToolRequestParams::new("render_chordpro").with_arguments(
                serde_json::json!({ "source": SONG, "format": "pdf" })
                    .as_object()
                    .cloned()
                    .expect("object"),
            ),
        )
        .await
        .expect_err("pdf is not a format this server renders");
    assert!(
        error.to_string().contains("pdf"),
        "the rejected value is named, got {error}"
    );

    client.cancel().await.expect("the client shuts down");
    server.waiting().await.expect("the server shuts down");
}

#[tokio::test]
async fn calling_a_tool_without_its_required_argument_names_the_missing_one() {
    let (client, server) = connect().await;

    let result = client
        .call_tool(CallToolRequestParams::new("validate_chordpro"))
        .await
        .expect("the request itself is well-formed");
    assert_eq!(result.is_error, Some(true));
    assert!(
        body(&result).contains("source"),
        "the missing argument is named, got {}",
        body(&result)
    );

    client.cancel().await.expect("the client shuts down");
    server.waiting().await.expect("the server shuts down");
}

#[tokio::test]
async fn calling_validate_over_the_wire_returns_the_two_diagnostic_layers_as_json() {
    let (client, server) = connect().await;

    let result = call(
        &client,
        "validate_chordpro",
        serde_json::json!({ "source": "{title: Test}\n{bad\n[G13]Hello\n" }),
    )
    .await;
    let report: serde_json::Value =
        serde_json::from_str(&body(&result)).expect("the report is JSON");
    assert_eq!(report["errors"][0]["line"], 2, "got {report}");
    assert!(
        report["warnings"].as_array().is_some_and(|w| w
            .iter()
            .any(|w| w.as_str().is_some_and(|w| w.contains("G13")))),
        "got {report}"
    );

    client.cancel().await.expect("the client shuts down");
    server.waiting().await.expect("the server shuts down");
}

#[tokio::test]
async fn asking_for_a_diagram_that_cannot_be_drawn_returns_a_tool_error_the_model_can_read() {
    let (client, server) = connect().await;

    let result = call(
        &client,
        "chord_diagram_svg",
        serde_json::json!({ "chord": "not a chord" }),
    )
    .await;
    assert_eq!(
        result.is_error,
        Some(true),
        "the caller is told the tool produced nothing"
    );
    assert!(
        body(&result).contains("not a chord"),
        "the explanation names the chord, got {}",
        body(&result)
    );

    client.cancel().await.expect("the client shuts down");
    server.waiting().await.expect("the server shuts down");
}

#[tokio::test]
async fn a_tool_that_takes_no_arguments_can_be_called_without_any() {
    let (client, server) = connect().await;

    let result = client
        .call_tool(CallToolRequestParams::new("list_directives"))
        .await
        .expect("list_directives needs no arguments");
    let catalog: serde_json::Value =
        serde_json::from_str(&body(&result)).expect("the catalog is JSON");
    assert!(
        catalog
            .as_array()
            .is_some_and(|d| d.iter().any(|d| d["name"] == "title")),
        "got {catalog}"
    );

    client.cancel().await.expect("the client shuts down");
    server.waiting().await.expect("the server shuts down");
}

#[tokio::test]
async fn the_server_tells_a_new_client_what_chordpro_is_and_that_it_takes_source_not_paths() {
    let (client, server) = connect().await;

    let info = client.peer_info().expect("the server sent its info");
    let identity = info
        .server_info
        .as_ref()
        .expect("the server identifies itself");
    assert_eq!(identity.name, "chordsketch");
    let instructions = info
        .instructions
        .as_deref()
        .expect("the server ships instructions");
    assert!(instructions.contains("ChordPro"), "got {instructions}");
    assert!(
        instructions.contains("filesystem"),
        "the caller is told to pass source text, got {instructions}"
    );

    client.cancel().await.expect("the client shuts down");
    server.waiting().await.expect("the server shuts down");
}
