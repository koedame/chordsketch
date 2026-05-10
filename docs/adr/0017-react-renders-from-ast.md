# 0017. React surface renders from AST; Rust HTML renderer demoted to static-output

- **Status**: Accepted
- **Date**: 2026-05-10

## Context

Until #2475 the React surface (`<ChordSheet>`, `<RendererPreview>`,
the playground) consumed `chordsketch-render-html`'s string output:
the Rust crate emitted a full HTML document, the wasm bundle handed
the string to React, and React mounted it inside an `<iframe srcdoc>`
(`<RendererPreview>`) or via React's HTML-string injection prop on
`<ChordSheet>`. Two pain points compounded over time:

1. **Iframe scaffolding**. The HTML document the Rust renderer
   produces ships its own `<style>` block keyed off `body { … }`,
   which leaks into the host document if rendered inline. The
   playground worked around this with `<iframe sandbox="…" srcdoc=…>`
   plus the `<!-- r:N -->` cache-bust marker added in #2421 (because
   Chrome elides same-string `srcdoc` writes as no-ops). Each piece
   was correctness-driven, but together they meant the React
   surface owned an iframe lifecycle layered on top of the renderer's
   output.
2. **Dual-implementation surface area**. The Rust HTML renderer at
   4,889 lines (`crates/render-html/src/lib.rs`) is the *only* HTML
   path on every other consumer (CLI, FFI bindings, GitHub Action,
   VS Code preview). The React surface paid the iframe cost solely
   to consume that string, and benefited from none of React's
   reconciliation or component composition for the body of the
   preview.

The user-facing question — "if we're already in React, why does the
React surface get its DOM through a string-emitting Rust renderer?"
— was the trigger for this ADR.

## Decision

Split the HTML rendering surfaces:

- **Rust HTML renderer** (`chordsketch-render-html`) stays as the
  canonical static-HTML emitter for **non-React consumers**: CLI
  (`chordsketch render --format html`), FFI bindings
  (`@chordsketch/node`, Python, Swift, Kotlin, Ruby), the GitHub
  Action, and the VS Code extension's iframe preview — every surface
  that does not own a JS / React runtime. The 4,889-line
  implementation, the renderer-parity rules around it, the golden
  tests, and the sister-site coverage floor remain unchanged.
- **React surface** (`<ChordSheet format="html">`,
  `<RendererPreview format="html">`, the playground) renders
  **AST → JSX directly**. The wasm bundle exposes the parsed
  `Song` AST via `parseChordpro` / `parseChordproWithOptions`
  (added in this PR alongside `crates/chordpro/src/json.rs`), and
  `@chordsketch/react`'s `chordpro-jsx` walker emits a React tree
  matching the Rust renderer's DOM contract (`.song`, `.line`,
  `.chord-block`, `.chord`, `.lyrics`, `<section class="…">`,
  `<p class="comment">`, `<div class="comment-box">`, `<h1>`,
  `<h2>`, `<p class="meta">`, `<div class="empty-line">`,
  `.chorus-recall`).

The `format="text"` and `format="pdf"` branches stay on their
existing wasm string / bytes paths (text rendering is
column-aligned plain text; PDF generation is binary and remains
owned by `chordsketch-render-pdf`).

The iframe scaffolding in `<RendererPreview>` is removed entirely.
React reconciliation owns DOM updates, so the cache-bust marker
(#2421) no longer has a substrate — DOM diffing is byte-different
by construction.

## Rationale

- **Removes a dual-implementation maintenance pressure on the
  React side**, but only at the wire-format boundary: the AST
  shape is now the contract React consumes. The Rust HTML renderer
  remains the single implementation for everyone else, so spec
  changes still land once.
- **Pure React reconciliation owns the React-surface DOM**. Any
  future composition concern (selectable text spans, hover
  affordances, IME composition under JP lyrics, hydration) lands
  natively without poking through an iframe boundary.
- **Eliminates the iframe scaffolding** (`<iframe sandbox=…>`,
  `srcdoc`, `<!-- r:N -->` cache-bust marker, the React-side
  iframe lifecycle hook). All three were correctness fixes for
  the iframe model — once the iframe is gone, the fixes have no
  substrate to apply to.
- **Sanitizer parity stays intact**. The walker enforces the same
  URI-scheme blocklist (`javascript:`, `vbscript:`, `data:`,
  `file:`, `blob:`) that `crates/render-html/src/lib.rs` applies
  in `has_dangerous_uri_scheme` / `is_safe_image_src` — see
  `chordpro-jsx.tsx::isSafeHref` and
  `.claude/rules/sanitizer-security.md` §"Security Asymmetry".
  Any new entry to the Rust list MUST land in the JS list in the
  same PR.

## Consequences

**Positive**

- React-surface DOM updates are now React-native — no iframe
  navigation, no `srcdoc` re-assignment, no cache-bust marker.
- The walker is ~280 lines vs. the iframe scaffolding it replaced;
  the AST → JSON → JSX pipeline is straightforward to extend
  (custom directive handling, theme injection, hover affordances).
- New AST surface (`parseChordpro` JSON shape, TS types in
  `packages/react/src/chordpro-ast.ts`) is now part of the public
  API and unlocks downstream consumers (third-party React
  components, alternate non-DOM JSX renderers) without forcing
  them through the HTML string path.

**Negative + mitigation**

- A spec change (new `DirectiveKind` variant, new `LyricsSegment`
  field) requires an update in **two** code paths now: the Rust
  HTML renderer (for the non-React consumers) and the React
  walker (for the React consumers). Mitigation: the AST-side
  changes land in `crates/chordpro/src/json.rs` and
  `packages/react/src/chordpro-ast.ts`, and the walker fail-soft
  on unknown variants (e.g. unknown directive `tag` is ignored
  rather than throwing) — so the Rust-side update surfaces as a
  rendering gap on the React surface, not a crash.
- Sanitizer asymmetry is now a real risk class. Mitigation: the
  walker's `DANGEROUS_URI_SCHEMES` list and the Rust blocklist
  are paired in `.claude/rules/sanitizer-security.md` and called
  out in the renderer-parity rule rewrite that ships in the same
  PR. Any new entry triggers the existing sister-site fix-
  propagation discipline.
- The renderer-parity rule's "text / html / pdf are sister sites"
  framing no longer applies to the React surface. Mitigation:
  the rule rewrite (this PR, `.claude/rules/renderer-parity.md`)
  documents the React JSX walker as a *fourth* surface with its
  own coverage floor and parity obligation.

## Alternatives considered

1. **Keep the iframe path** (status quo). Rejected because the
   iframe lifecycle stayed correctness-fragile under every
   subsequent change (iframe srcdoc race in #2397, cache-bust in
   #2421, scrolling after format toggle in #2422), and none of
   those issues had a Rust-side root cause — they were React-
   side iframe-management issues that would not exist without the
   iframe.
2. **Drop the iframe but keep React's HTML-string injection on the
   wasm output**. Rejected because the body-level `<style>` block
   in the Rust renderer's full HTML document leaks into the host
   page; the only way to avoid the leak is to either run the
   renderer in `render_html_body` mode (no `<style>`, then push
   the styles to a stylesheet imported by `@chordsketch/react`)
   *or* to walk the AST natively. Walking the AST is the cleaner
   answer because (a) the styles already live as
   `@chordsketch/react/styles.css`, and (b) the dual-implementation
   pressure on the React side disappears.
3. **Re-implement the full Rust HTML renderer in TS as a
   complete drop-in**. Rejected because the maintenance pressure
   would simply move from "iframe scaffolding" to "two HTML
   string emitters drifting against each other". The AST-walker
   approach keeps the *string* surface single-implementation
   (Rust) and the *React* surface single-implementation (the
   JSX walker).
4. **Use a generic HTML-to-React parser** (`html-react-parser`
   or similar) on the wasm string output. Rejected because (a)
   it adds a dependency that has its own sanitisation surface and
   security history, (b) it does not actually move the React
   surface to AST-level semantics — it just shuffles strings —
   and (c) it does nothing about the dual-implementation pressure
   that motivated the change.

## References

- This PR (#2455 / branch `issue-2454-design-system-migration`):
  introduces `parseChordpro`, the JSON serializer at
  `crates/chordpro/src/json.rs`, the TS AST types at
  `packages/react/src/chordpro-ast.ts`, and the JSX walker at
  `packages/react/src/chordpro-jsx.tsx`.
- `.claude/rules/sanitizer-security.md` — sanitizer parity
  obligation between the React JSX walker and
  `chordsketch-render-html`.
- `.claude/rules/renderer-parity.md` — sister-site framing
  rewritten to reflect the four-surface split (text / html / pdf
  Rust + JSX walker on React).
- #2421 — the iframe `srcdoc` cache-bust marker that this ADR
  retires by removing its substrate.
- #2397 — the iframe-mount race that motivated
  `playground-smoke.md`; that smoke continues to apply, retargeted
  at the inline DOM in this PR (`render-format-toggle.spec.ts`).
- iReal Pro AST exposure in `crates/ireal/src/json.rs` (#2055):
  precedent for hand-rolling a zero-dep JSON serializer in a
  zero-dep crate.
