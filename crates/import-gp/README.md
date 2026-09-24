<p align="center">
  <img src="https://raw.githubusercontent.com/koedame/chordsketch/main/assets/logo.svg" alt="ChordSketch" width="80" height="80">
</p>

# chordsketch-import-gp

Guitar Pro 5 (`.gp5`) to ChordPro importer.

Part of the [ChordSketch](https://github.com/koedame/chordsketch) project.

## Installation

```bash
cargo add chordsketch-import-gp
```

The `chordsketch` CLI uses this crate for `chordsketch convert song.gp5`.

## Usage

```rust,no_run
use chordsketch_chordpro::song_to_chordpro;
use chordsketch_import_gp::{ImportOptions, import_gp5};

let bytes = std::fs::read("song.gp5").unwrap();
// Chords from the first track that has chord diagrams; use
// `ImportOptions::new().with_track(2)` to pick a track.
let result = import_gp5(&bytes, &ImportOptions::new()).unwrap();
for warning in &result.warnings {
    eprintln!("warning: {}", warning.message);
}
print!("{}", song_to_chordpro(&result.output));
```

## API

| Item | Description |
|------|-------------|
| `import_gp5(bytes, &options)` | Imports a GP5 file. Returns `Result<ConversionOutput<Song>, GpError>`: the ChordPro `Song` plus warnings for anything that could not be carried over |
| `ImportOptions` | `track`: 1-based chord track; `None` picks the first track with chord diagrams |
| `GpError` | `TooLarge`, `UnsupportedVersion`, `Truncated`, `InvalidData`, `TrackOutOfRange` |
| `MAX_INPUT_BYTES` | Largest accepted input (16 MiB) |

`ConversionOutput` and the warning types come from
[`chordsketch-convert`](https://crates.io/crates/chordsketch-convert).

## What is imported

- Chord names from the chord diagrams of one track, over the lyrics or on
  chord-only lines. On a track with a capo, Guitar Pro stores chord shapes
  relative to the capo; the importer writes the chords at sounding pitch and
  adds `{capo}`, so a ChordSketch renderer shows the shapes again.
- Lyrics, split into syllables the way Guitar Pro lays them over the notes
  (hyphens, `+` joins, `[comments]`), even when they belong to another track
  than the chords. Line breaks in the lyrics become ChordPro line breaks.
- Section markers as `{start_of_verse}` / `{start_of_chorus}` /
  `{start_of_bridge}` labelled with the marker's name.
- Title, subtitle, artist, album, composer, lyricist, copyright, key, time
  signature, tempo and capo; `{key}` / `{tempo}` directives where they
  change mid-song.

## Limitations

- Only Guitar Pro 5 (versions 5.00 and 5.10). Guitar Pro 3 / 4 (`.gp3`,
  `.gp4`) and Guitar Pro 6 / 7 (`.gpx`, `.gp`) files are rejected with
  `GpError::UnsupportedVersion`.
- Tablature, standard notation, playback data and effects are not imported.
- Repeats are not unrolled; the song is read in written order.
- A diagram whose name is not a chord is spelled from its root and chord
  type; when that is not possible it is omitted with a warning.

## Links

- [ChordSketch repository](https://github.com/koedame/chordsketch)
- [Playground](https://chordsketch.koeda.me)
- [API docs (docs.rs)](https://docs.rs/chordsketch-import-gp)
- [Issue tracker](https://github.com/koedame/chordsketch/issues)

## License

MIT
