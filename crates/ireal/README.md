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
| `Section`, `SectionLabel` | struct + 4-variant enum (`Letter(c)`, `Verse`, `Intro`, `Custom(s)`) | Labelled block of bars. |
| `Bar`, `BarLine`, `Ending` | struct + 5-variant enum + `NonZeroU8` newtype | One measure with opening / closing barline, chords, ending number, optional `MusicalSymbol`. |
| `BarChord`, `BeatPosition` | structs | Chord placed at a beat position inside a bar. |
| `Chord`, `ChordRoot`, `ChordQuality`, `Accidental` | structs + enums | Root, quality (12 named + `Custom`), optional bass note, accidental. |
| `KeySignature`, `KeyMode`, `TimeSignature` | structs + enum | Key (C major default) and time signature (4/4 default). |
| `MusicalSymbol` | enum (`Segno`, `Coda`, `DaCapo`, `DalSegno`, `Fine`, `Fermata`) | Bar-attached navigation symbols. |
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

## Scope

This crate currently parses the **iReal Pro export format** —
the obfuscated `irealb://` URL produced by the iReal Pro app
(7..=9 `=`-separated fields, music body prefixed with the
`1r34LbKcu7` sentinel and `obfusc50`-scrambled) — together with
the 6-field `irealbook://` plain-text variant
(`Title=Composer=Style=Key=TimeSig=Music`). Both inputs serialize
back through `irealb_serialize` / `irealbook_serialize`.

Open-protocol plain-text **serialization** to the form documented
at
[`irealpro.com/ireal-pro-custom-chord-chart-protocol`](https://www.irealpro.com/ireal-pro-custom-chord-chart-protocol)
is tracked under [#2425](https://github.com/koedame/chordsketch/issues/2425).
Several player-recognised tokens documented in the iReal Pro Help
Center are also absent from the AST today; they are tracked
alongside #2425 under the open-protocol-spec compliance umbrella
[#2423](https://github.com/koedame/chordsketch/issues/2423).

Token coverage as of the latest release:

### Supported tokens

| Token / shape | AST surface |
|---|---|
| `irealb://` 7..=9-field obfuscated export | `parse` / `parse_collection` |
| `irealbook://` 6-field plain-text (`Title=Composer=Style=Key=TimeSig=Music`) | `parse` / `parse_collection` ([#2424](https://github.com/koedame/chordsketch/issues/2424)) |
| `(altchord)` parenthesised alternate chord | `Chord::alternate` ([#2428](https://github.com/koedame/chordsketch/issues/2428)) |
| `n` No-Chord | `Bar::no_chord` ([#2429](https://github.com/koedame/chordsketch/issues/2429)) |
| `Kcl` / `x` / `r` simile (collapsed to a single flag) | `Bar::repeat_previous` ([#2430](https://github.com/koedame/chordsketch/issues/2430)) |
| `<text>` staff-text caption (verbatim preservation) | `Bar::text_comment` |
| `Y` / `YY` / `YYY` between-system vertical-space hint | `Bar::system_break_space` ([#2434](https://github.com/koedame/chordsketch/issues/2434)) |
| `S` Segno, `Q` Coda, `f` Fermata | `MusicalSymbol::{Segno, Coda, Fermata}` ([#2431](https://github.com/koedame/chordsketch/issues/2431)) |
| `<D.C.>` / `<D.S.>` / `<Fine>` macro prefixes (collapsed) | `MusicalSymbol::{DaCapo, DalSegno, Fine}` |
| `*A`..`*D` / `*i` / `*v` / `*V` section labels | `SectionLabel::{Letter, Intro, Verse}` ([#2432](https://github.com/koedame/chordsketch/issues/2432)) |
| `N1` / `N2` / `N3` ending brackets (numbers ≥ 1) | `Bar::ending` |

### Unsupported tokens

| Token / shape | Sub-issue |
|---|---|
| Open-protocol `irealbook://` plain-text **serializer** | [#2425](https://github.com/koedame/chordsketch/issues/2425) |
| Full staff-text content (custom text, vertical position, repeat count override) | [#2426](https://github.com/koedame/chordsketch/issues/2426) |
| 11 D.C. / D.S. macro variants (`<D.C. al Coda>`, `<D.S. al Fine>`, etc.) collapse to single variants | [#2427](https://github.com/koedame/chordsketch/issues/2427) |
| Chord-size markers `s` (small) / `l` (large) | [#2433](https://github.com/koedame/chordsketch/issues/2433) |
| Pause-slash `p` (repeat preceding chord) | [#2435](https://github.com/koedame/chordsketch/issues/2435) |
| `N0` no-text ending | [#2436](https://github.com/koedame/chordsketch/issues/2436) |
| `Break` drum-silence staff-text token | [#2448](https://github.com/koedame/chordsketch/issues/2448) |
| Compound time-signature additive groupings (`2+3`, `3+4`, `3+2+2`) | [#2449](https://github.com/koedame/chordsketch/issues/2449) |
| Section-label reconciliation: `Chorus`/`Bridge`/`Outro` already removed from AST; convert-crate `SectionLabel::Custom` usage not yet cleaned up | [#2450](https://github.com/koedame/chordsketch/issues/2450) |
| `END` song-terminator symbol distinct from Fermata | [#2451](https://github.com/koedame/chordsketch/issues/2451) |

Umbrella [#2423](https://github.com/koedame/chordsketch/issues/2423)
holds the canonical audit; this table is a release-time snapshot.
When a sub-issue lands, move its row from Unsupported to
Supported in the same PR — `.claude/rules/release-doc-sync.md`
catches drift at release-cut time.

## File extension convention

The upstream iReal Pro app does not register a file extension —
URLs are typically pasted into clipboard / email / chat without a
backing file. ChordSketch establishes the following project-local
convention so the URL can be saved to disk and round-tripped:

| Extension | Body | URL prefix |
|---|---|---|
| `.irealb` | Single song — one `irealb://...` URL on a single line | `irealb://` |
| `.irealbook` | Multi-song collection — one `irealbook://...` URL on a single line | `irealbook://` |

`parse_collection` accepts both prefixes; the extension distinction
is for dialog filters, OS associations, and editor-mode hints. The
authoritative grammar reference is [`FORMAT.md`](./FORMAT.md). The
convention is consumed by the CLI sniff
([`crates/cli/src/main.rs`](../cli/src/main.rs)), the Tauri desktop
file associations
([`apps/desktop/src-tauri/tauri.conf.json`](../../apps/desktop/src-tauri/tauri.conf.json)),
and the VS Code / JetBrains / Zed editor integrations.

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
