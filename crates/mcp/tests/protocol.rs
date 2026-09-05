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
async fn calling_render_with_a_format_the_server_does_not_have_tells_the_model_why() {
    // A bad argument value comes back as a tool error, not a protocol
    // error: most clients render a protocol error opaquely, so a model
    // that guessed "pdf" would never learn what it should have sent.
    let (client, server) = connect().await;

    let result = call(
        &client,
        "render_chordpro",
        serde_json::json!({ "source": SONG, "format": "pdf" }),
    )
    .await;
    assert_eq!(result.is_error, Some(true));
    assert!(
        body(&result).contains("pdf") && body(&result).contains("text"),
        "the rejected value and the accepted ones are named, got {}",
        body(&result)
    );

    client.cancel().await.expect("the client shuts down");
    server.waiting().await.expect("the server shuts down");
}

#[tokio::test]
async fn calling_render_with_a_transpose_over_the_wire_shifts_the_chords() {
    // The only coverage that the optional `transpose` argument survives
    // schema generation and decoding.
    let (client, server) = connect().await;

    let result = call(
        &client,
        "render_chordpro",
        serde_json::json!({ "source": "[C]Hello\n", "transpose": 2 }),
    )
    .await;
    assert!(
        body(&result).contains('D') && !body(&result).contains('C'),
        "C transposed up two semitones is D, got {}",
        body(&result)
    );

    client.cancel().await.expect("the client shuts down");
    server.waiting().await.expect("the server shuts down");
}

#[tokio::test]
async fn a_rendered_chart_carries_the_parser_diagnostics_after_it() {
    // The chart is short a line; without this block the caller cannot
    // tell that from a short song.
    let (client, server) = connect().await;

    let result = call(
        &client,
        "render_chordpro",
        serde_json::json!({ "source": "{title: Test}\n{bad\n[G]Hello\n" }),
    )
    .await;
    let text = body(&result);
    assert!(text.contains("Hello"), "got {text}");
    assert!(
        text.contains("Warnings:") && text.contains("line 2"),
        "the diagnostics ride along with the chart, got {text}"
    );

    client.cancel().await.expect("the client shuts down");
    server.waiting().await.expect("the server shuts down");
}

#[tokio::test]
async fn calling_parse_over_the_wire_returns_json_even_when_the_source_is_malformed() {
    // The tool is documented as returning JSON. A source the parser had
    // to recover from is exactly when a caller reaches for the tree, so
    // the diagnostics have to be a field rather than a trailing note.
    let (client, server) = connect().await;

    let result = call(
        &client,
        "parse_chordpro",
        serde_json::json!({ "source": "{title: Test}\n{bad\n[G]Hello\n" }),
    )
    .await;
    let tree: serde_json::Value =
        serde_json::from_str(&body(&result)).expect("the payload is JSON");
    assert_eq!(tree["songs"][0]["metadata"]["title"], "Test", "got {tree}");
    assert_eq!(tree["errors"][0]["line"], 2, "got {tree}");

    client.cancel().await.expect("the client shuts down");
    server.waiting().await.expect("the server shuts down");
}

#[tokio::test]
async fn calling_format_over_the_wire_returns_normalised_source() {
    let (client, server) = connect().await;

    let result = call(
        &client,
        "format_chordpro",
        serde_json::json!({ "source": "{t: Test}\n[am]Hello\n" }),
    )
    .await;
    let text = body(&result);
    assert!(
        text.contains("{title: Test}") && text.contains("[Am]"),
        "got {text}"
    );

    client.cancel().await.expect("the client shuts down");
    server.waiting().await.expect("the server shuts down");
}

#[tokio::test]
async fn asking_for_a_diagram_on_an_instrument_the_server_does_not_draw_names_the_ones_it_does() {
    // Also the only coverage that the optional `instrument` argument is
    // decoded at all — every other case takes the default.
    let (client, server) = connect().await;

    let result = call(
        &client,
        "chord_diagram_svg",
        serde_json::json!({ "chord": "Am", "instrument": "banjo" }),
    )
    .await;
    assert_eq!(result.is_error, Some(true));
    assert!(
        body(&result).contains("banjo") && body(&result).contains("guitar"),
        "got {}",
        body(&result)
    );

    let piano = call(
        &client,
        "chord_diagram_svg",
        serde_json::json!({ "chord": "Am", "instrument": "piano" }),
    )
    .await;
    assert!(body(&piano).starts_with("<svg"), "a known instrument draws");

    client.cancel().await.expect("the client shuts down");
    server.waiting().await.expect("the server shuts down");
}

#[tokio::test]
async fn an_oversized_argument_is_refused_before_the_parser_sees_it() {
    let (client, server) = connect().await;

    let result = call(
        &client,
        "chord_diagram_svg",
        serde_json::json!({ "chord": "A".repeat(chordsketch_mcp::ops::MAX_CHORD_BYTES + 1) }),
    )
    .await;
    assert_eq!(result.is_error, Some(true));
    assert!(body(&result).contains("exceeds"), "got {}", body(&result));

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
