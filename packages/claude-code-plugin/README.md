<p align="center">
  <img src="https://raw.githubusercontent.com/koedame/chordsketch/main/assets/logo.svg" alt="ChordSketch" width="80" height="80">
</p>

# ChordSketch for Claude Code

A [Claude Code](https://claude.com/claude-code) plugin that teaches Claude to
work with [ChordPro](https://www.chordpro.org/) chord charts through the
`chordsketch` CLI — rendering to text, HTML and PDF, transposing, validating,
formatting, and converting from plain chord-over-lyrics sheets, ABC and
MusicXML.

## Installation

```
/plugin marketplace add koedame/chordsketch
/plugin install chordsketch@chordsketch
```

Both lines are typed inside Claude Code. The plugin carries the skill only —
install the CLI itself separately, from
[any of the channels in the main README](https://github.com/koedame/chordsketch#installation):

```bash
brew install --formula koedame/tap/chordsketch
```

## Using it

Ask in plain language. The skill loads when the request is about a chord chart:

- "render `song.cho` as a PDF"
- "put this a whole step up"
- "is there anything wrong with this chart?"
- "add chords to these lyrics"
- "turn this chords-over-lyrics text file into ChordPro"

Or invoke it directly with `/chordpro`.

## What is in it

| File | Contents |
|---|---|
| `skills/chordpro/SKILL.md` | when to use the skill, and the command for each task |
| `skills/chordpro/references/cli.md` | every CLI flag, `fmt` and `convert`, config files, iReal Pro input |
| `skills/chordpro/references/ast.md` | parsing to JSON with `@chordsketch/wasm` |

The reference files are loaded on demand, so the always-resident cost is
`SKILL.md` alone.

## Versioning

The plugin version tracks the ChordSketch workspace version. Claude Code caches
plugins per version, so a release is what makes an updated skill reach an
installed client; `/plugin update chordsketch@chordsketch` pulls it in.

## Links

- [ChordSketch](https://github.com/koedame/chordsketch) — the project
- [Playground](https://chordsketch.koeda.me) — try the renderer in a browser
- [Documentation](https://koedame.github.io/chordsketch/docs/)
- [Issues](https://github.com/koedame/chordsketch/issues)

## License

MIT
