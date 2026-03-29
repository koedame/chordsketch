# chordpro-rs

A Rust rewrite of the Perl [ChordPro](https://www.chordpro.org/) reference
implementation, aiming for full compatibility with the ChordPro file format.

## Status

Early development — workspace scaffolding and CI are in place. See the
[roadmap](https://github.com/koedame/chordpro-rs/issues) for planned work.

## Build

Requires Rust 1.85 or later.

```bash
cargo build          # Build all crates
cargo test           # Run all tests
cargo clippy         # Lint
cargo fmt            # Format code
```

## Workspace Structure

| Crate | Path | Description |
|---|---|---|
| `chordpro-core` | `crates/core` | Parser, AST, transforms (zero external dependencies) |
| `chordpro-render-text` | `crates/render-text` | Plain text renderer |
| `chordpro` | `crates/cli` | Command-line tool |

## Roadmap

1. Workspace setup and CI
2. Core parser (lexer + AST)
3. Plain text renderer
4. CLI with file I/O
5. Extended directives, metadata, transposition
6. Additional renderers (HTML, PDF)

## License

[MIT](LICENSE)
