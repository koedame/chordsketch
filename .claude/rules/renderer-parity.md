# Renderer Parity

## Surfaces

ChordPro rendering ships across **four** surfaces, in two
sister-site groups (per [ADR-0017](../../docs/adr/0017-react-renders-from-ast.md)):

1. **Static-output Rust group** — `chordsketch-render-text`,
   `chordsketch-render-html`, `chordsketch-render-pdf`. These
   produce strings / bytes consumed by the CLI, FFI bindings,
   GitHub Action, and VS Code extension's iframe preview. The
   group floor + intra-group skew documented under "Coverage
   Parity" applies here.
2. **React JSX group** — `@chordsketch/react`'s `chordpro-jsx`
   walker (`packages/react/src/chordpro-jsx.tsx`). This renders
   the parsed AST to JSX directly for `<ChordSheet>` /
   `<RendererPreview>` / the playground. It mirrors
   `chordsketch-render-html`'s DOM contract (`.song`, `.line`,
   `.chord-block`, `<section class="…">`, `<p class="comment">`,
   etc.) but emits React elements instead of strings.

The two groups have different audiences but the **same AST**.
Behaviour parity across surfaces in the same group is mandatory;
behaviour parity *across* the two groups is also mandatory, but
the implementations are independent — the wire-format boundary is
the AST shape exposed by `chordsketch-chordpro::json::ToJson`
and consumed by `parseChordpro` (#2475).

## Rule

Every ChordPro directive or AST node that is rendered by one
surface MUST be handled by **all four** surfaces (text, HTML,
PDF, React JSX). A missing case in any surface is a correctness
bug.

## Required practices

- When adding a new directive or AST node:
  - Add rendering support to all **three Rust renderers** in the
    same PR.
  - Add the AST → JSON serialisation in `crates/chordpro/src/json.rs`
    if a new field / variant is involved, and the matching TS shape
    in `packages/react/src/chordpro-ast.ts`.
  - Add rendering support to the **React JSX walker** at
    `packages/react/src/chordpro-jsx.tsx` so the React surface
    does not silently regress vs. the Rust HTML output.
  - Omissions record a `## Deferred` entry in the PR body with a
    one-line justification, per `pr-workflow.md`; do not file a
    follow-up issue.
- When fixing a rendering bug in one surface, check **every other
  surface** (the other two Rust renderers AND the React JSX
  walker) for the same bug and fix them in the same PR.
- Golden tests for each Rust renderer must cover the same set of
  directives. If a fixture exercises a directive in the text
  renderer, equivalent fixtures must exist for HTML and PDF — not
  merely be tracked for later. The React JSX walker is covered by
  unit tests in `packages/react/tests/chordpro-jsx.test.tsx` plus
  the playground Playwright smoke; new directive support lands a
  walker test in the same PR.

## Validation Parity

Renderer parity extends beyond AST arms to **input validation and clamping logic**.
If one renderer applies a bounds check, clamps a value, or validates a directive
parameter, all renderers MUST apply the same check.

Examples of validation that must be consistent across all three Rust renderers:
- `{columns}` value: clamped to `1..=MAX_COLUMNS` in all three renderers
- `{capo}` value: validated against the valid fret range in all three renderers
- Any directive whose value is parsed as a numeric type: same min/max in all renderers

The React JSX walker consumes the AST after `chordsketch-chordpro`
has done its parse-time validation, so input-range clamping is
not duplicated there — but **rendering-time validation** (e.g.
sanitising a URI in an `image` directive) IS duplicated and the
same parity rule applies. See "Sanitizer Parity" below.

Inconsistent validation is a correctness bug: the same `.cho` file can produce
different output (or panic) depending on which output format is used.

When adding or changing validation in one surface:
1. Apply the same change to all other surfaces in the same PR
   (all three Rust renderers + the React JSX walker, where
   applicable).
2. Add a golden test with an out-of-range value that exercises the clamping/rejection.

## Sanitizer Parity (React JSX surface)

The React JSX walker at `packages/react/src/chordpro-jsx.tsx`
duplicates the URI-scheme blocklist enforced by
`crates/render-html/src/lib.rs::has_dangerous_uri_scheme` /
`is_safe_image_src`. The walker's `DANGEROUS_URI_SCHEMES` array
and the Rust list MUST stay in lockstep — see
`.claude/rules/sanitizer-security.md` §"Security Asymmetry".

When adding or removing a scheme from one list, apply the same
change to the other in the same PR and add an adversarial-input
test on both sides.

## Audit pattern

Before closing a PR that touches any rendering surface:

1. Search for all `match` arms on `Line`, `Directive`, or equivalent AST
   enums in the changed surface (Rust `match` for the Rust group,
   `switch` / `kind`-driven branches for the React JSX walker).
2. Verify every arm exists in the other Rust renderers AND in
   the React JSX walker.
3. For every directive that parses a numeric parameter, verify the valid range
   and clamping logic is identical in all three Rust renderers.
   The React walker reads post-parse AST values so clamping is
   inherited; URI sanitisation in the walker MUST match the Rust
   blocklist.
4. If an arm or validation is missing, add it in this PR or record a
   `## Deferred` entry in the PR body per `pr-workflow.md`; do not file
   a sub-issue.

## Coverage Parity

Sister-site parity extends to numeric test coverage. The
**static-output Rust group** (`render-text`, `render-html`,
`render-pdf`) has a **group floor of 80%** line coverage, and
the **intra-group skew must not exceed 5 percentage points**. A
drop below either bound is a structural signal that one renderer
is diverging from its siblings — the same class of defect as a
missing match arm, just detected by metric instead of by grep.

The **React JSX group** (`@chordsketch/react`'s `chordpro-jsx`
walker) is covered by `packages/react/tests/chordpro-jsx.test.tsx`
+ chord-sheet integration tests + the playground Playwright
smoke. Coverage thresholds for the React package are not
currently enforced via Codecov (the React tests run via vitest,
not `cargo llvm-cov`); the parity obligation is qualitative —
every directive supported by the Rust HTML renderer must have a
walker test asserting the expected DOM output, or a documented
gap in `chordpro-jsx.tsx`'s comments.

Thresholds for the Rust group are enforced via `codecov.yml` at
the repo root. The skew clause is not natively supported by
Codecov and is verified by auto-review using the per-crate
percentages in the Codecov dashboard comment on each PR. See
tracker #1846 §Strategy.3 for the full gating model.

## Why

45 renderer parity issues were filed — the most common was a new directive
handled in the text renderer but silently ignored or panicking in HTML/PDF.
A 2026-04-12 audit found that the `{columns}` directive was clamped to 32 in
the HTML renderer but unbounded in the PDF renderer (#1540), illustrating that
parity must cover validation logic, not only match arms.
