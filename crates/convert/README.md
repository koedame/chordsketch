<p align="center">
  <img src="https://raw.githubusercontent.com/koedame/chordsketch/main/assets/logo.svg" alt="ChordSketch" width="80" height="80">
</p>

# chordsketch-convert

[![crates.io](https://img.shields.io/crates/v/chordsketch-convert)](https://crates.io/crates/chordsketch-convert)

ChordPro ↔ iReal Pro format-conversion bridge (trait scaffold).

This crate is the trait scaffold for the bidirectional converter
tracked under [#2050](https://github.com/koedame/chordsketch/issues/2050).
It deliberately ships only the public API shape — every conversion
function returns `ConversionError::NotImplemented` until the
direction-specific follow-up issues land.

Part of the [ChordSketch](https://github.com/koedame/chordsketch) project.

## Installation

Add via `cargo add` (resolves to the latest published version automatically):

```bash
cargo add chordsketch-convert
```

Or pin manually — replace `VERSION` with the value shown on the badge above:

```toml
[dependencies]
chordsketch-convert = "VERSION"
```

## Quick start

```rust
use chordsketch_chordpro::ast::Song;
use chordsketch_convert::{ConversionError, chordpro_to_ireal};

let song = Song::new();
match chordpro_to_ireal(&song) {
    Ok(output) => {
        let _ireal = output.output;
        for warning in output.warnings {
            eprintln!("warning: {} ({:?})", warning.message, warning.kind);
        }
    }
    Err(ConversionError::NotImplemented(tracking)) => {
        eprintln!("conversion stub — see {tracking}");
    }
    Err(e) => eprintln!("conversion failed: {e}"),
}
```

## API

| Item | Signature | Notes |
|---|---|---|
| `Converter<S, T>` | `fn convert(&self, source: &S) -> Result<ConversionOutput<T>, ConversionError>` | Generic trait every direction implements. |
| `ConversionOutput<T>` | struct with `output: T` and `warnings: Vec<ConversionWarning>` | Successful (possibly lossy) result. `lossless(t)` and `with_warnings(t, ws)` constructors. |
| `ConversionError` | enum (`NotImplemented`, `InvalidSource`, `UnrepresentableTarget`) | Failure modes; new variants are appended only. |
| `ConversionWarning`, `WarningKind` | struct + 3-variant enum (`LossyDrop`, `Approximated`, `Unsupported`) | Non-fatal information loss surfaced to the caller. |
| `ChordProToIreal`, `IrealToChordPro` | unit struct, `Converter` impls | Marker types for the two directions. |
| `chordpro_to_ireal`, `ireal_to_chordpro` | free fn wrappers | Ergonomic shortcuts for the marker-type `convert` calls. |

## Roadmap

| Direction | Tracking issue |
|---|---|
| iReal → ChordPro (tempo / style as directives) | [#2053](https://github.com/koedame/chordsketch/issues/2053) |
| ChordPro → iReal (lossy lyrics drop) | [#2061](https://github.com/koedame/chordsketch/issues/2061) |
| Auto-detect input format in CLI | [#2066](https://github.com/koedame/chordsketch/issues/2066) |
| Expose across WASM / NAPI / FFI | [#2067](https://github.com/koedame/chordsketch/issues/2067) |

## Relationship to `chordsketch-convert-musicxml`

`chordsketch-convert-musicxml` predates this crate and binds the
ChordPro AST to MusicXML directly via free functions. The new
`chordsketch-convert` crate is the conversion home for formats that
share a small intermediate concept set (warnings, lossy drops,
approximations) — namely the ChordPro ↔ iReal bridge and its
expected MusicXML / Guitar Pro siblings. Consolidating the
musicxml converter into this crate is tracked in a future cleanup;
it would be a breaking change that does not block v0.3.0.

## Links

- [Project repository](https://github.com/koedame/chordsketch)
- [Playground](https://chordsketch.koeda.me)
- [API docs (docs.rs)](https://docs.rs/chordsketch-convert)
- [Issue tracker](https://github.com/koedame/chordsketch/issues)

## License

MIT.
