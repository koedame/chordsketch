# ChordSketch SDK Guide

A unified entry point for using ChordSketch from any language or
runtime. Pick a starting point that fits how you are integrating:

## I want to do a specific thing

- [Render to HTML, plain text, or PDF](tasks/render.md)
- [Transpose chords by N semitones](tasks/transpose.md)
- [Embed ChordPro and iReal Pro in a React app](tasks/embed-react.md)
  — 10 copy-paste recipes covering the `@chordsketch/react`
  component surface (`<ChordProEditor>`, `<ChordSheet>`,
  `<IrealProEditor>`, `<PdfExport>`, custom AST rendering, SSR
  notes).

Each task page shows the same operation across every binding, so
you can copy the snippet that matches your stack.

## I know my language already

| Language / runtime | Package | Per-package README (full reference) |
|---|---|---|
| Rust | [`chordsketch-chordpro`](https://crates.io/crates/chordsketch-chordpro) (parser/AST) + [`-render-text`](https://crates.io/crates/chordsketch-render-text) / [`-render-html`](https://crates.io/crates/chordsketch-render-html) / [`-render-pdf`](https://crates.io/crates/chordsketch-render-pdf) | [docs.rs/chordsketch-chordpro](https://docs.rs/chordsketch-chordpro) |
| Browser / Deno / Node ESM | [`@chordsketch/wasm`](https://www.npmjs.com/package/@chordsketch/wasm) | [`packages/npm/README.md`](../../packages/npm/README.md) |
| Node.js native addon | [`@chordsketch/node`](https://www.npmjs.com/package/@chordsketch/node) | [`crates/napi/README.md`](../../crates/napi/README.md) |
| Python | [`chordsketch`](https://pypi.org/project/chordsketch/) (UniFFI) | [`crates/ffi/README.md`](../../crates/ffi/README.md) |
| Swift | [`ChordSketch`](https://swiftpackageindex.com/koedame/chordsketch) (Swift Package + XCFramework) | [`packages/swift/README.md`](../../packages/swift/README.md) |
| Kotlin / JVM | [`me.koeda:chordsketch`](https://central.sonatype.com/artifact/me.koeda/chordsketch) | [`packages/kotlin/README.md`](../../packages/kotlin/README.md) |
| Ruby | [`chordsketch`](https://rubygems.org/gems/chordsketch) | [`packages/ruby/README.md`](../../packages/ruby/README.md) |
| CLI / shell scripts | `chordsketch` binary | [main `README.md` Installation section](../../README.md#installation) + `chordsketch --help` |

The per-package READMEs are L2-quality
(per [`.claude/rules/package-documentation.md`](../../.claude/rules/package-documentation.md))
— install command, full API table, options. They are kept current
with each release, so this guide intentionally does not duplicate
them for binding-specific details. Cross-link to the relevant task
page above when you need the same operation across multiple
bindings (e.g. matching desktop and web renderings).

## I want UI components

- **React**:
  [`@chordsketch/react`](https://www.npmjs.com/package/@chordsketch/react)
  — published, includes both the ChordPro and iReal Pro embedding
  surfaces. `v0.2.0` brings the iReal Pro surface to parity with
  the private `@chordsketch/ui-irealb-editor`: interactive bar
  grid, structural editing, keyboard navigation, and
  popover-based per-bar chord editing. See the
  [Embed ChordPro and iReal Pro in a React app](tasks/embed-react.md)
  recipe guide.
- **Vue / Svelte / others** are tracked under
  [#2039](https://github.com/koedame/chordsketch/issues/2039) and
  not yet released. When they ship they will get their own task
  pages here.

## How the SDK fits together

ChordSketch is a Rust workspace at the bottom — `chordsketch-chordpro`
parses ChordPro source into an AST, then the three renderer crates
(`chordsketch-render-{text,html,pdf}`) walk the AST to produce
output. Every other binding is a thin wrapper that exposes the
**same** Rust API surface in idiomatic form for its host language:

```
           ┌──────────────────────────────────────────┐
           │  chordsketch-chordpro (parser + AST)     │
           │  chordsketch-render-{text,html,pdf}      │
           └──────────────────────────────────────────┘
                                ▲
       ┌──────────────┬─────────┴─────┬──────────────┐
       │              │               │              │
  chordsketch    chordsketch-    chordsketch-    chordsketch-
  (CLI binary)   wasm            napi            ffi (UniFFI)
                 (browser /      (Node.js              │
                 ESM)            native)               ▼
                                              ┌──────────────────┐
                                              │ Python  (PyPI)   │
                                              │ Swift   (XCFwk)  │
                                              │ Kotlin  (Maven)  │
                                              │ Ruby    (Gems)   │
                                              └──────────────────┘
```

`chordsketch-ffi` is the single UniFFI shared library that backs
**all four** of the Python, Swift, Kotlin, and Ruby distributions.
The per-language packages (`pip install chordsketch`,
`me.koeda:chordsketch`, `gem install chordsketch`, the Swift
package) each ship a thin language-binding layer on top of the
same `crates/ffi` artefact — there is no separate `chordsketch-ruby`
crate.

Because every binding wraps the same parser and renderers, the
output of `parseAndRenderHtml(input)` (or its language-specific
equivalent) is byte-identical across hosts for any given input.
PRs that introduce per-binding output drift are caught by the
fix-propagation rule (`.claude/rules/fix-propagation.md`).

## Status

This guide is being written incrementally. Two task pages are
landed (render, transpose); they cover every existing binding
(Rust, WASM, NAPI, CLI, Python, Swift, Kotlin, Ruby). Future
additions will track new bindings and new operations as they are
exposed:

- **AST-direct parse + traversal**: only the Rust crate currently
  exposes the AST as a host object graph; the WASM / NAPI / UniFFI
  bindings expose the parser only via the `parse_and_render_*`
  one-shot. When AST-projection lands in those bindings, a
  `tasks/parse.md` page will be added.
- **Serialise back to ChordPro**: not currently exposed by any
  binding. Tracked as part of the v0.3.0 multi-format track
  (#2050).
- **Static-site rendering**: the canonical Markdown under
  `docs/sdk/` is also rendered by the docs site at
  [chordsketch.koeda.me/docs](https://chordsketch.koeda.me/docs/)
  ([ADR-0021](../adr/0021-docs-site-co-located-with-playground.md)).
  Both surfaces consume the same source — edits here propagate to
  both on the next deploy.

If you find a gap, please [file an issue](https://github.com/koedame/chordsketch/issues/new).
