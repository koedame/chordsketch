# Golden Test Rule

- Every parser behavior must have golden test coverage.
- A golden test consists of an input `.cho` file and an expected output snapshot file.
- Golden test fixtures live in `crates/core/tests/fixtures/`.
- When parser behavior changes, update the corresponding golden snapshot and explain the
  change in the PR description.
- New ChordPro directives or syntax support must include at least one golden test before
  merging.
