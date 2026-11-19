# 0093. The Perl text comparison runs in CI against saved Perl output

- **Status**: Accepted
- **Date**: 2026-11-20
- **Amends**: [ADR-0040](0040-external-tool-tests-are-not-run-in-ci.md)

## Context

The only compatibility check against Perl ChordPro was `scripts/compare-with-perl.sh`,
run by hand. Its report was "0 files identical", so a change that made the text
output differ from Perl's in a way nobody intended did not move any number, and
nothing failed. ADR-0040 removed the scheduled workflow that installed Perl and
the other external tools because installing them was the least stable part of
CI.

The upstream release is pinned in `.github/upstream-version`, so Perl's output
for the corpus does not change between runs. It is also small (45 files,
220 KB).

## Decision

1. **The text output of every `tests/corpus/` file is compared in `cargo test`**
   (`crates/cli/tests/perl_comparison.rs`) with Perl's output saved in
   `tests/perl-baseline/text/`. CI installs no Perl and no other external tool,
   which keeps ADR-0040. HTML and PDF output are not compared: they are not meant
   to match Perl's markup or page layout.
2. **Both outputs are normalised before they are compared**, so that the
   presentation choices listed in `docs/known-deviations.md` do not count as
   differences. The rules are covered by their own tests, including tests that
   chord names, chord columns, lyric text and section order still show up.
3. **The comparison is a ratchet that fails.** A file that differs and is not in
   `tests/perl-baseline/accepted-differences.txt` (each entry has a reason) fails
   the test; so does a listed file that now matches, saved output made with
   another release than `.github/upstream-version`, and a corpus file without
   saved output.
4. **The saved output is refreshed locally** with `scripts/update-perl-baseline.sh`
   when the upstream release or the corpus changes. The script refuses to run
   with a Perl ChordPro of another release.
5. **Parts of `docs/known-deviations.md` are generated** from the saved output
   and the accepted list (the comparison table, the accepted differences, the
   Perl failures), and the same test fails if they are stale.

## Rationale

- Saved output answers the question CI can answer reliably — did ChordSketch's
  output move away from what Perl printed — without an install step.
- A warning would repeat the failure ADR-0040 names: output nobody reads. A
  failing test with an accepted list makes a new difference a decision made in
  the PR that introduces it.
- Listing files, not counting them, catches one difference being swapped for
  another.

## Consequences

- Positive: an unintended text change fails `cargo test` and names the file and
  the first differing lines.
- Negative: raising `.github/upstream-version` or editing the corpus needs a
  local Perl ChordPro install and a run of the update script; the test fails
  with that instruction until it is done.
- Negative: the normalisation rules were written against the 55 current corpus
  files and hide some differences (blank-line counts, hyphens next to a space,
  comment style). `docs/known-deviations.md` lists what they hide.
- The saved Perl output and the rules are the reference for what "matches Perl"
  means; changing them changes that definition.

## Alternatives considered

- **Install Perl ChordPro in CI.** Rejected for the reason in ADR-0040: a Perl module install
  on every run, for output that does not change within
  an upstream release.
- **Report the number of differing files as a warning.** Rejected: it is not read,
  and a count cannot tell one difference from another.
- **Run the comparison weekly.** Rejected: a regression would reach `main` before
  anything noticed it.

## References

- `crates/cli/tests/perl_comparison.rs`, `tests/perl-baseline/`, `scripts/update-perl-baseline.sh`
- `docs/known-deviations.md`, `docs/dev-setup.md` § "Refreshing the saved Perl output"
