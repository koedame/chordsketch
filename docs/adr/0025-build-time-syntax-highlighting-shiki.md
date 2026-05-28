# 0025. Build-time syntax highlighting for the docs site uses Shiki

- **Status**: Accepted
- **Date**: 2026-05-28

## Context

[ADR-0021](0021-docs-site-co-located-with-playground.md) committed
the docs site at `chordsketch.koeda.me/chordsketch/docs/` to a
**fully pre-rendered, zero-JS** static deploy: every page is one
`dist/docs/<slug>/index.html` file with the article content,
sidebar, and on-page outline baked in, and the only JavaScript on
the deployed page is a six-line inline shim that redirects legacy
`#/<slug>` hash URLs to the matching clean URL. That posture is the
project's hard guarantee: the docs route never loads the wasm
bundle, never mounts React, never executes anything beyond that
shim.

Code-fence rendering on the docs site shipped as plain
white-on-dark text. The recipe pages — most of all
`docs/sdk/tasks/embed-react.md`, the ten copy-paste recipes for
`@chordsketch/react` — are mostly code, and reader comprehension
on them is bottlenecked on the lack of syntactic colour. Issue
[#2570](https://github.com/koedame/chordsketch/issues/2570)
proposed adding syntax highlighting.

The constraint set for any highlighting choice:

1. **Must preserve ADR-0021's zero-JS posture.** A client-side
   highlighter loaded at runtime would re-introduce a JS payload
   on every docs page, transitively widen the deployed bundle
   beyond the inline shim, and reverse the deliberate trade-off
   that ADR-0021 spelled out under "Mitigations" ("the deployed
   pages are zero-JS so the docs routes do not load the wasm
   bundle even transitively").
2. **Must cover ChordPro.** The recipe corpus contains
   ` ```chordpro ` fences. A highlighter that handles
   TSX / Rust / Python / etc. but renders ChordPro as plain text
   would create a glaring asymmetry on the very pages the docs
   site was built to support.
3. **Should reuse in-repo grammar work.** The project already
   ships `syntaxes/chordpro.tmLanguage.json` (the TextMate grammar
   the VS Code extension and JetBrains plugin consume) and a
   tree-sitter grammar at `packages/tree-sitter-chordpro/` (the
   Zed extension consumes that). Maintaining a third grammar for
   the docs site would create drift between editor highlighting
   and on-page docs highlighting.
4. **Must stay inside the playground's existing build pipeline.**
   ADR-0021 explicitly rejects standing up a second build /
   deploy / smoke surface; the docs SSG sits inside
   `packages/playground/scripts/`.

Three highlighter shapes were on the table:

- **(a) Build-time TextMate-grammar highlighter (Shiki).** Runs at
  build time, consumes TextMate grammars (so
  `syntaxes/chordpro.tmLanguage.json` can be reused as-is), emits
  per-token coloured `<span>`s baked into the static HTML. Zero
  runtime JS shipped.
- **(b) Client-side highlighter (Prism / highlight.js).** Loaded
  as a JS asset on every page, runs in the reader's browser,
  tokenises and styles on first paint. Requires either bundling
  the grammar list or shipping a runtime grammar loader.
- **(c) Build-time tree-sitter highlighter.** Reuses the
  `packages/tree-sitter-chordpro/` grammar but requires running a
  tree-sitter highlighter on Node.js and emitting HTML. No
  mature, maintained Node-side tree-sitter-HTML pipeline exists
  today; the leading projects (`web-tree-sitter` + custom
  walkers, `tree-sitter-highlight` Rust crate via wasm) would
  require build-pipeline work comparable to building the
  highlighter from scratch.

## Decision

Use [Shiki](https://shiki.style/) at build time, integrated into
the existing `marked` → `DOMPurify` pipeline at
`packages/playground/scripts/lib/docs-render.mjs`. Specifically:

- Override marked's `code` token renderer to call
  `highlightCodeBlock(token.text, token.lang)`. Highlighted
  output is `<pre class="shiki"><code><span style="color:#…">…
  </span></code></pre>`.
- Load Shiki's bundled grammars for the languages the corpus
  uses: `bash`, `json`, `kotlin`, `python`, `ruby`, `rust`,
  `shell`, `swift`, `tsx`, `typescript`.
- Register the in-repo `syntaxes/chordpro.tmLanguage.json` as a
  custom Shiki language (`name: 'chordpro'`) so ChordPro fences
  highlight against the same grammar VS Code and JetBrains
  already use.
- Theme: `github-dark`. A Shiki transformer strips the
  wrapper-level inline `style` / `tabindex` Shiki emits on
  `<pre>` so the existing `.docs-prose pre` CSS rule keeps
  controlling background, padding, and border radius — the
  per-token coloured spans inside `<code>` are the only inline
  styles that survive.
- DOMPurify's allowlist is widened to accept `style` on
  `<pre>` / `<code>` / `<span>` (three tags Shiki emits). The
  `afterSanitizeAttributes` hook narrows the allowance to those
  three tags, then validates each `;`-separated declaration of
  any surviving `style` value against a **fail-closed CSS
  property:value allowlist** (`SHIKI_STYLE_DECL_RE`) covering the
  full known repertoire of Shiki themes: `color:#…`,
  `background-color:#…`, `font-style:{italic|normal|oblique}`,
  `font-weight:{bold|normal|lighter|bolder|N00}`, and
  `text-decoration:{underline|none|line-through|overline}` with
  optional space-separated combinations. Anything else —
  `url(...)`, `image-set(...)`, `image(...)`, `cross-fade(...)`,
  CSS hex-escaped parens (`\28`), `@import`, `expression(...)`,
  `behavior:`, `-moz-binding`, `var(--x)`, CSS comments — fails
  to match and causes full-attribute strip. This prevents
  authored markdown from smuggling `background-image:url(/exfil)`
  or any of the analogous resource-loading CSS functions into the
  deployed HTML.
- Build-time validation: `build-docs-static.mjs`'s
  `assertEveryFenceLangIsLoaded` scans every fence header under
  `docs/sdk/` and throws if any lang does not resolve through
  `resolveShikiLang`. New languages in markdown MUST extend
  `SHIKI_LANGS` / `SHIKI_LANG_ALIASES` in the same commit; the
  build fails loudly instead of silently degrading to plain
  `<pre><code>`.
- An input-size guard on `highlightCodeBlock` (256 KiB) turns a
  runaway fence into a build error rather than a pathological
  highlight run. The docs corpus's longest fence is 743 bytes
  (`docs/sdk/tasks/embed-react.md`, `tsx` block — measured by
  walking every fence under `docs/sdk/` and recording the
  largest UTF-8 byte length) so the ceiling is generous.

The Zed extension's tree-sitter grammar is intentionally NOT
integrated. The docs-site grammar reuse only spans the surfaces
that already consume TextMate (VS Code, JetBrains); the Zed
grammar lives on a separate tree-sitter track and is out of
scope for this ADR.

## Rationale

Shiki is the only mature, maintained, build-time, TextMate-grammar
HTML highlighter in the JavaScript ecosystem. It was originally
extracted from the VS Code tokeniser stack and uses the same
`vscode-textmate` machinery (and, since Shiki 1.x, the pure-JS
`oniguruma-to-es` transpiler in place of the Oniguruma WASM
binary). That lineage delivers three properties no other option
provides:

1. **VS Code-equivalent colouring**, so on-page docs render
   identically to what readers see in their editor.
2. **TextMate grammar reuse**, so
   `syntaxes/chordpro.tmLanguage.json` — already maintained for
   the VS Code extension and JetBrains plugin — is the
   single source of truth for ChordPro highlighting across docs +
   editors. No third grammar to keep in sync.
3. **Build-time-only execution.** Shiki and every transitive
   dependency are marked `"dev": true` in the lockfile and never
   reach the deployed bundle. The static HTML carries no
   highlighter runtime, no grammars, no themes — only the
   pre-tokenised coloured spans Shiki emitted at build time. ADR-0021's
   zero-JS guarantee is preserved verbatim.

Option (b) — client-side Prism / highlight.js — was rejected on
the zero-JS constraint alone. Beyond that, both projects use
their own custom grammar formats (Prism's `Prism.languages` JS
objects, highlight.js's per-language modules), neither of which
consumes TextMate grammars. ChordPro support would require
maintaining a fourth grammar (TextMate for VS Code + JetBrains,
tree-sitter for Zed, Prism/highlight.js for docs) on a
hand-rolled basis.

Option (c) — build-time tree-sitter — was rejected on
implementation cost. No production-grade Node-side
tree-sitter-to-HTML pipeline exists; the closest options
(`tree-sitter-highlight` Rust crate run via wasm in Node, or a
custom walker over `web-tree-sitter`'s parse tree) would require
build-pipeline work that exceeds the value delivered. If the Zed
grammar ever needs first-class reuse in this docs surface, that
case can be re-opened — but the watch signal is "tree-sitter
becomes the canonical grammar across editors", not
"tree-sitter-highlight reaches GA on Node".

The `github-dark` theme was chosen because it (a) matches the
project's existing `.docs-prose pre` dark background tone, (b) is
the default theme used in the VS Code extension's preview
context, and (c) is the most widely-recognised dark theme so the
on-page docs visual matches reader expectations from GitHub's own
code rendering. A light-mode toggle is out of scope for this ADR
(none of the rest of the docs site supports one yet).

## Consequences

**Positive.**

- Zero new runtime JS on the deployed pages. ADR-0021's zero-JS
  posture is preserved structurally, not just by intent — the
  highlighter object lives only in the build script's module
  graph.
- ChordPro fences highlight against the same TextMate grammar VS
  Code and JetBrains consume; future grammar improvements
  propagate to docs on the next build with no extra work.
- The build-time `assertEveryFenceLangIsLoaded` gate turns
  "silent fallback to plain `<pre><code>`" into a loud build
  failure. A doc author who adds ` ```yaml ``` ` without
  extending the lang roster gets an actionable error message
  pointing them to `docs-render.mjs`.
- The fail-closed CSS property:value allowlist closes a class of
  CSS-exfil vectors that DOMPurify alone does not handle:
  DOMPurify treats `style` as URI-safe and skips its URI regex on
  CSS values, so `url(...)`, `image(...)`, `image-set(...)`,
  hex-escaped parens, and anything else outside the known Shiki
  repertoire would otherwise have reached the deployed HTML.

**Negative.**

- Build dependency footprint grows by `shiki@^4` and its
  transitive deps (`oniguruma-to-es`, `oniguruma-parser`,
  `@shikijs/core`, `@shikijs/types`, `@shikijs/langs`,
  `@shikijs/themes`, `hast-util-to-html`, `mdast-util-to-hast`).
  Every one of these is `"dev": true` and runs only at build time,
  so the surface is bounded; the watch signal is "Shiki
  abandonment" or "an advisory against any of these packages."
- Top-level `await createHighlighter(...)` in `docs-render.mjs`
  makes the module load-time async. Vitest and the build script
  already use ESM imports that await the module graph, so this is
  transparent today, but a future test framework that doesn't
  understand top-level await would not be able to import
  `docs-render.mjs` directly.
- `node scripts/build-docs-static.mjs` measured at ~1.4 s
  wall-clock for the current 18-page / 64-fence corpus on a Linux
  developer laptop (`/usr/bin/time` median across three runs),
  dominated by Shiki grammar + theme initialisation rather than
  per-fence work. Acceptable for the current corpus; if the
  corpus grows toward ~200 pages, revisit by moving highlighting
  to a per-page Vite plugin that caches highlighted HTML by file
  hash.

**Mitigations.**

- The build-time validator (`assertEveryFenceLangIsLoaded`)
  guarantees the silent-fallback failure mode cannot ship.
- The `stripPreWrapper` transformer uses an allowlist (`class`
  only) rather than a denylist, so future Shiki versions adding
  new wrapper attributes cannot leak into the deployed HTML.
- The DOMPurify hook's `style`-narrowing branch is pinned by
  adversarial unit tests covering tag scoping (`<div>`, `<a>`,
  `<p>`, SVG children) AND value scoping (13 vectors against the
  property:value allowlist: `url(...)`, `image(...)`,
  `image-set(...)`, `cross-fade(...)`, hex-escaped parens,
  `@import`, `var(--x)`, CSS comments, plus four
  unrecognised-property strip cases). The Playwright smoke
  asserts `<pre class="shiki">` has no surviving `style`
  attribute end-to-end, so a `stripPreWrapper` regression cannot
  ship even if the unit suite is skipped. A sister-site denylist
  in `crates/render-html/src/lib.rs::sanitize_tag_attrs` provides
  matching coverage for raw-SVG passthrough.

## Alternatives considered

**Client-side Prism / highlight.js.** Rejected on the zero-JS
constraint (ADR-0021). Also rejected on grammar reuse — neither
consumes TextMate, so ChordPro support would require a fourth
hand-maintained grammar on top of TextMate (VS Code / JetBrains)
and tree-sitter (Zed).

**Build-time tree-sitter.** Rejected on implementation cost. No
production-grade Node-side tree-sitter-to-HTML pipeline exists;
building one would dwarf the value delivered. Watch signal:
tree-sitter becomes the canonical grammar across editors, OR a
mature `tree-sitter-highlight` for Node ships.

**Pygments via a Node subprocess.** Build-time, robust grammar
catalogue, no JS payload on the deployed page. Rejected because
it would introduce a Python dependency to the playground's build
pipeline (the rest of the project's build does not require
Python), and because ChordPro support would require maintaining
a Pygments lexer in addition to the existing TextMate / tree-sitter
grammars.

**No highlighter (status quo).** Rejected because the value
delivered to readers (especially on `embed-react/`, 12 copy-paste
TSX fences) materially outweighs the build-pipeline cost.

## References

- Issue: [#2570](https://github.com/koedame/chordsketch/issues/2570)
- PR: [#2571](https://github.com/koedame/chordsketch/pull/2571)
- Parent: [ADR-0021](0021-docs-site-co-located-with-playground.md)
  (zero-JS docs site)
- Implementation:
  - [`packages/playground/scripts/lib/docs-render.mjs`](../../packages/playground/scripts/lib/docs-render.mjs)
    — `highlightCodeBlock`, `resolveShikiLang`,
    `stripPreWrapper`, DOMPurify hook.
  - [`packages/playground/scripts/build-docs-static.mjs`](../../packages/playground/scripts/build-docs-static.mjs)
    — `assertEveryFenceLangIsLoaded` gate.
- Shiki upstream: <https://shiki.style/>
- Watch signals for re-evaluation:
  - Shiki abandonment / advisory against any preloaded
    transitive dep → re-pick the build-time highlighter.
  - Tree-sitter becomes the canonical grammar across all editors
    (Zed convention adopted by VS Code / JetBrains) →
    re-evaluate option (c) so the docs surface stays grammar-
    aligned with editors.
  - Corpus exceeds ~200 pages → move per-fence highlighting into
    a hashed Vite plugin to keep build times bounded.
  - Reader request for a light-mode docs toggle → ADR a
    theme-switch story; this ADR's `github-dark` choice is
    site-wide today.
