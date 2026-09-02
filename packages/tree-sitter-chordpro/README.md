<p align="center">
  <img src="https://raw.githubusercontent.com/koedame/chordsketch/main/assets/logo.svg" alt="ChordSketch" width="80" height="80">
</p>

# tree-sitter-chordpro

A [Tree-sitter](https://tree-sitter.github.io/tree-sitter/) grammar for
[ChordPro](https://www.chordpro.org/) music notation files (`.cho`,
`.chordpro`, `.chopro`).

Part of the [ChordSketch](https://github.com/koedame/chordsketch) project.

## Supported Syntax

| Element | Example | Node type |
|---------|---------|-----------|
| Comments | `# comment` | `comment` |
| Directives | `{title: Song Name}` | `directive` (with `directive_name`, `directive_value`) |
| Delegate blocks | `{start_of_abc}...{end_of_abc}` | `delegate_block` (with `block_start_directive`, `block_content`, `block_end_directive`) |
| Chords | `[Am]`, `[G/B]` | `chord` (with `chord_name`) |
| Lyrics | `Amazing grace` | `lyrics` |

## Queries

| File | Capture vocabulary | Purpose |
|---|---|---|
| `queries/highlights.scm` | standard tree-sitter highlight names | Directives, chord names, comments, delegate-block bodies |
| `queries/folds.scm` | nvim-treesitter (`@fold`) | Folds each `{start_of_X}` … `{end_of_X}` delegate block |
| `queries/indents.scm` | nvim-treesitter (`@indent.zero` / `@indent.auto`) | Pins ChordPro lines to column 0; leaves delegate-block bodies to the editor |
| `queries/helix/highlights.scm` | Helix (`@comment.line`, `@keyword.directive`, `@markup.raw.block`) | The same nodes as `queries/highlights.scm`, named in Helix's vocabulary |

The top-level files target nvim-treesitter. Helix reads a different
vocabulary — `@indent` / `@outdent` for indentation, and nothing at all for
folds, which it derives from the syntax tree — so its set lives in
`queries/helix/` and holds only `highlights.scm`; ChordPro is flat, so no
construct opens an indent level. Copy the file that matches your editor,
not the other one: see
[`docs/editors.md`](https://github.com/koedame/chordsketch/blob/main/docs/editors.md).

Every query under `queries/` is compiled against the generated parser in CI
(`.github/workflows/tree-sitter.yml`), so a query referencing a node type
that `grammar.js` no longer produces fails the build.

## Usage

### In a Zed extension

Reference this grammar in your `extension.toml`:

```toml
[grammars.chordpro]
repository = "https://github.com/koedame/chordsketch"
rev = "COMMIT_HASH"
path = "packages/tree-sitter-chordpro"
```

### Development

```bash
# Generate the parser
npx tree-sitter generate

# Run tests
npx tree-sitter test

# Parse a file
npx tree-sitter parse example.cho

# Preview highlighting
npx tree-sitter highlight example.cho
```

## Links

- [ChordSketch](https://github.com/koedame/chordsketch) — main project
- [ChordPro format](https://www.chordpro.org/chordpro/) — file format specification
- [Issues](https://github.com/koedame/chordsketch/issues) — bug reports

## License

MIT
