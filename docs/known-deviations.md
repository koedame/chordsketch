# Known Deviations from Perl ChordPro

**Compared against**: Perl ChordPro core v6.101.0 (`App::Music::ChordPro`,
release R6.101.0, the version recorded in `.github/upstream-version`).

ChordSketch aims to read the same ChordPro files as the Perl implementation.
It is **not** a drop-in replacement: it does not reproduce the Perl output
byte for byte, it does not implement every directive and configuration key,
and it offers fewer output formats. This document lists the differences that
have been checked.

## What was compared

The comparison runs `scripts/compare-with-perl.sh` over the 55 files in
`tests/corpus/` (see `tests/corpus/README.md`) against R6.101.0.

| Format | Identical output | Different output | Perl failed to render |
|--------|------------------|------------------|-----------------------|
| `text` | 0 | 46 | 9 |
| `html` | 0 | 52 | 3 |

No file renders identically. The differences in the text output are the
presentation choices described below. The HTML and PDF output use their own
stylesheet and layout and are not intended to match Perl's markup or page
layout. PDF output is not compared by the script.

The comparison needs Perl ChordPro installed and is run by hand
(`docs/dev-setup.md`); it is not part of CI. What CI does check is the
directive coverage described in the next section.

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
  LilyPond tooling installed on the machine. Without it the section is not
  drawn. In the HTML run above, Perl failed on the corpus files that use
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

## What the differences leave intact

Reading the text diffs for the corpus, the chord names, the chord positions
over the lyrics, the transposition results and the section order match in the
files inspected. This was checked by reading the diffs, not by an automated
comparison.

## Perl Errors on Test Corpus

With R6.101.0 and the `Text` backend, Perl ChordPro fails on these corpus
files. Rust renders all of them.

- `basic/02-title-only.cho` — empty song body
- `edge-cases/10-mixed-everything.cho` — complex markup combinations
- `formatting/01-bold.cho`, `02-italic.cho`, `03-mixed-markup.cho`,
  `06-span-attrs.cho`, `07-unclosed-tags.cho`, `08-case-insensitive.cho`,
  `09-markup-with-chords.cho` — inline markup in Text mode

With the `HTML` backend, Perl fails on `delegate/01-abc.cho`,
`delegate/02-lilypond.cho` and `delegate/05-multiple-delegates.cho`.

The Perl runs above were made with Perl 5.36 on a machine without ABC or
LilyPond tooling and without the optional `JavaScript::QuickJS` module. The
cause of each Perl failure was not investigated, and a different environment
may change which files Perl fails on.
