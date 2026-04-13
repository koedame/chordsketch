<p align="center">
  <img src="https://raw.githubusercontent.com/koedame/chordsketch/main/assets/logo.svg" alt="ChordSketch" width="80" height="80">
</p>

# ChordPro (Zed Extension)

[ChordPro](https://www.chordpro.org/) language support for the
[Zed](https://zed.dev/) editor, powered by
[ChordSketch](https://github.com/koedame/chordsketch).

This extension provides:

- **Syntax highlighting** via a tree-sitter grammar for `.cho`, `.chordpro`,
  and `.chopro` files
- **LSP integration** via `chordsketch-lsp` for diagnostics, completions,
  hover information, and document formatting

## Installation

### From Zed Extensions (once published)

Open the Zed command palette and search for **"ChordPro"** in the extensions
panel.

### Development install

```bash
# Clone the repository
git clone https://github.com/koedame/chordsketch.git
cd chordsketch/packages/zed-extension

# In Zed: open the command palette and run "zed: install dev extension"
# Then select the packages/zed-extension directory
```

## LSP Setup

The extension requires `chordsketch-lsp` to be installed and available in
your `PATH`:

```bash
cargo install chordsketch-lsp
```

The LSP server provides:

| Feature | Description |
|---------|-------------|
| Diagnostics | Parse error reporting |
| Completions | Directive names, chord names, metadata keys |
| Hover | Chord diagrams and directive documentation |
| Formatting | Full document formatting |

## Links

- [ChordSketch](https://github.com/koedame/chordsketch) — main project
- [Playground](https://chordsketch.koeda.me) — browser-based demo
- [Issues](https://github.com/koedame/chordsketch/issues) — bug reports

## License

MIT
