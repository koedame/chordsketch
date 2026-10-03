<p align="center">
  <img src="https://raw.githubusercontent.com/koedame/chordsketch/main/assets/logo.svg" alt="ChordSketch" width="80" height="80">
</p>

# ChordSketch for JetBrains IDEs

Syntax highlighting for [ChordPro](https://www.chordpro.org/) files in
JetBrains IDEs (IntelliJ IDEA, PyCharm, WebStorm, GoLand, CLion, etc.).

Part of the [ChordSketch](https://github.com/koedame/chordsketch) project
— a Rust implementation of the ChordPro file format.

## Features

- Syntax highlighting for directives, chords, comments, and delegate blocks
- File type recognition for `.cho`, `.chordpro`, and `.chopro` extensions
- Bracket matching and auto-closing for `{ }` and `[ ]`

## Installation

Install from the [JetBrains Marketplace](https://plugins.jetbrains.com/):

1. Open **Settings** → **Plugins** → **Marketplace**
2. Search for **ChordSketch**
3. Click **Install**

## Requirements

- IntelliJ Platform 2024.1 or later
- The **TextMate Bundles** plugin must be enabled (bundled and enabled by
  default in all JetBrains IDEs)

## Development

### Prerequisites

- JDK 17+

### Build

```bash
./gradlew buildPlugin
```

The plugin ZIP is generated at `build/distributions/chordsketch-*.zip`.

### Run in sandbox

```bash
./gradlew runIde
```

This launches a sandboxed IntelliJ IDEA instance with the plugin installed.

### Verify

```bash
./gradlew verifyPlugin
```

## TextMate Grammar Sync

The TextMate grammar files in `textmate/chordpro/` are copies of the
canonical files in `syntaxes/` at the repository root. CI verifies they
are identical. When updating the grammar, copy the updated files:

```bash
cp ../../syntaxes/chordpro.tmLanguage.json textmate/chordpro/
cp ../../syntaxes/language-configuration.json textmate/chordpro/
```

## Links

- [ChordSketch repository](https://github.com/koedame/chordsketch)
- [Playground](https://chordsketch.koeda.me)
- [Issue tracker](https://github.com/koedame/chordsketch/issues)

## Other people's names

ChordPro is the name of a file format and of its reference program by The ChordPro Team; iReal Pro is a product of Technimo LLC; MusicXML is published by the W3C Music Notation Community Group; Bravura is a font by Steinberg Media Technologies GmbH. These names belong to their owners. ChordSketch is not affiliated with or endorsed by any of them.

## License

MIT
