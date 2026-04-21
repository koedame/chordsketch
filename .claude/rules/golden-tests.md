# Golden Test Rule

- Every parser behavior must have golden test coverage.
- A golden test consists of an input `.cho` file and an expected output snapshot file.
- Golden test fixtures live in `crates/chordpro/tests/fixtures/`.
- When parser behavior changes, update the corresponding golden snapshot and explain the
  change in the PR description.
- New ChordPro directives or syntax support must include at least one golden test before
  merging.

## Minimum Fixture Counts

The renderers each maintain their own fixture corpus. These minimums are the
floor for sister-site parity (see [`renderer-parity.md`](renderer-parity.md));
Codecov thresholds alone do not guarantee structural coverage of directive
classes, so a PR that drops below any of these numbers blocks on human review:

| Renderer | Minimum fixtures | Location |
|---|---|---|
| `render-text` | 15 | `crates/render-text/tests/fixtures/` |
| `render-html` | 15 | `crates/render-html/tests/fixtures/` |
| `render-pdf`  | 10 | `crates/render-pdf/tests/fixtures/`  |

The asymmetry reflects snapshot cost — render-text fixtures are tiny plain
text, render-pdf fixtures are binary PDFs whose byte-exact snapshots cost
~1–2 KB each, and byte-exact snapshots for unicode input are impractical in
render-pdf (tracked in #1983). Raise the floor when those costs change.

Enforced by `scripts/check-fixture-counts.py` (wired into the
`fixture-counts` job in `.github/workflows/ci.yml`). The source of truth
for the numbers is the `MINIMUMS` dict in that script; this table and the
script must be updated in lockstep.

## Stop-Word Collision Tests

When adding or modifying the chord parser or heuristic importer, add at least one
golden test (or unit test) for each of the following stop-word collision patterns:

- A word that starts with a valid root note letter but is NOT a chord (e.g., `Am` in
  `Amazing`, `Em` in `Empty`, `G` in `Get`).
- A section label whose first letter is a valid chord root (e.g., `Chorus`, `Bridge`,
  `Dm` as a label).

These collisions are the most common source of chord-detection false positives and
regressions. A test that explicitly asserts rejection prevents future parsers from
silently accepting them.
