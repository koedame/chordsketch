# Comparison Scripts

## update-perl-baseline.sh

Regenerates the saved Perl ChordPro text output in `tests/perl-baseline/`,
which `cargo test -p chordsketch --test perl_comparison` compares ChordSketch's
output against in CI, and the generated sections of
`docs/known-deviations.md`. Needs Perl ChordPro at the release in
`.github/upstream-version` (`docs/dev-setup.md`).

```bash
./scripts/update-perl-baseline.sh
```

## compare-with-perl.sh

Ad-hoc comparison tool (the text comparison that runs in CI works from saved
Perl output instead, see above; this script is still the way to compare HTML
output). It runs both ChordSketch and the Perl ChordPro
reference implementation on the same `.cho` input files and diffs the output.

### Prerequisites

- **Perl ChordPro**: Install via `cpanm App::Music::ChordPro`
- **ChordSketch**: Built with `cargo build --release`

### Usage

```bash
# Compare text output (default)
./scripts/compare-with-perl.sh

# Compare HTML output
./scripts/compare-with-perl.sh html

# Use a custom corpus directory
./scripts/compare-with-perl.sh text path/to/corpus
```

### Output

- **PASS**: Both implementations produce identical output
- **DIFF**: Output differs — diff saved to `/tmp/chordpro-comparison/diff/`
- **SKIP**: One implementation failed to process the file

### Reviewing Diffs

```bash
# List all diff files
ls /tmp/chordpro-comparison/diff/

# View a specific diff
cat /tmp/chordpro-comparison/diff/basic_04-chords-and-lyrics.diff
```
