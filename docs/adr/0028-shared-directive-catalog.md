# 0028. Shared directive catalog as the single source of truth for completion

- **Status**: Accepted
- **Date**: 2026-05-31

## Context

ChordPro directive knowledge was duplicated across the codebase, with each
copy free to drift from the parser that actually defines what a directive
is (`chordsketch_chordpro::ast::DirectiveKind::from_name`):

- The LSP completion provider (`crates/lsp/src/completion.rs`) carried a
  hand-maintained `const DIRECTIVES` array. It had already drifted —
  missing `highlight`, `no_diagrams`, `pagetype`, `start_of_musicxml` /
  `end_of_musicxml`, and others the parser recognises — so VS Code (and
  any LSP host) offered an incomplete directive list.
- The playground's "+ Directive" picker (`packages/playground`) hard-coded
  13 of the ~50 directives.
- The web CodeMirror editor offered no directive completion at all.

Two product requirements made this worse rather than just untidy:

1. The "Add Directive" list must be complete and must not silently fall
   behind the parser again.
2. Directives whose value is a fixed set — `{diagrams: on|off|guitar|…}`,
   now also `inline` / `hover` (ADR-0027) — should offer those values as
   completions, in **both** the VS Code extension **and** the web editor.

Adding value completion to three independently-maintained lists would have
tripled the drift surface.

## Decision

Introduce one **directive catalog** in the zero-dependency foundation
crate, `chordsketch_chordpro::directive_catalog`, listing every directive
with its canonical name, aliases, value shape
(`None` / `FreeForm` / `Enum(values)`), and a one-line summary. Every
surface reads it:

- The **LSP** (`crates/lsp`) sources `directive_items` from the catalog
  (deleting its hand-maintained array) and gains a new
  `CompletionContext::DirectiveValue` plus a `directive_value_items`
  builder, so an enum-valued directive completes its values after the
  colon. VS Code inherits this with no extension-side change — it already
  delegates completion to the `chordsketch-lsp` server.
- The **wasm** crate (`crates/wasm`) exports `listDirectives()` and
  `directiveValueOptions(name)`, serialising the catalog at the wasm
  boundary (the core crate stays serde-free). The web CodeMirror editor
  and the playground picker consume these (wired in a follow-up change),
  so they offer the same set as VS Code.

A consistency test in `directive_catalog` asserts every catalog name and
alias resolves through `DirectiveKind::from_name` to the same non-`Unknown`
kind, so the catalog cannot silently diverge from the parser.

## Rationale

- **Right layer.** `chordsketch-chordpro` already owns `DirectiveKind`,
  compiles to wasm (for the browser surfaces), and is linked by the LSP
  (for VS Code). It is the only place a single list reaches every consumer.
  Putting the catalog in the playground or the LSP would leave the others
  out (`.claude/rules/playground-is-a-sample.md`,
  `.claude/rules/fix-propagation.md`).
- **Root-cause fix, not another copy.** The drift was caused by *having
  multiple lists*. Syncing them by hand is the prohibited band-aid
  (`.claude/rules/root-cause-fixes.md`); one catalog + a consistency test
  removes the failure mode instead of papering over it.
- **Zero-dependency core preserved.** The catalog is plain `&'static`
  data; serialization to JS happens only in the wasm crate, which already
  depends on `serde` / `serde-wasm-bindgen`. `code-style.md`'s
  "`chordsketch-chordpro` has zero external dependencies" rule is intact.
- **Catalog ↔ parser kept honest by test, not by refactor.** Deriving
  `from_name` from the catalog was considered and rejected (below); a
  bidirectional consistency test gives the same guarantee without
  rewriting the parser's hot path.

## Consequences

- The LSP directive list is now complete and self-maintaining: adding a
  directive to the parser without adding a catalog entry (or vice versa)
  fails the consistency test.
- VS Code gains directive-value completion for free (the test
  `context_directive_value_non_meta_is_none` stays valid — free-form
  values like `{title: …}` still offer nothing; only enum directives
  complete).
- The wasm bundle gains two small additive exports (`listDirectives`,
  `directiveValueOptions`) in the lean `@chordsketch/wasm` build the web
  surfaces load.
- The catalog's `summary` strings are lightweight (one line each), not a
  full help system; richer hover docs remain the LSP `hover.rs`
  responsibility. Folding `hover.rs`'s separate `DIRECTIVE_DOCS` list into
  the catalog is a natural follow-up (sister-site per
  `fix-propagation.md`) but out of scope here; until then it is a third
  list and a known debt, called out so it is not forgotten.
- Per `fix-propagation.md` §Bindings, the catalog export is wasm-only by
  design: ffi / napi host no completion consumer, so they intentionally do
  not get `listDirectives` / `directiveValueOptions`.

## Alternatives considered

- **Keep three hand-maintained lists, sync manually.** Rejected: that *is*
  the current bug. No automated guard; the next directive re-opens the gap.
- **Derive `DirectiveKind::from_name` from the catalog.** Rejected: the
  parser's `from_name` / `resolve_with_selector` carry dynamic arms
  (`StartOfSection` / `Meta` / `Image` / `ConfigOverride` / `Unknown`), the
  last-hyphen selector split, and case/multibyte edge cases. Rewriting that
  as a table-driven lookup is a large blast radius for a completion
  feature; a consistency test achieves the same drift-prevention safely.
- **Export the catalog only from the LSP, share it with the web editor via
  the language server in the browser.** Rejected: the web playground runs
  no language server; only the wasm path reaches the browser.

## References

- [ADR-0027](0027-inline-hover-compact-chord-diagrams.md) — adds the
  `inline` / `hover` values the catalog's `diagrams` enum surfaces.
- [ADR-0017](0017-react-renders-from-ast.md) — the AST/JSON boundary the
  wasm exports cross.
- `.claude/rules/fix-propagation.md`, `.claude/rules/root-cause-fixes.md`,
  `.claude/rules/playground-is-a-sample.md`, `.claude/rules/code-style.md`.
- `crates/chordpro/src/directive_catalog.rs` — the catalog + consistency test.
- `crates/lsp/src/completion.rs`, `crates/lsp/src/server.rs` — LSP consumer
  + directive-value completion.
- `crates/wasm/src/lib.rs`, `crates/wasm/src/bindings.rs` — `listDirectives`
  / `directiveValueOptions` exports.
