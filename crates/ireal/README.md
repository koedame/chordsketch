<p align="center">
  <img src="https://raw.githubusercontent.com/koedame/chordsketch/main/assets/logo.svg" alt="ChordSketch" width="80" height="80">
</p>

# chordsketch-ireal

iReal Pro AST types and a zero-dependency JSON debug serializer / parser.

This crate is the foundational scaffold for the iReal Pro feature
set tracked under [#2050](https://github.com/koedame/chordsketch/issues/2050).
It deliberately ships only the AST shape — no `irealb://` URL parser,
no URL serializer, no renderer — so the cross-cutting AST stabilises
before the follow-up crates layer features on top.

Part of the [ChordSketch](https://github.com/koedame/chordsketch) project.

## Status

Pre-1.0 scaffold. The AST is intentionally minimal: every named
type and variant is grounded in `#2055`'s acceptance criteria. Field
additions and new enum variants are expected to be non-breaking; if
a follow-up crate needs a structural change, the change happens in
this crate first and is reflected in `ARCHITECTURE.md`.

## Usage

```rust
use chordsketch_ireal::{
    Chord, ChordQuality, ChordRoot, IrealSong, ToJson,
};

let mut song = IrealSong::new();
song.title = "Autumn Leaves".to_string();
// ... build sections / bars / chords ...

// JSON debug output for golden-snapshot tests.
let json = song.to_json_string();
assert!(json.contains("\"title\":\"Autumn Leaves\""));
```

## Features

- AST types for an iReal Pro chart: `IrealSong`, `Section`, `Bar`,
  `Chord`, `TimeSignature`, `KeySignature`, repeat / ending markers,
  `MusicalSymbol`.
- Zero external dependencies (consistent with `chordsketch-chordpro`).
- Structural equality (`PartialEq` / `Eq`) on every node.
- Hand-rolled JSON debug serializer (`ToJson` trait) with byte-stable
  output ordering — useful for golden snapshots in follow-up crates.
- Round-trip JSON deserializer (`FromJson` trait) sized to exactly the
  format `ToJson` emits; rejects drift outside that subset rather than
  silently coercing.

## Roadmap

| Feature | Tracking issue |
|---|---|
| `irealb://` URL parser | [#2054](https://github.com/koedame/chordsketch/issues/2054) |
| AST → `irealb://` URL serializer | [#2052](https://github.com/koedame/chordsketch/issues/2052) |
| iReal → ChordPro conversion | [#2053](https://github.com/koedame/chordsketch/issues/2053) |
| ChordPro → iReal conversion (lossy) | [#2061](https://github.com/koedame/chordsketch/issues/2061) |
| SVG / PNG / PDF renderer | [#2058](https://github.com/koedame/chordsketch/issues/2058) and follow-ups |
| CLI auto-detect | [#2066](https://github.com/koedame/chordsketch/issues/2066) |
| WASM / NAPI / FFI bindings | [#2067](https://github.com/koedame/chordsketch/issues/2067) |

## License

MIT.
