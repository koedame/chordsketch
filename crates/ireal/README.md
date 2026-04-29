<p align="center">
  <img src="https://raw.githubusercontent.com/koedame/chordsketch/main/assets/logo.svg" alt="ChordSketch" width="80" height="80">
</p>

# chordsketch-ireal

[![crates.io](https://img.shields.io/crates/v/chordsketch-ireal)](https://crates.io/crates/chordsketch-ireal)

iReal Pro AST types, a zero-dependency JSON debug serializer /
parser, and an `irealb://` URL parser + serializer.

This crate is the foundation for the iReal Pro feature set tracked
under [#2050](https://github.com/koedame/chordsketch/issues/2050).
It carries the AST shape, the URL parser (#2054), the URL
serializer (#2052), and a debug-only JSON dump format. Conversion
to / from ChordPro (#2053 / #2061) and the iReal-style renderer
(#2058 et seq) live in their own crates.

Part of the [ChordSketch](https://github.com/koedame/chordsketch) project.

## Installation

Replace `VERSION` with the latest release shown on the badge above.

```toml
[dependencies]
chordsketch-ireal = "VERSION"
```

Or via `cargo add`:

```bash
cargo add chordsketch-ireal
```

## Quick start

```rust
use chordsketch_ireal::{
    Chord, ChordQuality, ChordRoot, FromJson, IrealSong, Section,
    SectionLabel, ToJson,
};

let mut song = IrealSong::new();
song.title = "Autumn Leaves".to_string();
song.sections.push(Section::new(SectionLabel::Letter('A')));

// JSON debug output for golden-snapshot tests.
let json = song.to_json_string();
assert!(json.contains("\"title\":\"Autumn Leaves\""));

// Round-trip back through the deserializer.
let parsed = IrealSong::from_json_str(&json).expect("round-trip succeeds");
assert_eq!(parsed, song);
```

## API

| Item | Signature | Notes |
|---|---|---|
| `IrealSong` | struct with `title`, `composer`, `style`, `key_signature`, `time_signature`, `tempo`, `transpose`, `sections` | Root AST node. `IrealSong::new()` builds an empty `C major` 4/4 chart. |
| `Section`, `SectionLabel` | struct + 7-variant enum (`Letter(c)`, `Verse`, `Chorus`, `Intro`, `Outro`, `Bridge`, `Custom(s)`) | Labelled block of bars. |
| `Bar`, `BarLine`, `Ending` | struct + 5-variant enum + `NonZeroU8` newtype | One measure with opening / closing barline, chords, ending number, optional `MusicalSymbol`. |
| `BarChord`, `BeatPosition` | structs | Chord placed at a beat position inside a bar. |
| `Chord`, `ChordRoot`, `ChordQuality`, `Accidental` | structs + enums | Root, quality (12 named + `Custom`), optional bass note, accidental. |
| `KeySignature`, `KeyMode`, `TimeSignature` | structs + enum | Key (C major default) and time signature (4/4 default). |
| `MusicalSymbol` | enum (`Segno`, `Coda`, `DaCapo`, `DalSegno`, `Fine`) | Bar-attached navigation symbols. |
| `ToJson` | `fn to_json(&self, &mut String)` and `fn to_json_string(&self) -> String` | Hand-rolled, byte-stable, compact JSON. |
| `FromJson` | `fn from_json_str(&str) -> Result<Self, JsonError>` and `fn from_json_value(&JsonValue) -> Result<Self, JsonError>` | Round-trip-only deserializer; accepts only the subset `ToJson` emits. |
| `parse_json` | `fn parse_json(&str) -> Result<JsonValue, JsonError>` | Free function for the underlying JSON value tree. |
| `parse` / `parse_collection` | `fn parse(url: &str) -> Result<IrealSong, ParseError>` and `fn parse_collection(url: &str) -> Result<(Vec<IrealSong>, Option<String>), ParseError>` | `irealb://` / `irealbook://` URL parser. See `FORMAT.md` for the grammar. |
| `ParseError` | enum, `Debug + Display + Error` | Error variants from the URL parser. |
| `irealb_serialize` / `irealbook_serialize` | `fn irealb_serialize(song: &IrealSong) -> String` and `fn irealbook_serialize(songs: &[IrealSong], name: Option<&str>) -> String` | Inverse of `parse` / `parse_collection`. AST-level round trip; URL bytes need not match the original. |

Validating constructors: `TimeSignature::new`, `Ending::new`,
`BeatPosition::on_beat` all return `Option`. Direct field
mutation bypasses these checks — see the module-level "Public-field
mutation contract" comment in `ast.rs`.

## Configuration / limits

The deserializer enforces hard caps to keep adversarial input
bounded:

| Constant | Default | Purpose |
|---|---|---|
| `MAX_INPUT_BYTES` | 4 MiB | Total input length |
| `MAX_DEPTH` | 128 | Container nesting (objects + arrays) |
| `MAX_ARRAY_LEN` | 65 536 | Single-array element count |
| `MAX_OBJECT_FIELDS` | 65 536 | Single-object field count |
| `MAX_STRING_CHARS` | 1 048 576 | Decoded length of any single JSON string |

All constants are `pub` in `chordsketch_ireal::json`.

## Roadmap

| Feature | Tracking issue |
|---|---|
| iReal → ChordPro conversion | [#2053](https://github.com/koedame/chordsketch/issues/2053) |
| ChordPro → iReal conversion (lossy) | [#2061](https://github.com/koedame/chordsketch/issues/2061) |
| SVG / PNG / PDF renderer | [#2058](https://github.com/koedame/chordsketch/issues/2058) and follow-ups |
| CLI auto-detect | [#2066](https://github.com/koedame/chordsketch/issues/2066) |
| WASM / NAPI / FFI bindings | [#2067](https://github.com/koedame/chordsketch/issues/2067) |

## Links

- [Project repository](https://github.com/koedame/chordsketch)
- [Playground](https://chordsketch.koeda.me)
- [API docs (docs.rs)](https://docs.rs/chordsketch-ireal)
- [Issue tracker](https://github.com/koedame/chordsketch/issues)

## License

MIT.
