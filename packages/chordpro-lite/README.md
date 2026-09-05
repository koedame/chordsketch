<p align="center">
  <img src="https://raw.githubusercontent.com/koedame/chordsketch/main/assets/logo.svg" alt="ChordSketch" width="80" height="80">
</p>

# @chordsketch/chordpro-lite

[![npm](https://img.shields.io/npm/v/@chordsketch/chordpro-lite)](https://www.npmjs.com/package/@chordsketch/chordpro-lite)

Dependency-free [ChordPro](https://www.chordpro.org/) helpers for [ChordSketch](https://github.com/koedame/chordsketch) — the Rust ChordPro / iReal Pro engine. Three questions about a chart can be answered with plain string work: **which format is it**, **which words are the lyrics**, and **what do its opening lines look like**. This package answers them with no dependencies at all — in particular no WebAssembly — so a server, an edge runtime, a build script or a CLI wrapper can sniff and index charts, and load [`@chordsketch/wasm`](https://www.npmjs.com/package/@chordsketch/wasm) or [`@chordsketch/node`](https://www.npmjs.com/package/@chordsketch/node) only when it actually needs to parse or render one.

Anything beyond those three questions — parsing, transposing, rendering, chord diagrams, iReal Pro charts — is the engine's job, and this package deliberately does not reimplement it.

## Installation

```bash
npm install @chordsketch/chordpro-lite
```

## Quick start

```ts
import { detectFormat, extractLyrics, extractPreview } from '@chordsketch/chordpro-lite';

const chart = `{title: Morning Light}
{artist: The Example Band}

{start_of_verse}
[C]Morning light on a [G]quiet street
[Am]Everything is [F]still
{end_of_verse}`;

detectFormat(chart);
// 'chordpro'

detectFormat('irealb://Morning%20Light=Example=Medium%20Swing=C=n=...');
// 'irealb'

extractLyrics(chart);
// 'Morning light on a quiet street\nEverything is still'

extractPreview(chart);
// [ { chords: ['C', 'G'], lyric: 'Morning light on a quiet street' },
//   { chords: ['Am', 'F'], lyric: 'Everything is still' } ]
```

`extractLyrics` removes each directive whole, so a metadata line such as `{title: ...}` disappears along with its value; a directive sitting inside a lyric line is removed while the surrounding words stay. Read the song's metadata from the engine's parser, not from this output.

## API

| Export | Signature | Notes |
|---|---|---|
| `detectFormat` | `(input: string) => ChartFormat \| null` | `'chordpro'`, `'irealb'`, or `null` when the input matches neither. |
| `extractLyrics` | `(source: string) => string` | Lyric words with chords and directives removed, lines rejoined with `\n`. `''` for an instrumental. |
| `extractPreview` | `(source: string, options?: PreviewOptions) => PreviewLine[]` | The opening chord / lyric lines, capped. |
| `ChartFormat` | `'chordpro' \| 'irealb'` | Type. |
| `PreviewLine` | `{ chords: string[]; lyric: string }` | Type. |
| `PreviewOptions` | see below | Type. |
| `version` | `string` | The package version. |

### `PreviewOptions`

| Option | Type | Default | Meaning |
|---|---|---|---|
| `maxLines` | `number` | `2` | Maximum preview lines returned. Scanning stops once the cap is reached, so a long chart costs only its opening lines. `0` or less returns `[]`. |
| `maxChordsPerLine` | `number` | `6` | Maximum chord symbols kept per line; the rest are dropped. |
| `maxLyricChars` | `number` | `40` | Maximum lyric length per line, counted in code points so a truncation never splits a character. `0` or less returns `''`. |

### How `detectFormat` decides

1. An iReal Pro URL prefix (`irealb://`, `irealbook://`) → `'irealb'`.
2. A ChordPro directive — a value-less one such as `{soc}`, or any name followed by a colon such as `{title: ...}` → `'chordpro'`.
3. An inline chord such as `[G]` or `[Cmaj7/E]` → `'chordpro'`.
4. Otherwise `null`.

Braced text that is not a directive (`{username}`, `{"key": "value"}`) and bracketed text that is not a chord (`[Verse]`, `[invalid]`) are deliberately **not** matched, so plain prose does not register as a chart. The list of value-less directive names is generated from the engine's directive catalog, so it cannot fall behind what the parser recognises.

This is a pre-flight sniff, not a parse. Once the engine is loaded, its own `detect_format` is the richer classifier — it additionally recognises plain chord-over-lyric sheets, which `detectFormat` reports as `null`.

## Links

- [Repository](https://github.com/koedame/chordsketch)
- [Playground](https://chordsketch.koeda.me)
- [Issue tracker](https://github.com/koedame/chordsketch/issues)
- [`@chordsketch/wasm`](https://www.npmjs.com/package/@chordsketch/wasm) — the parsing / rendering engine for browsers
- [`@chordsketch/node`](https://www.npmjs.com/package/@chordsketch/node) — the same engine as a native Node.js addon

## License

MIT
