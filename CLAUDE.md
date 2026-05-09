# CLAUDE.md — Project Context for Claude Code

## Project Overview

**ChordSketch** is a Rust rewrite of the Perl [ChordPro](https://www.chordpro.org/)
reference implementation. The goal is full compatibility with the ChordPro file format
and rendering pipeline, implemented as a set of focused Rust library crates with a CLI
front-end.

All code, comments, documentation, commit messages, and PR descriptions must be in
**English**.

## Build Commands

```bash
cargo build          # Build all crates
cargo test           # Run all tests
cargo test -- --ignored  # Run tests requiring external tools
cargo clippy         # Lint (CI uses -D warnings)
cargo fmt --check    # Check formatting (CI enforced)
cargo fmt            # Auto-format code
```

## Architecture

This is a Cargo workspace with the following crates:

| Crate | Path | Kind | Dependencies |
|---|---|---|---|
| `chordsketch-chordpro` | `crates/chordpro` | lib | *none* (zero external deps) |
| `chordsketch-ireal` | `crates/ireal` | lib | *none* (zero external deps). iReal Pro AST + zero-dep JSON debug serializer / parser (#2055); foundation for the iReal Pro feature set tracked under #2050. |
| `chordsketch-render-text` | `crates/render-text` | lib | `chordsketch-chordpro` |
| `chordsketch-render-html` | `crates/render-html` | lib | `chordsketch-chordpro` |
| `chordsketch-render-pdf` | `crates/render-pdf` | lib | `chordsketch-chordpro` |
| `chordsketch-render-ireal` | `crates/render-ireal` | lib | `chordsketch-ireal`. iReal Pro chart SVG renderer — page frame + metadata header + 4-bars-per-line grid layout engine with section line breaks + superscript chord-name typography + repeat / final / double barlines + N-th-ending brackets + section-letter labels + music-symbol glyphs (#2058 scaffold + #2060 layout + #2057 typography + #2059 barlines/markers + #2062 music symbols). Music glyphs use real Bravura SMuFL outlines for segno / coda baked into `src/bravura.rs` as static SVG `<path>` data ([ADR-0014](docs/adr/0014-bravura-glyphs-as-svg-paths.md), #2348); `D.C.` / `D.S.` / `Fine` remain italic text because iReal Pro models them as text directives. |
| `chordsketch-convert` | `crates/convert` | lib | `chordsketch-chordpro`, `chordsketch-ireal` (`chordsketch-render-text` is a `[dev-dependencies]` entry for round-trip integration tests only). ChordPro ↔ iReal Pro conversion bridge — both directions implemented: iReal → ChordPro (#2053) and ChordPro → iReal (#2061). |
| `chordsketch-convert-musicxml` | `crates/convert-musicxml` | lib | `chordsketch-chordpro` |
| `chordsketch` (CLI) | `crates/cli` | bin | `chordsketch-chordpro`, `chordsketch-ireal`, `chordsketch-render-text`, `chordsketch-render-html`, `chordsketch-render-pdf`, `chordsketch-render-ireal`, `chordsketch-convert-musicxml`. CLI auto-detects ChordPro vs `irealb://` input (#2335). |
| `chordsketch-lsp` | `crates/lsp` | bin | `chordsketch-chordpro`, `tower-lsp`, `tokio` |
| `chordsketch-wasm` | `crates/wasm` | cdylib | `chordsketch-chordpro`, `chordsketch-ireal`, `chordsketch-convert`, all renderers (including `chordsketch-render-ireal` with `png` + `pdf` features), `wasm-bindgen`, `serde` |
| `chordsketch-ffi` | `crates/ffi` | cdylib/staticlib/lib | `chordsketch-chordpro`, `chordsketch-ireal`, `chordsketch-convert`, all renderers (including `chordsketch-render-ireal` with `png` + `pdf` features), `uniffi`, `thiserror` |
| `chordsketch-napi` | `crates/napi` | cdylib | `chordsketch-chordpro`, `chordsketch-ireal`, `chordsketch-convert`, all renderers (including `chordsketch-render-ireal` with `png` + `pdf` features), `napi`, `napi-derive` |
| `chordsketch-desktop` | `apps/desktop/src-tauri` | bin | `chordsketch-chordpro`, `tauri` (v2). Rust shell for the desktop app; loads `apps/desktop/dist/` (Vite build of `@chordsketch/ui-web` + `@chordsketch/wasm`) inside the WebView. Excluded from default workspace operations via `default-members` because its transitive deps need webkit2gtk / WebView2. CI's `desktop-smoke` job in `ci.yml` covers fast Linux regression catching on every PR; `desktop-build.yml` runs the full 4-cell matrix (macOS x86_64 + aarch64, Windows, Linux) and uploads unsigned installer bundles as workflow artefacts (#2077); `desktop-release.yml` fires on `desktop-v*` tags and publishes a GitHub Release with bundles + `SHA256SUMS` (#2078), pushes `Casks/chordsketch.rb` to `koedame/homebrew-tap` so `brew install --cask chordsketch` picks up the new DMG (#2079), and publishes `latest.json` for the Tauri updater plugin to drive in-app auto-updates (#2076; keys managed per ADR-0005). Apple Developer ID signing / notarization (#2075) still layers on top for Gatekeeper. |

Additionally, these non-Rust packages exist:

| Package | Path | Description |
|---|---|---|
| `@chordsketch/wasm` | `packages/npm` | npm package, **dual build** (browser ESM + Node.js CJS) with TypeScript types |
| `@chordsketch/node` | `crates/napi` | Native Node.js addon via napi-rs, multi-package prebuilt layout (main resolver + 5 platform packages). See `docs/releasing.md` §napi distribution. |
| `@chordsketch/ui-web` | `packages/ui-web` | Framework-agnostic editor + preview UI shared by playground and the Tauri desktop app. Pluggable via `MountOptions.createEditor` — playground uses the default `<textarea>` (also exposed as the named `defaultTextareaEditor` export so runtime-swap callers reuse the same factory), desktop injects a CodeMirror 6 + `tree-sitter-chordpro` factory (#2072). `MountOptions.headerControls` accepts host elements injected after the built-in format / transpose clusters, and `ChordSketchUiHandle.replaceEditor(factory)` swaps the editor adapter at runtime — both back the playground's ChordPro / iRealb format toggle (#2366). `mountChordSketchUi` awaits `Renderers.init()` before invoking the editor factory, so factories may safely use wasm-backed helpers in their constructors (#2397). Private workspace package, not published. |
| `@chordsketch/ui-irealb-editor` | `packages/ui-irealb-editor` | Bar-grid GUI editor for iReal Pro charts; pluggable into `@chordsketch/ui-web`'s `MountOptions.createEditor` slot via the `EditorAdapter` contract. Ships header-metadata editing (title / composer / style / key / time / tempo / transpose) plus a 4-bars-per-line grid (#2363); bar-popover editing for chord / barline / ending / symbol (#2364); structural section / bar add / remove / reorder (#2365); runtime swap via `ChordSketchUiHandle.replaceEditor` driving the playground's ChordPro / iRealb format toggle (#2366); desktop Open/Save extension dispatch with View → Edit as Grid / Edit as URL Text radio pair (#2367); roving-tabindex + Arrow / Home / End navigation, `role="grid"` / `role="row"` / `role="gridcell"` ARIA semantics, and a polite live region for structural-edit announcements (#2368). Wasm bridge (`parseIrealb` / `serializeIrealb`) is injected by the host, so the package has only a peer-dep relationship with `@chordsketch/wasm`. Private workspace package, not published. |
| `@chordsketch/react` | `packages/react` | React component library (pre-release — full surface shipped across #2041–#2045: `<PdfExport>`+`usePdfExport`, `<ChordSheet>`+`useChordRender`, `<ChordEditor>`+`useDebounced`, `<Transpose>`+`useTranspose`, `<ChordDiagram>`+`useChordDiagram`). Dual ESM + CJS build via tsup; React 18+ peer dep; CSS at `@chordsketch/react/styles.css`. Awaits first `npm publish` (manual maintainer step). |
| Playground | `packages/playground` | Vite-based browser host that mounts `@chordsketch/ui-web` against `@chordsketch/wasm`. Browser-level mount is gated by a Playwright smoke (`tests-e2e/`) running on every PR via `playground-smoke.yml`; see `.claude/rules/playground-smoke.md` for when new specs are required (#2397). |
| Python (`chordsketch`) | `crates/ffi` | Python package via UniFFI + maturin |
| Swift (`ChordSketch`) | `packages/swift` | Swift package with XCFramework |
| Kotlin (`chordsketch`) | `packages/kotlin` | Kotlin/JVM package via JNI |
| Ruby (`chordsketch`) | `packages/ruby` | Ruby gem via UniFFI |
| `@chordsketch/syntaxes` | `syntaxes/` | TextMate grammar and language configuration for ChordPro files (private, not published) |
| VS Code extension | `packages/vscode-extension` | VS Code / Open VSX extension with TextMate highlighting, live preview, and LSP integration |
| GitHub Action | `packages/github-action` | Composite GitHub Action for rendering ChordPro files in CI |
| `tree-sitter-chordpro` | `packages/tree-sitter-chordpro` | Tree-sitter grammar for ChordPro syntax highlighting |
| ChordPro (Zed extension) | `packages/zed-extension` | Zed editor extension with tree-sitter highlighting and LSP integration (not in workspace; targets wasm32-wasi) |
| ChordPro (JetBrains plugin) | `packages/jetbrains-plugin` | JetBrains IDE plugin with TextMate syntax highlighting for ChordPro files |

The repository also ships a static design-system reference at the repo root:
`DESIGN.md` (rationale + token reference), `tokens.css` (single source of
truth for color / typography / space / radius / elevation / motion),
`design-system.html` (visual landing page), `preview/` (10 component
preview pages + index), and `ui_kits/web/` (four product-surface demos:
editor, viewer, library, iReal Pro chart editor). These are static
HTML/CSS — no build step. Token decisions in `tokens.css` are the
authoritative reference for `@chordsketch/ui-web`, `@chordsketch/react`,
the playground, and the desktop app.

### Dependency Policy

- `chordsketch-chordpro` must have **zero external dependencies**. All parsing and AST logic
  is implemented from scratch.
- Renderer crates may depend only on `chordsketch-chordpro` and, when justified, minimal
  external crates.
- The CLI crate may use external crates for argument parsing, I/O, etc.

### License Policy

- **SDK layer** (all current crates): MIT
- **Application layer** (future Forum, Playground, Desktop apps): AGPL-3.0-only

## Project Tracking

- **GitHub Project**: https://github.com/orgs/koedame/projects/1/views/1
- **Issues**: https://github.com/koedame/chordsketch/issues

## Merge Policy

PRs are automatically reviewed; **merging defaults to a human action**, with
a conditional carve-out for AI-assistant merges (see step 5 below and
[ADR-0013](docs/adr/0013-conditional-bot-driven-merge.md)).

1. **PR created** — CI runs (fmt, clippy, test, plus workflow-specific smoke jobs)
2. **Auto-review** — Claude reviews with severity classification on CI success
3. **All findings, every severity, resolved in-PR** — Claude pushes fix commits
   (High first, Nit last), CI re-runs, delta review iterates. Review bots do NOT
   create follow-up issues for findings; the in-PR fix is the only path.
4. **Convergence** — loop iterates until the delta review surfaces zero findings
   (or the 3-iteration safety cap in `.claude/rules/pr-workflow.md` fires).
5. **Ready for merge** — when the review converges, Claude posts a
   "Ready for merge" comment. A human inspects the **full check rollup** (not
   just the required checks listed in branch protection), verifies there are no
   review-bot-authored issues still open against the PR, and performs the squash
   merge — *or* an AI assistant runs `gh pr merge <N> --squash` when all
   four conditions in `.claude/rules/pr-workflow.md`'s "Bot-driven merge:
   conditional permission" section hold (explicit per-session user permission,
   full check rollup green, auto-review converged on HEAD, direct squash merge).

All PRs are **squash-merged**. Branch protection requires CI to pass on HEAD.
Bot-driven merge is conditional on the four-clause check above — see
`.claude/rules/pr-workflow.md` for the full rule.

## Parallel Development with tmux

This project is designed for multiple Claude Code instances working simultaneously
via tmux.

**Key principle**: Each instance works in an isolated git worktree. No shared mutable
state.

| Resource | Isolation Method |
|---|---|
| Git branch | One branch per worktree, named `issue-{N}-{slug}` |
| Build artifacts | Each worktree has its own `target/` directory |
| Network ports | `3000 + issue_number` |
| Working directory | `../chordsketch-wt/issue-{N}-{slug}/` |

**Before starting work**: Always create a fresh worktree from latest `origin/main`.
**After PR merge**: Remove the worktree and local branch.

## Ticket-Driven Development

- No code changes without a corresponding GitHub Issue.
- Branch names must reference the issue number.
- PR descriptions must include `Closes #N`.
- Use `gh issue create` for new work, `gh issue list` to find existing work.

## Compatibility Strategy

- The ChordPro file format specification (https://www.chordpro.org/chordpro/) is the
  primary reference.
- The Perl reference implementation is the source of truth for ambiguous or
  underdocumented behavior.
- Parser behavior is validated via **golden tests**: input `.cho` files paired with
  expected output snapshots.
- Compatibility with the Perl reference implementation is verified by comparing output
  on a shared test corpus.
