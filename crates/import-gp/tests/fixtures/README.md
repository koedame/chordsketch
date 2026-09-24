# Guitar Pro 5 fixtures

Real `.gp5` files for the importer's tests, each with a golden `.cho`
file holding the exact ChordPro `song_to_chordpro` prints for it.

| File | Song | Licence | GP version | What it exercises |
|------|------|---------|------------|-------------------|
| `amazing-grace.gp5` | *Amazing Grace* — words John Newton (1779), traditional melody | Public domain; arrangement written for this suite | 5.10 | 3/4, G major, one track, lyrics on the chord track with a line break per phrase, hyphenated syllables, chords on the rest before a pickup, one section marker |
| `harbor-lights.gp5` | *Harbor Lights* — written for this suite | MIT, like the repository | 5.00 | Three tracks (lyrics on the melody, chords on the rhythm guitar, a bass with no chords), capo 2, E minor, Intro / Verse / Chorus, a chord-only intro, a tempo change and a 2/4 bar, two lyric lines starting at different measures, `+` / `[comment]` / `__` in the lyrics, an unnamed chord diagram, a chord in voice 2, triplets, dotted notes, rests, and note and beat effects (bend, slide, hammer-on, harmonic, grace note, vibrato, palm mute, dead notes, stroke, beat text) |
| `greensleeves.gp5` | *Greensleeves* — traditional English ballad (16th century) | Public domain; arrangement written for this suite | 5.10 | 6/8, A minor, lyrics without line breaks, chords on beats 1 and 4 carried only by the bass in voice 2, Verse / Refrain |

## How they were made

`generate.py` writes all three with
[PyGuitarPro](https://github.com/Perlence/PyGuitarPro) 0.11, an
open-source reader and writer of the Guitar Pro 3–5 binary formats. It is
used as a tool only; none of its code is part of this repository. To
regenerate:

```bash
python3 -m venv /tmp/gp-venv
/tmp/gp-venv/bin/pip install pyguitarpro==0.11
/tmp/gp-venv/bin/python crates/import-gp/tests/fixtures/generate.py
```

The script is deterministic, so an unchanged script reproduces the files
byte for byte. When a change to the script or the importer changes a
golden file, review the new `.cho` by eye before committing it.

The files were also checked with a second, independent reader,
[alphaTab](https://github.com/CoderLine/alphaTab), which reads the same
titles, sections, chord names and lyrics from them.

## Why not files saved by Guitar Pro itself

Guitar Pro is proprietary and most `.gp5` files in circulation are
transcriptions of copyrighted songs, so there is no supply of files this
repository could redistribute. Writing them with an open-source
implementation of the format, from songs that are free to use, keeps the
fixtures redistributable and reproducible.
