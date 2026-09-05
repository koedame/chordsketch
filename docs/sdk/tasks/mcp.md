# Use ChordSketch from an AI assistant (MCP)

ChordSketch ships a [Model Context Protocol](https://modelcontextprotocol.io/)
server, so an assistant that supports MCP can render, inspect, check and
tidy ChordPro charts by calling tools instead of shelling out and parsing
output.

The server is a subcommand of the `chordsketch` binary. Whichever
[install method](../../../README.md#installation) you already use gives
you the server too — there is nothing extra to install and no Node
runtime involved.

## Set up a client

Point the client at `chordsketch mcp`. The exact file differs per
client; the object below is the shape they share.

```json
{
  "mcpServers": {
    "chordsketch": {
      "command": "chordsketch",
      "args": ["mcp"]
    }
  }
}
```

Without a local install, the published image works the same way — `-i`
keeps stdin open, which the transport needs:

```json
{
  "mcpServers": {
    "chordsketch": {
      "command": "docker",
      "args": ["run", "-i", "--rm", "ghcr.io/koedame/chordsketch", "mcp"]
    }
  }
}
```

To check the server starts before wiring a client to it, send it one
message and read the reply:

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}' \
  | chordsketch mcp
```

A JSON line naming `chordsketch` and its version means the server is
reachable. (Running `chordsketch mcp` on its own terminal looks like it
hangs — it is waiting for a client on stdin. Ctrl-D ends it.)

## What the assistant gets

| Tool | Ask it for | Returns |
|---|---|---|
| `render_chordpro` | a readable chart, a web page, or the song in another key | The rendered chart, followed by any renderer warnings |
| `parse_chordpro` | the structure — directives, chords with positions, section boundaries | JSON with `songs` (one syntax tree per song) and `errors` |
| `validate_chordpro` | whether a file is broken | JSON with `errors` (line, column, message) and `warnings` |
| `format_chordpro` | tidy source | Normalised ChordPro |
| `chord_diagram_svg` | a fingering or keyboard diagram | An SVG fragment |
| `list_directives` | the ChordPro vocabulary | Every directive with its aliases and allowed values |

`render_chordpro` takes `format` (`text`, the default, or `html`) and
`transpose` (semitones, negative to go down). `chord_diagram_svg` takes
`instrument` (`guitar`, the default, `ukulele`, or `piano`).

Every tool that reads a song takes its **source text**, not a path:

```json
{
  "name": "render_chordpro",
  "arguments": {
    "source": "{title: Scarborough Fair}\nAre you [Em]going to [G]Scarborough [Em]Fair\n",
    "transpose": 2
  }
}
```

The server has no filesystem and no network access — the assistant reads
the file with its own tools and passes the contents. Each tool rejects a
`source` larger than 10 MiB (the parser's own limit) and a `chord` longer
than 128 bytes before doing any work.

A source the parser has to recover from still renders: ChordPro parsing
is lenient, so the lines it cannot read are dropped and the rest comes
back. `render_chordpro` appends those diagnostics under a `Warnings:`
heading after the chart, and `parse_chordpro` and `validate_chordpro`
carry them as an `errors` field with a line and column counted from the
start of the file — so a chart that came back short is never silently
short.

## What it does not do

- **No PDF.** Returning a PDF over MCP means base64 bytes in the model's
  context, which is expensive and unreadable. Render PDFs with the CLI:
  `chordsketch -f pdf song.cho -o song.pdf`.
- **No iReal Pro.** Converting and rendering `irealb://` charts is a CLI
  operation today: `chordsketch 'irealb://...' -o chart.svg`.
- **No configuration files.** Renders use the built-in configuration.
  `--config` / `--define` are CLI-only.

## Alongside the Claude Code skill

The [ChordSketch Claude Code plugin](../../../packages/claude-code-plugin/README.md)
teaches an assistant to drive the CLI directly. The two compose: the
skill covers everything the command line does — including PDF, iReal Pro
and config presets — while the MCP server turns the operations an
assistant reaches for most into typed tools with no shell in between.
Install either, or both.

## Embedding the server

The server is also a library crate,
[`chordsketch-mcp`](https://crates.io/crates/chordsketch-mcp), if you are
building a Rust host that should serve the same tools:

```rust
fn main() -> Result<(), chordsketch_mcp::ServeError> {
    chordsketch_mcp::serve_stdio()
}
```

`chordsketch_mcp::ops` exposes the same operations as plain functions,
with no MCP types in the signatures.
