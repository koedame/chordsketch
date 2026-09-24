# `chordsketch` CLI reference

Read this when the command in `SKILL.md` is not enough — an unusual flag, a
config file, the `fmt` / `convert` subcommands, or iReal Pro input.

```
chordsketch [OPTIONS] [FILES]...
chordsketch fmt [--check] <FILES>...
chordsketch convert [--from FMT] [--to musicxml] [-o FILE] <FILES>...
```

## Render options

| Flag | Meaning |
|---|---|
| `-f, --format <text\|html\|pdf>` | Output format. Default `text`. Ignored for iReal Pro input, which always renders SVG. |
| `-o, --output <FILE>` | Write to a file instead of stdout. **Required in practice for `-f pdf`.** |
| `-t, --transpose <N>` | Shift chords by N semitones for this render. Negative goes down. |
| `-c, --config <FILE\|PRESET>` | Load a config file, or the preset `guitar` / `ukulele` / `charango`. Repeatable; merged in order. |
| `-D, --define <key=value>` | Set one config value. Highest precedence below the song's own `{+config.…}` directives. |
| `--no-default-configs` | Ignore the system / user / project config files. `-c` and `-D` still apply. |
| `--instrument <NAME>` | Set the instrument used to resolve selector suffixes such as `{textfont-piano: Courier}`. Same as `-D instrument.type=<NAME>`. |
| `--warnings-json` | Emit warnings to stderr as one JSON object per line instead of `warning: …` text. |
| `--from <auto\|chordpro\|ireal>` | Force input detection instead of sniffing. |
| `--completions <SHELL>` | Print a shell completion script (`bash`, `zsh`, `fish`, `elvish`, `powershell`). |
| `-V, --version` / `-h, --help` | — |

Several files may be given at once; they render into a single document, one
after another.

Input is capped at 50 MiB, from a file or from stdin.

## Exit codes and streams

| | |
|---|---|
| stdout | the rendered document (text, HTML, PDF bytes, or SVG) unless `-o` is given |
| stderr | parse errors and warnings |
| exit 0 | rendered; there may still be warnings on stderr |
| exit 1 | did not render — a parse error, a missing file, or an oversized input |

## `fmt`

Normalises directive names, spacing, chord spelling and blank lines. It does
**not** transpose and does not change what the song means.

```bash
chordsketch fmt song.cho              # rewrite in place
chordsketch fmt --check song.cho      # exit 1 if it would change; do not write
cat song.cho | chordsketch fmt -      # stdin to stdout
```

## `convert`

Import into ChordPro, or export out of it.

```bash
chordsketch convert sheet.txt -o song.cho          # detect the input format
chordsketch convert --from abc tune.abc -o song.cho
chordsketch convert --from musicxml score.xml -o song.cho
chordsketch convert --to musicxml song.cho -o score.xml
```

`--from` is `auto` (default), `plaintext`, `abc`, or `musicxml`. `plaintext`
means a chords-over-lyrics sheet — chord lines interleaved with lyric lines,
the way chord sites publish them. `--to` currently accepts only `musicxml`;
without it the output is ChordPro.

Use `-` as a file name to read stdin.

## iReal Pro

An `irealb://` or `irealbook://` URL passed as an argument, a file ending in
`.irealb` / `.irealbook`, or a file whose first bytes are one of those URLs, is
routed to the iReal Pro renderer and produces **SVG**. `-f` has no effect on it.

```bash
chordsketch 'irealb://...' -o chart.svg
chordsketch tunes.irealbook -o chart.svg          # a collection renders every song
chordsketch --from chordpro odd.cho               # force ChordPro when the sniff guesses wrong
```

The reverse direction — ChordPro to an `irealb://` URL — is not in the CLI; it
is in the wasm package as `convertChordproToIrealb`.

## Configuration

Config is merged from built-in defaults, `/etc/chordsketch.json`,
`~/.config/chordsketch/chordsketch.json`, a `chordsketch.json` next to the song,
then `-c`, then `-D`, and finally `{+config.KEY: VALUE}` directives inside the
song itself. Files are RRJSON — JSON plus comments, trailing commas, unquoted
keys and dot-separated key paths.

```bash
chordsketch -c charango song.cho -f pdf -o song.pdf   # charango-specific chord diagrams
chordsketch -c guitar song.cho
chordsketch -D settings.columns=2 -f pdf song.cho -o song.pdf
chordsketch --no-default-configs song.cho          # reproducible output, ignoring the machine
```

Pass `--no-default-configs` when the output has to be identical on another
machine — otherwise a user or project config file silently participates.

Full list of settings:
<https://github.com/koedame/chordsketch/blob/main/docs/configuration.md>

## Related surfaces

- **Editors** — a Language Server (`chordsketch-lsp`) and extensions for VS
  Code, Zed, JetBrains, Neovim and Helix:
  <https://github.com/koedame/chordsketch/blob/main/docs/editors.md>
- **CI** — a composite GitHub Action renders ChordPro without a Rust toolchain:
  <https://github.com/koedame/chordsketch/blob/main/docs/github-action.md>
- **Libraries** — Rust, JavaScript, Python, Ruby, Swift and Kotlin bindings:
  <https://github.com/koedame/chordsketch#readme>
