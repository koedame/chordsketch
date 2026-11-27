# Known Deviations from Perl ChordPro

**Compared against**: Perl ChordPro core v6.101.0 (`App::Music::ChordPro`,
release R6.101.0, the version recorded in `.github/upstream-version`).

ChordSketch aims to read the same ChordPro files as the Perl implementation.
It is **not** a drop-in replacement: it does not reproduce the Perl output
byte for byte, it does not implement every directive and configuration key,
and it offers fewer output formats. This document lists the differences that
have been checked.

## What was compared

Perl ChordPro R6.101.0 was run over the 55 files in `tests/corpus/` (see
`tests/corpus/README.md`). The `text` output is compared on every `cargo test`;
the HTML output is not.

### Text output (checked in CI)

`tests/perl-baseline/text/` holds the text Perl prints for each corpus file.
CI does not install Perl;
the test `crates/cli/tests/perl_comparison.rs` renders the same files with
ChordSketch, passes both outputs through the normalisation described below,
and compares them.

<!-- perl-compare:summary:start -->
| Format | Identical after normalisation | Different (listed below) | Perl failed to render |
|--------|-------------------------------|--------------------------|-----------------------|
| `text` | 38 | 7 | 10 |
<!-- perl-compare:summary:end -->

A file whose output still differs after normalisation must be listed in
`tests/perl-baseline/accepted-differences.txt` with a reason. The test fails
when

- a file differs and is not listed (the output got worse),
- a listed file now matches (take it off the list),
- the saved Perl output was made with another release than the one in
  `.github/upstream-version`, or
- a corpus file has no saved Perl output.

The files that still differ:

<!-- perl-compare:accepted:start -->
| File | Why the output differs |
|------|------------------------|
| `delegate/01-abc.cho` | Perl has no ABC tooling installed and prints an empty image placeholder (`+ image: <none>`); ChordSketch prints a note that the block is omitted from text output |
| `delegate/02-lilypond.cho` | Perl has no LilyPond tooling installed and prints an empty image placeholder (`+ image: <none>`); ChordSketch prints a note that the block is omitted from text output |
| `delegate/03-svg.cho` | Perl prints an empty image placeholder (`+ image: <none>`) for the SVG block; ChordSketch prints a note that the block is omitted from text output |
| `delegate/05-multiple-delegates.cho` | Same as the ABC, LilyPond and SVG files above: placeholder against omission note for each delegate block |
| `directives/01-metadata.cho` | `{capo: 2}` lowers every chord by 2 semitones in ChordSketch; Perl prints the chords as written |
| `multi-song/03-songs-with-metadata.cho` | `{capo: 3}` lowers every chord of the second song by 3 semitones in ChordSketch; Perl prints the chords as written. Two of the lowered chords are also spelled `Gbm` and `Db` where F# minor would use sharps |
| `multi-song/04-song-with-transpose.cho` | After `{transpose: 3}` ChordSketch spells the chords for the flat-side key (`Eb`, `Ab`, `Bb`); Perl spells them with sharps (`D#`, `G#`, `A#`) |
<!-- perl-compare:accepted:end -->

To bump the upstream release or change the corpus, install the matching Perl
ChordPro and run `scripts/update-perl-baseline.sh`. It
rewrites the saved output and the generated parts of this document.

#### Normalisation

Both outputs are reduced to a common form before they are compared. Each rule
removes a presentation choice described under "Text Renderer Differences":

| Rule | Effect |
|------|--------|
| Line endings, quotes | CRLF becomes LF; typographic quotes become straight quotes. |
| Title, subtitle | Perl's `-- Title:` / `-- Subtitle:` prefix is dropped. |
| Section markers | `-- Start of verse` and `[Verse]` both become one `SECTION verse` line; Perl's `-- End of ...` line is dropped. |
| Comments | `-- text`, `(text)`, `(*text*)` and `[text]` become one `COMMENT text` line. |
| Chorus recall | Perl's `{chorus}` line is replaced by the text of the preceding chorus. |
| Hyphen fill | On both sides, runs of hyphens next to a space (`la la la-`, `- note`) become spaces. |
| Blank lines | Blank lines and trailing spaces are ignored. |
| ChordSketch-only lines | The metadata lines (`[Key: ...]`, `[Tempo: ...]`, ...), `[Image: ...]` lines and grid rows are dropped. |
| Perl-only lines | `-- New page`, `-- Column break` and `-- New song` are dropped. |

What the rules keep: chord names, the column of each chord over the lyrics,
lyric text, and the order of sections. The test suite checks that a changed
chord, a moved chord, a changed lyric and a reordered section each still
make the outputs differ.

What the rules hide, so that a change in these areas is not caught here:

- the number of blank lines between and inside sections;
- hyphens next to a space on either side: Perl's fill hyphens, but also a
  hyphen that the file itself has there (a ` - ` in a lyric, `A-` as a chord
  name), so a change to one of those is not caught;
- whether a comment is plain, italic or boxed, and whether a heading is a
  title or a subtitle;
- the metadata lines, image lines and grid rows ChordSketch prints.

The rules were written against these 55 files. A new corpus file can contain
output the rules do not cover; it then appears as a difference and has to be
either fixed or accepted with a reason.

### HTML output (not compared in CI)

The HTML and PDF output use their own stylesheet and layout and are not
intended to match Perl's markup or page layout. PDF output is not compared at
all. When the HTML output was last compared by hand
(`scripts/compare-with-perl.sh html`), no file was identical, 52 differed and
Perl failed on 3.

What CI also checks is the directive coverage described in the next section.

## Directive coverage

Every documented directive in the R6.101.0 directive table, its abbreviations, the
metadata keys of its default configuration, and its
`chord`/`chorus`/`footer`/`grid`/`label`/`tab`/`text`/`title`/`toc` ×
`font`/`size`/`colour` properties is parsed by ChordSketch, with six
exceptions. The test `crates/chordpro/tests/upstream_directives.rs` holds the
snapshot and fails if either side drifts.

The six names are directives that ChordPro itself documents as obsolete,
deprecated or not implemented. ChordSketch accepts them without error and
ignores them:

| Directive | Upstream status | Upstream behaviour |
|-----------|-----------------|--------------------|
| `{grid}` / `{g}` | obsolete, use `{diagrams}` | same as `{diagrams}` |
| `{no_grid}` / `{ng}` | obsolete, use `{diagrams: off}` | same as `{diagrams: off}` |
| `{titles: left\|right\|center}` | deprecated, use the configuration file | sets title alignment |
| `{pagesize}` | not implemented since ChordPro 5.0 (`{pagetype}` is documented the same way) | the Perl code still maps it to `{pagetype}` |

`{start_of_grille}` / `{end_of_grille}` are left out of this snapshot.
Neither ChordPro's own directive documentation nor this repository's test
corpus corroborates them as directives ChordPro specifically recognises, as
opposed to the generic `start_of_<name>` / `end_of_<name>` fallback that
accepts any name as a custom section (the same path a user-written
`{start_of_intro}` takes). ChordSketch parses them that way: as an ordinary
custom section titled "Grille", not as a grid.

Being parsed is not the same as being rendered the way Perl renders it. The
sections below describe where the output differs.

## Output formats and configuration

- Perl ChordPro can also produce ChordPro, JSON, LaTeX, Markdown, MMA and
  metadata output. ChordSketch produces `text`, `html` and `pdf` (plus SVG for
  iReal Pro charts).
- Configuration uses the same RRJSON syntax, but ChordSketch reads
  `chordsketch.json` and the keys listed in
  [`docs/configuration.md`](configuration.md). An existing
  `chordpro.json` is not picked up, and upstream keys that ChordSketch does
  not implement are ignored.
- Delegate environments (`{start_of_abc}`, `{start_of_ly}`) need ABC or
  LilyPond tooling installed on the machine and the matching `delegates.*`
  key set to `true` (they are off by default). Without both the section is
  not drawn. In the HTML run above, Perl failed on the corpus files that use
  these tools.

## Text Renderer Differences

The ChordPro specification defines the `.cho` file format but does **not**
prescribe a text output format. Both implementations produce valid
renderings; they differ in presentation style.

### Title Display

| Perl | Rust |
|------|------|
| `-- Title: My Song` | `My Song` |

Perl prefixes the title with `-- Title:`. Rust renders it as a plain heading.

### Section Markers

| Perl | Rust |
|------|------|
| `-- Start of verse` | `[Verse]` |
| `-- End of verse` | *(not displayed)* |

Perl uses `-- Start of ...` / `-- End of ...` markers. Rust uses `[Section]`
headers at the start only, matching common lead-sheet convention.

### Comments

| Perl | Rust |
|------|------|
| `-- comment text` | `(comment text)` |
| *(italic)* `-- Play softly` | `(*Play softly*)` |
| *(boxed)* `-- Note` | `[Note]` |

Perl uses `--` prefix for all comment styles. Rust uses parentheses/brackets
with style indicators.

### Metadata Lines

Rust prints `{key}` and `{tempo}` as `[Key: G major]` and
`[Tempo: 120 BPM (Allegro)]` under the title. Perl prints no such line in its
text output.

### Grid Sections

Perl's text output contains only the start and end markers of a
`{start_of_grid}` section. Rust prints the grid rows (`| G . . . | C . . . |`).

### Chorus Recall

Perl prints a literal `{chorus}` for a `{chorus}` recall. Rust repeats the
chorus text.

### Trailing Hyphen

Perl appends `-` to a line that ends in a chord-bearing syllable
(`la la la-`). Rust leaves the lyric as written.

### Smart Quotes

Perl ChordPro performs typographic ("smart") quote conversion on output
(e.g., `'` → `’`). Rust preserves the original characters from the `.cho`
file without modification.

### Blank Line Spacing

Perl inserts extra blank lines between lyrics lines and around sections. Rust
uses single blank lines for section boundaries only, producing a more compact
output.

### Capo

`{capo: N}` lowers every displayed chord by N semitones, so the chords are the
shapes to play with a capo on fret N.
Perl prints the chords as written. In the corpus this accounts for
`directives/01-metadata.cho` and `multi-song/03-songs-with-metadata.cho`.

### Chord Spelling After Transposition

After `{transpose: N}` ChordSketch spells the chords for the flat or sharp
side of the circle of fifths that the transposed `{key}` is on (`Eb`, `Ab`,
`Bb` for a song now in Eb). In `multi-song/04-song-with-transpose.cho` Perl
spells the same chords with sharps (`D#`, `G#`, `A#`). The pitches are the
same.

### Delegate Blocks

For `{start_of_abc}`, `{start_of_ly}` and `{start_of_svg}` the text output
cannot show the rendered result. Perl, with no ABC or LilyPond tooling
installed, prints an empty image placeholder (`+ image: <none>`). ChordSketch
prints a note that the block is omitted and can be viewed in the HTML output.

## What the differences leave intact

After the normalisation described under "What was compared", the chord names,
the chord positions over the lyrics and the section order of the corpus files
that Perl renders match, except for the files listed there. The test
`crates/cli/tests/perl_comparison.rs` checks this on every run.

## Perl Errors on Test Corpus

With R6.101.0 and the `Text` backend, Perl ChordPro fails on these corpus
files (it exits with an error or prints nothing). ChordSketch renders all of
them. The list is generated from `tests/perl-baseline/perl-failed.txt`.

<!-- perl-compare:perl-failed:start -->
- `basic/01-empty.cho`
- `basic/02-title-only.cho`
- `edge-cases/10-mixed-everything.cho`
- `formatting/01-bold.cho`
- `formatting/02-italic.cho`
- `formatting/03-mixed-markup.cho`
- `formatting/06-span-attrs.cho`
- `formatting/07-unclosed-tags.cho`
- `formatting/08-case-insensitive.cho`
- `formatting/09-markup-with-chords.cho`
<!-- perl-compare:perl-failed:end -->

`basic/01-empty.cho` is an empty file, so Perl prints nothing, and
`basic/02-title-only.cho` has no song body (Perl stops with an undefined array
reference in its text backend). The `formatting/` files and
`edge-cases/10-mixed-everything.cho` use inline markup; Perl stops there with
an undefined font family in its layout code. That may depend on the fonts of
the machine used for the saved output, and was not investigated.

With the `HTML` backend, Perl fails on `delegate/01-abc.cho`,
`delegate/02-lilypond.cho` and `delegate/05-multiple-delegates.cho`.

The Perl runs above were made with Perl 5.36 on a machine without ABC or
LilyPond tooling, without the optional `JavaScript::QuickJS` module and
without fonts. A different environment may change which files Perl fails on.
