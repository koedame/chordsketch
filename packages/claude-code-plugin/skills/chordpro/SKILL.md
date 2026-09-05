---
name: chordpro
description: Work with ChordPro and iReal Pro chord charts using the chordsketch CLI. Use when the user wants to render a chord sheet to text, HTML or PDF, transpose a song or change its key, check a chart for errors, tidy up ChordPro source, convert plain chord-over-lyrics text / ABC / MusicXML to ChordPro, or inspect the structure of a .cho / .chopro / .chordpro / .crd file or an irealb:// URL.
---

# ChordPro

[ChordPro](https://www.chordpro.org/) is a plain-text format for chord charts:
lyrics with chords in square brackets and metadata in braces.

```
{title: Scarborough Fair}
{key: Em}
Are you [Em]going to [G]Scarborough [Em]Fair
```

[ChordSketch](https://github.com/koedame/chordsketch) is a Rust implementation
of it. The `chordsketch` CLI is the tool this skill drives.

## Before anything else

```bash
chordsketch --version
```

If that fails, install it — pick whatever matches the machine:

```bash
brew install --formula koedame/tap/chordsketch   # macOS / Linux
sudo port install chordsketch                    # MacPorts
winget install koedame.chordsketch               # Windows
sudo snap install chordsketch                    # Linux
cargo install chordsketch                        # any platform with Rust
```

Ask before installing. If the user would rather not, `docker run --rm -v "$PWD:/data"
ghcr.io/koedame/chordsketch /data/song.cho` runs it without installing anything.

## What to run

| The user wants | Run |
|---|---|
| a readable chart | `chordsketch song.cho` |
| a web page | `chordsketch -f html song.cho -o song.html` |
| a PDF | `chordsketch -f pdf song.cho -o song.pdf` |
| a different key, one time | `chordsketch -t 2 song.cho` |
| a different key, permanently | edit the source — see [Transpose](#transpose) |
| to know if the file is broken | `chordsketch --warnings-json song.cho > /dev/null` |
| tidy source | `chordsketch fmt song.cho` |
| ChordPro from a chords-over-lyrics text file | `chordsketch convert sheet.txt -o song.cho` |
| the parsed structure as JSON | see [Parse](#parse) |

`chordsketch` accepts several files at once and renders them into one document.
Everything goes to stdout unless `-o` is given.

## Render

The output format is `-f text` (the default), `-f html`, or `-f pdf`.

```bash
chordsketch song.cho                          # chords above lyrics, to stdout
chordsketch -f html song.cho -o song.html     # one self-contained HTML file
chordsketch -f pdf  song.cho -o song.pdf      # A4
```

**Always pass `-o` for PDF.** Without it the PDF bytes go to stdout and end up
in the transcript.

An `irealb://` / `irealbook://` URL, or an `.irealb` / `.irealbook` file, is
detected automatically and rendered as SVG; `-f` does not apply to it.

```bash
chordsketch 'irealb://...' -o chart.svg
```

## Transpose

`-t N` shifts every chord by N semitones for **this render only** — the file is
not touched. Negative values go down.

```bash
chordsketch -t 2 song.cho             # up a whole step
chordsketch -t -1 -f pdf song.cho -o song.pdf
```

Chord spelling follows the song: transposing into a flat key gives `Bb`, not
`A#`.

To make the change **stick**, put a `{transpose: N}` directive in the source
instead. It takes effect from the line it appears on, so put it above `{key:}`
— otherwise the printed key still shows the original and only the chords move.

```
{title: Scarborough Fair}
{transpose: 2}
{key: Em}
```

Both compose: a file carrying `{transpose: 2}` rendered with `-t 1` sounds three
semitones up.

## Validate

```bash
chordsketch --warnings-json song.cho > /dev/null
```

Discarding stdout leaves only the diagnostics, in two layers:

- **Syntax errors** go to stderr as `error: <file>: parse error at line L column C: <what>`
  and the command **exits 1**. Nothing is rendered.
- **Semantic warnings** go to stderr as one JSON object per line,
  `{"source":"render","message":"..."}`, and the command **exits 0**. These are
  advisory — ambiguous chord spellings, a saturated transpose — and the file
  still renders.

So a clean file is *exit 0 with no stderr*. Do not read exit 0 alone as "no
problems"; read the stderr lines.

```
$ chordsketch --warnings-json song.cho > /dev/null
{"source":"render","message":"{transpose} value \"up2\" cannot be parsed as i8, ignored (using 0)"}
```

Without `--warnings-json` the same warnings print as `warning: ...` lines, which
are easier for a human to read and harder to aggregate.

Formatting is a separate question: `chordsketch fmt --check song.cho` exits 1
when a file is not normalised, and prints nothing when it is.

## Parse

The CLI has no machine-readable AST output. When the structure itself is what is
needed — every directive, every chord with its root and quality, section
boundaries — use the published wasm package from Node:

```bash
npm install @chordsketch/wasm
node -e 'const cs=require("@chordsketch/wasm");
console.log(cs.parseChordpro(require("fs").readFileSync(process.argv[1],"utf8")))' song.cho
```

For anything short of that, rendering to text and reading the source is usually
enough — ChordPro is designed to be read.

Export names, the shape of the AST, and the separate `validate()` entry point
are in [references/ast.md](references/ast.md).

## Writing ChordPro

When asked to add chords to lyrics or to write a chart from scratch:

- Chords go inline, immediately before the syllable they land on:
  `Are you [Em]going to [G]Scarborough [Em]Fair`.
- Put `{title:}` first, then `{key:}`, `{artist:}`, `{tempo:}` as known.
- Wrap sections in `{start_of_verse}` / `{end_of_verse}` and
  `{start_of_chorus}` / `{end_of_chorus}`.
- Prefer explicit extended chords — `G7(13)`, `Cadd9` — over bare stacks like
  `G13` or `C(9)`: the intended notes are unambiguous, and recent versions warn
  about the bare form.
- Run the file through `chordsketch --warnings-json` before handing it back.

## More

- [references/cli.md](references/cli.md) — every flag, the `fmt` and `convert`
  subcommands, config files and presets, iReal Pro input.
- [references/ast.md](references/ast.md) — the wasm package: exports, AST shape,
  `validate()`.
- [ChordPro format reference](https://www.chordpro.org/chordpro/) — the
  directives themselves.
