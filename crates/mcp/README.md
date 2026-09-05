<p align="center">
  <img src="https://raw.githubusercontent.com/koedame/chordsketch/main/assets/logo.svg" alt="ChordSketch" width="80" height="80">
</p>

# chordsketch-mcp

[Model Context Protocol](https://modelcontextprotocol.io/) server for
[ChordPro](https://www.chordpro.org/) chord charts. Exposes ChordSketch's
render, parse, validate, format and chord-diagram operations as tools an
AI assistant can call.

Part of the [ChordSketch](https://github.com/koedame/chordsketch) project.

## Running it

The server ships inside the `chordsketch` command-line tool, so any
[install method](https://github.com/koedame/chordsketch#installation)
gives you the server too. Point your MCP client at the `mcp` subcommand:

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

It speaks JSON-RPC over stdin and stdout and runs until the client
disconnects. There is nothing to run by hand.

## Tools

| Tool | Arguments | Returns |
|---|---|---|
| `render_chordpro` | `source`, `format` (`text` \| `html`), `transpose` | The rendered chart, plus any renderer warnings |
| `parse_chordpro` | `source` | JSON with `songs` (one syntax tree per song) and `errors` |
| `validate_chordpro` | `source` | JSON with `errors` (line / column / message) and `warnings` |
| `format_chordpro` | `source` | Normalised ChordPro source |
| `chord_diagram_svg` | `chord`, `instrument` (`guitar` \| `ukulele` \| `piano`) | An SVG fragment |
| `list_directives` | — | Every known directive with its aliases and allowed values |

`source` is ChordPro **text**, not a path: the server has no filesystem
and no network access, so the caller reads the file and passes its
contents. Each tool rejects a `source` larger than the parser's own
10 MiB limit, and a `chord` longer than 128 bytes, before doing any
work.

PDF export and iReal Pro charts are deliberately absent — a PDF returned
over MCP is base64 in the model's context, which helps nobody. Use the
CLI (`chordsketch -f pdf song.cho -o song.pdf`) for those.

## Embedding it

The crate is also a library, if you are building a Rust host that should
serve the same tools:

```rust,no_run
fn main() -> Result<(), chordsketch_mcp::ServeError> {
    chordsketch_mcp::serve_stdio()
}
```

`chordsketch_mcp::ops` holds the same operations as plain functions, with
no MCP types in the signatures.

## Documentation

- [Use ChordSketch from an AI assistant](https://github.com/koedame/chordsketch/blob/main/docs/sdk/tasks/mcp.md)
  — client setup and what each tool is for.
- [ADR-0063](https://github.com/koedame/chordsketch/blob/main/docs/adr/0063-mcp-server-is-a-cli-subcommand.md)
  — why the server is a CLI subcommand rather than a Node package or a
  second binary.

## License

MIT
