<p align="center">
  <img src="https://raw.githubusercontent.com/koedame/chordsketch/main/assets/logo.svg" alt="ChordSketch" width="80" height="80">
</p>

# chordsketch

Command-line tool for rendering [ChordPro](https://www.chordpro.org/)
files to plain text, HTML, and PDF, plus importers and exporters for
plain chord+lyrics sheets, ABC notation, and MusicXML.

Part of the [ChordSketch](https://github.com/koedame/chordsketch) project.

## Installation

[![crates.io](https://img.shields.io/crates/v/chordsketch)](https://crates.io/crates/chordsketch)

```bash
cargo install chordsketch
```

Pre-built binaries are also distributed via Homebrew, Scoop, winget,
Snap, Chocolatey, the GitHub Container Registry, and Docker Hub — see
the [top-level README](https://github.com/koedame/chordsketch#installation)
for the registry-specific commands.

### Platform compatibility

Official release binaries (produced by `.github/workflows/release.yml`)
are available for the following targets:

| Target triple | OS | Arch | Notes |
|---|---|---|---|
| `x86_64-unknown-linux-gnu` | Linux | x86_64 | glibc |
| `aarch64-unknown-linux-gnu` | Linux | ARM64 | glibc |
| `x86_64-unknown-linux-musl` | Linux | x86_64 | static (musl) |
| `aarch64-unknown-linux-musl` | Linux | ARM64 | static (musl) |
| `x86_64-apple-darwin` | macOS | Intel (x86_64) | — |
| `aarch64-apple-darwin` | macOS | Apple Silicon (ARM64) | — |
| `x86_64-pc-windows-msvc` | Windows | x86_64 | MSVC runtime |

For any other target, use `cargo install chordsketch`; the crate has no
external build-time dependencies beyond a stable Rust toolchain.

## Quick Start

```bash
# Render to plain text (default)
chordsketch song.cho

# Render to HTML
chordsketch -f html song.cho -o song.html

# Render to PDF
chordsketch -f pdf song.cho -o song.pdf

# Transpose up 2 semitones (combines with any {transpose} in the file)
chordsketch --transpose 2 song.cho

# Format ChordPro source files in place
chordsketch fmt song.cho

# Convert plain chord+lyrics, ABC, or MusicXML to ChordPro
chordsketch convert song.txt > song.cho

# Export ChordPro to MusicXML
chordsketch convert --to musicxml song.cho -o song.xml

# Render an iReal Pro export — pass the URL directly or a file containing it
chordsketch 'irealb://%54=…'
chordsketch song.irealb            # `.irealb` (single song) routes through the iReal pipeline
chordsketch songs.irealbook        # `.irealbook` (multi-song collection) renders one chart per song
chordsketch chart.txt              # auto-detected if the body starts with irealb://
chordsketch chart.txt --from ireal # force the iReal pipeline
```

## Commands

| Command | Description |
|---|---|
| `chordsketch [FILES]...` | Render one or more ChordPro files with the options below. |
| `chordsketch fmt [FILES]...` | Normalize directive names, spacing, and blank lines. Supports `-` for stdin. `--check` returns non-zero when any file would be modified. |
| `chordsketch convert [FILES]...` | Import from plain-text / ABC / MusicXML, or export to MusicXML via `--to musicxml`. Format is auto-detected from extension and content unless `--from <F>` is given. |
| `chordsketch help [COMMAND]` | Print detailed help for any subcommand. |

## Options

| Flag | Value | Description |
|---|---|---|
| `-f`, `--format` | `text` \| `html` \| `pdf` | Output format for the default render command. Defaults to `text`. (Ignored when the input is an iReal Pro `irealb://` URL — the iReal pipeline always emits SVG.) |
| `--from` | `auto` \| `chordpro` \| `ireal` | Input format. `auto` (the default) sniffs each argument: inline `irealb://` / `irealbook://` URLs, files whose path ends in `.irealb` / `.irealbook` (case-insensitive), or files whose first non-whitespace bytes match the same prefix all route through the iReal renderer. `chordpro` and `ireal` force detection. |
| `-o`, `--output` | *path* | Write output to a file instead of stdout. For `-f pdf` this writes the binary PDF stream. |
| `-t`, `--transpose` | *i8* | Transpose every chord by N semitones. Combines additively with any `{transpose: N}` directive in the file. |
| `-c`, `--config` | *path* or *preset* | Load a custom config file or the named built-in preset (`default`, `ukulele`, `piano`, `guitar`, …). May be repeated — later values override earlier ones. Paths are trusted; do not pass attacker-supplied values. |
| `-D`, `--define` | `key=value` | Override a single config value at runtime. Highest precedence — wins over every `--config`. |
| `--no-default-configs` | | Skip system, user, and project config files. Only built-in defaults plus any explicit `--config` / `--define`. |
| `--instrument` | `guitar` \| `ukulele` \| … | Select the active instrument for selector filtering (directives like `{textfont-piano: Courier}` are kept only when the selector matches). Equivalent to `--define instrument.type=<NAME>`. |
| `--warnings-json` | | Emit render / config warnings as JSONL on stderr instead of the default `warning: …` lines. Each warning becomes a single-line JSON object `{"source": "render\|config\|transpose", "message": "…"}` so programmatic consumers can aggregate or suppress warnings without scraping. Applies to the default render mode only — clap rejects the flag when combined with the `fmt` or `convert` subcommand. |
| `--completions` | *shell* | Print shell completions (`bash`, `elvish`, `fish`, `powershell`, `zsh`) to stdout and exit. |
| `-h`, `--help` | | Print help. Use on a subcommand (e.g. `chordsketch fmt --help`) for subcommand-specific detail. |
| `-V`, `--version` | | Print the version and exit. |

Run `chordsketch --help` for the authoritative list; the table above is
regenerated by hand and may lag by one patch release.

## Configuration

ChordSketch loads config from four precedence levels, lowest to highest:

1. Built-in defaults (compiled into the binary).
2. System, user, and project config files discovered on startup (skip with `--no-default-configs`).
3. Each `--config <path-or-preset>` in the order given on the command line.
4. Each `--define key=value` on the command line.

Configs are written in **RRJSON** — a relaxed JSON dialect with unquoted
keys, trailing commas, and comments. See the
[ChordPro configuration reference](https://www.chordpro.org/chordpro/chordpro-configuration-pp/)
for the canonical schema; ChordSketch aims to be a drop-in replacement
for the upstream Perl implementation.

## Exit codes

| Exit | Meaning |
|---|---|
| `0` | Render, format, or conversion completed successfully. |
| `1` | Input parse error, renderer error, or `fmt --check` found unformatted files. Diagnostic messages are written to stderr. |
| `2` | Invalid command-line arguments (propagated from `clap`). |

Warnings from the renderer are written to stderr and do not change the
exit code. Use the Rust library API (`chordsketch-render-*`) if you
need programmatic access to the warning list.

## Links

- Project repository: <https://github.com/koedame/chordsketch>
- Live playground: <https://chordsketch.koeda.me>
- API docs: <https://docs.rs/chordsketch>
- Issue tracker: <https://github.com/koedame/chordsketch/issues>

## License

[MIT](../../LICENSE)
