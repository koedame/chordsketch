# chordsketch-render-html

HTML renderer for [ChordPro](https://www.chordpro.org/) documents.
Produces self-contained HTML5 documents with chords positioned above
lyrics.

Part of the [ChordSketch](https://github.com/koedame/chordsketch) project.

## Usage

```rust
use chordsketch_core::parser::parse;
use chordsketch_render_html::render_song;

let input = "{title: Amazing Grace}\n[G]Amazing [G7]grace";
let song = parse(input).unwrap();
let html = render_song(&song);
```

## Features

- Self-contained HTML5 output
- Chord positioning above lyrics
- Metadata display (title, subtitle, artist)
- Section styling
- HTML escaping for safe output

## Documentation

[API documentation on docs.rs](https://docs.rs/chordsketch-render-html)

## License

[MIT](../../LICENSE)
