# Renderer Parity

## Rule

Every ChordPro directive or AST node that is rendered by one renderer MUST
be handled by **all** renderers (text, HTML, PDF). A missing case in one
renderer is a correctness bug.

## Required practices

- When adding a new directive or AST node, add rendering support to all
  three renderers in the same PR (or in explicitly tracked follow-up issues
  that are linked and prioritised).
- When fixing a rendering bug in one renderer, check all other renderers for
  the same bug and fix them in the same PR.
- Golden tests for each renderer must cover the same set of directives. If
  a fixture exercises a directive in the text renderer, an equivalent fixture
  must exist (or be explicitly tracked) for HTML and PDF.

## Validation Parity

Renderer parity extends beyond AST arms to **input validation and clamping logic**.
If one renderer applies a bounds check, clamps a value, or validates a directive
parameter, all renderers MUST apply the same check.

Examples of validation that must be consistent across all three renderers:
- `{columns}` value: clamped to `1..=MAX_COLUMNS` in all three renderers
- `{capo}` value: validated against the valid fret range in all three renderers
- Any directive whose value is parsed as a numeric type: same min/max in all renderers

Inconsistent validation is a correctness bug: the same `.cho` file can produce
different output (or panic) depending on which output format is used.

When adding or changing validation in one renderer:
1. Apply the same change to all other renderers in the same PR.
2. Add a golden test with an out-of-range value that exercises the clamping/rejection.

## Audit pattern

Before closing a PR that touches any renderer:

1. Search for all `match` arms on `Line`, `Directive`, or equivalent AST
   enums in the changed renderer.
2. Verify every arm exists in the other renderers.
3. For every directive that parses a numeric parameter, verify the valid range
   and clamping logic is identical in all three renderers.
4. If an arm or validation is missing, either add it or file a sub-issue.

## Coverage Parity

Sister-site parity extends to numeric test coverage. The renderer group
(`render-text`, `render-html`, `render-pdf`) has a **group floor of 80%**
line coverage, and the **intra-group skew must not exceed 5 percentage
points**. A drop below either bound is a structural signal that one
renderer is diverging from its siblings — the same class of defect as a
missing match arm, just detected by metric instead of by grep.

Thresholds are enforced via `codecov.yml` at the repo root. The skew
clause is not natively supported by Codecov and is verified by auto-review
using the per-crate percentages in the Codecov dashboard comment on each
PR. See tracker #1846 §Strategy.3 for the full gating model.

## Why

45 renderer parity issues were filed — the most common was a new directive
handled in the text renderer but silently ignored or panicking in HTML/PDF.
A 2026-04-12 audit found that the `{columns}` directive was clamped to 32 in
the HTML renderer but unbounded in the PDF renderer (#1540), illustrating that
parity must cover validation logic, not only match arms.
