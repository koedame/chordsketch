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

Reproducible CLI build via nix (uses the pinned `nixpkgs` in
`flake.nix`):

```bash
nix build .#chordsketch         # Build the CLI inside a nix sandbox
nix run . -- --version          # Run the built CLI
nix flake check                 # Eval-time checks (incl. fetchurl UA)
```

`nix build` runs the same Rust toolchain version as the
nixos-unstable revision pinned in `flake.nix` and runs the
package's unit-test suite inside the sandbox. The build relies on
a crates.io-compliant `User-Agent` injection from the
`identifiedFetchurlOverlay` in `flake.nix` (see that file's
comment block for the rationale); `nix flake check` asserts the
UA stays wired in so a refactor that silently drops it fails
loudly instead of returning crates.io 403s.

Playground + docs site (run inside `packages/playground/`):

```bash
npm test             # vitest (docs SSG + helpers)
npm run typecheck    # tsc --noEmit
npm run build        # vite build + Shiki-highlighted static docs
npm run build:docs   # docs-only build (skips wasm-dependent entries)
npm run dev:docs     # docs-only preview (static build, then `vite preview`)
npm run test:e2e     # Playwright smoke (use playwright.docs.config.ts
                     # locally to skip wasm-dependent specs)
```

`npm run build` and `npm run build:docs` invoke
`scripts/build-docs-static.mjs`'s `assertEveryFenceLangIsLoaded`
gate per [ADR-0025](docs/adr/0025-build-time-syntax-highlighting-shiki.md);
a fence header in `docs/sdk/**/*.md` that is not in `SHIKI_LANGS`
(or in `SHIKI_LANG_ALIASES` with a loaded target) fails the build.
Add the lang in
`packages/playground/scripts/lib/docs-render.mjs` in the same
commit.

## Workflows

Long-running autonomous tasks live under `.claude/workflows/<name>/` and
run via `scripts/run-workflow.sh <name>`. Each workflow is a graph of
phases; each phase is a Markdown prompt executed as a separate
`claude -p` invocation. State passes between phases through a JSON file
under `.claude/workflow-state/<name>/` (git-ignored).

| File | Purpose |
|---|---|
| `scripts/run-workflow.sh` | Generic orchestrator. `./scripts/run-workflow.sh <name>` |
| `.claude/workflows/README.md` | Layout contract; how to add a workflow |
| `.claude/workflows/<name>/workflow.json` | Phase graph (entry, phases, terminals) |
| `.claude/workflows/<name>/phases/*.md` | Individual phase prompts |
| `.claude/rules/workflow-discipline.md` | Phase-author rules (HALT discipline, schema evolution, naming) |
| `.claude/commands/new-workflow.md` | Scaffold skill: `/new-workflow <name>` creates the skeleton |
| `scripts/validate-workflow.py` | Static check of `workflow.json` integrity |
| `scripts/test_validate_workflow.py` | Unit tests for `validate-workflow.py` |
| `scripts/test_run_workflow.py` | End-to-end smoke test for the orchestrator (stubs `claude`, `flock`, `timeout`) |

Architectural rationale: [ADR-0018](docs/adr/0018-phase-based-shell-orchestrated-workflows.md).
Production workflow: `autopilot-issue` — batch-mode autonomous
handler per [ADR-0019](docs/adr/0019-batch-mode-autopilot-issue.md).
One round picks every high-confidence (4-axis min ≥80)
unchidev-authored issue (capped at 10), implements each as one
commit per issue on a single `batch-YYYY-MM-DD-N1-N2-...` branch,
opens one aggregated PR, and drives it to Ready-for-merge.
Single-eligible-candidate rounds degenerate to the historical
`issue-{N}-{slug}` branch / one-issue PR shape transparently.

## Architecture

This is a Cargo workspace with the following crates:

| Crate | Path | Kind | Dependencies |
|---|---|---|---|
| `chordsketch-chordpro` | `crates/chordpro` | lib | *none* (zero external deps). AST + parser + transforms; ships a hand-rolled, zero-dep JSON serialiser at `src/json.rs` ([ADR-0017](docs/adr/0017-react-renders-from-ast.md), #2475) so wasm consumers can drive the React AST → JSX walker without an HTML round-trip. The `transpose` module exposes the song-wide canonical-spelling API (`transpose_chord_with_style`, `transposed_key_prefers_flat`, `canonical_transposed_key`, `canonical_key_spelling`, `key_prefers_flat`) every renderer routes through to keep chord lines on one side of the circle of fifths (A# → Bb, D# → Eb, etc. when the song lands on a flat-side key). It also exports `effective_transpose(file, cli, capo)` ([ADR-0023](docs/adr/0023-capo-transposes-displayed-chords.md)) — the single-source composition helper every renderer + the wasm parse path routes through so the `file + cli - capo` rule cannot drift between surfaces. The `typography` module exposes `unicode_accidentals` and `tempo_marking_for` shared by all three Rust renderers + the React JSX walker sister-site. The `grid` module exposes the structured `{start_of_grid}` tokeniser (`tokenize_grid_line`, `classify_grid_row`, `GridShape::parse`, `extract_grid_label`) — sister-site to `tokenizeGridLine` / `parseGridShape` / `extractGridLabel` in `packages/react/src/chordpro-jsx.tsx`. Renderers route grid body content through this module to surface barlines, volta brackets, `%` / `%%` measure-repeats, cell-internal `~` multi-chord, strum rows (`|s ...`), row labels (`A` / `Coda`), and trailing comments uniformly across all four surfaces. |
| `chordsketch-ireal` | `crates/ireal` | lib | *none* (zero external deps). iReal Pro AST + zero-dep JSON debug serializer / parser (#2055); foundation for the iReal Pro feature set tracked under #2050. AST covers the full URL grammar — `(altchord)` parens (`Chord::alternate`), `n` no-chord (`Bar::no_chord`), `Kcl` / `x` / `r` simile (`Bar::repeat_previous`), staff-text tokens `<text>` / `<*XYtext>` / `<Nx>` preserved as a structured `Vec<StaffText>` on `Bar::staff_texts` with the spec's two-digit vertical-position prefix (`*XY` ∈ `00..=74`) and `<Nx>` repeat-count override classified at parse time (#2426), `Y` / `YY` / `YYY` between-system vertical-space hint clamped to 0..=3 (`Bar::system_break_space`, #2434), and the `irealbook://` 6-field URL shape (`Title=Composer=Style=Key=TimeSig=Music`) alongside the canonical 7..=9-field `irealb://` shape. `S` / `Q` / `<D.C.>` / `<D.S.>` / `<Fine>` / `<Break>` markers attach to the bar in which they appear. The eleven player-recognised `<D.C. al ...>` / `<D.S. al ...>` staff-text phrases are structurally distinguished via `MusicalSymbol::DaCapo(JumpTarget)` / `DalSegno(JumpTarget)` with exact-phrase classification (#2427); accidental synonyms (`End`, `Ending` for `End.`) are accepted by the parser and canonicalise to `End.` on re-emission. Open-protocol scope: parses iReal Pro export inputs (`irealb://` obfuscated, `irealbook://` 6-field — including the spec's `n` absent-header sentinel in field 5, exercised by the `parser_open_protocol/a_walkin_thing/` round-trip golden fixture) and serializes back via both `irealb_serialize` / `irealbook_serialize` AND the spec's open-protocol plain-text `serialize_open_protocol` / `serialize_open_protocol_collection` (#2425). Chord-size markers `s`/`l` (#2433, `ChordSize::{Default, Small}`), pause-slash `p` (#2435, `BarChordKind::SlashRepeat`), compound-time additive groupings (#2449, `BeatGrouping`), and the `Break` drum-silence directive (#2448, `MusicalSymbol::Break`) are now in the AST. The `END` song-terminator (#2451) is deferred per `crates/ireal/ARCHITECTURE.md`'s "Deferred AST scope" → "Other deferred items" — empirical investigation confirmed the URL exporter does not emit it. Every in-scope umbrella-#2423 sub-issue is now landed; [`crates/ireal/README.md`](crates/ireal/README.md#scope) holds the canonical Supported / Out-of-scope tables. |
| `chordsketch-render-text` | `crates/render-text` | lib | `chordsketch-chordpro` |
| `chordsketch-render-html` | `crates/render-html` | lib | `chordsketch-chordpro`. Static-output HTML emitter — canonical for non-React consumers (CLI `--format html`, FFI bindings, GitHub Action, VS Code preview iframe) per [ADR-0017](docs/adr/0017-react-renders-from-ast.md). The React surface (`<ChordSheet format="html">`, `<RendererPreview format="html">`, the playground) consumes the AST directly via `@chordsketch/react`'s `chordpro-jsx` walker as of #2475 and does NOT round-trip through this crate. |
| `chordsketch-render-pdf` | `crates/render-pdf` | lib | `chordsketch-chordpro` |
| `chordsketch-render-ireal` | `crates/render-ireal` | lib | `chordsketch-ireal`. iReal Pro chart SVG renderer — page frame + metadata header + 4-bars-per-line grid layout engine with section line breaks + superscript chord-name typography + repeat / final / double barlines + N-th-ending brackets + section-letter labels + music-symbol glyphs (#2058 scaffold + #2060 layout + #2057 typography + #2059 barlines/markers + #2062 music symbols). Music glyphs use real Bravura SMuFL outlines for segno / coda baked into `src/bravura.rs` as static SVG `<path>` data ([ADR-0014](docs/adr/0014-bravura-glyphs-as-svg-paths.md), #2348); `D.C.` / `D.S.` / `Fine` remain italic text because iReal Pro models them as text directives. Chord-name typography translates the URL-stored shorthand (`b`→♭, `^`→Δ, `h`→ø, `o`→°, `-`→−, `#`→♯) and stacks two-or-more-alteration extensions (`7♭9♯5` → `7♭9 / ♯5`) via a `\|`-separated payload the playground React chart and SVG renderer both consume; exposed as `chordTypography` on the wasm surface so external consumers can drive the same span layout. The newer AST fields (`Bar::no_chord`, `Bar::repeat_previous`, `Chord::alternate`) are AST-and-React-chart-only today; SVG paint for them is tracked under #2050 follow-ups. `Bar::staff_texts` IS painted by the SVG renderer: each [`StaffText`] entry renders as an italic serif caption under the bar's chord by default, lifted toward the music-symbol band on `*XY` values approaching 74 (#2426). `Bar::system_break_space` IS painted by the SVG renderer: any row whose leading bar carries a non-zero hint receives proportional vertical padding (`VERTICAL_BREAK_PER_LEVEL` user-units per level) above the row frame (#2434). |
| `chordsketch-convert` | `crates/convert` | lib | `chordsketch-chordpro`, `chordsketch-ireal` (`chordsketch-render-text` is a `[dev-dependencies]` entry for round-trip integration tests only). ChordPro ↔ iReal Pro conversion bridge — both directions implemented: iReal → ChordPro (#2053) and ChordPro → iReal (#2061). |
| `chordsketch-convert-musicxml` | `crates/convert-musicxml` | lib | `chordsketch-chordpro` |
| `chordsketch` (CLI) | `crates/cli` | bin | `chordsketch-chordpro`, `chordsketch-ireal`, `chordsketch-render-text`, `chordsketch-render-html`, `chordsketch-render-pdf`, `chordsketch-render-ireal`, `chordsketch-convert-musicxml`. CLI auto-detects ChordPro vs `irealb://` input (#2335). |
| `chordsketch-lsp` | `crates/lsp` | bin | `chordsketch-chordpro`, `tower-lsp`, `tokio` |
| `chordsketch-wasm` | `crates/wasm` | cdylib | `chordsketch-chordpro`, `chordsketch-ireal`, `chordsketch-convert`, `chordsketch-render-text`, `chordsketch-render-html`, `chordsketch-render-ireal` (SVG-only by default); behind the default-on `png-pdf` Cargo feature also `chordsketch-render-pdf` and `chordsketch-render-ireal` with `png` + `pdf` features. `wasm-bindgen`, `serde`. Two wasm-pack outputs ship from this single crate (#2466): `@chordsketch/wasm` (built with `--no-default-features`, ~400 KB raw / ~175 KB gzipped) and `@chordsketch/wasm-export` (default features, ~9.7 MB raw / ~6.4 MB gzipped). |
| `chordsketch-ffi` | `crates/ffi` | cdylib/staticlib/lib | `chordsketch-chordpro`, `chordsketch-ireal`, `chordsketch-convert`, all renderers (including `chordsketch-render-ireal` with `png` + `pdf` features), `uniffi`, `thiserror` |
| `chordsketch-napi` | `crates/napi` | cdylib | `chordsketch-chordpro`, `chordsketch-ireal`, `chordsketch-convert`, all renderers (including `chordsketch-render-ireal` with `png` + `pdf` features), `napi`, `napi-derive` |
| `chordsketch-desktop` | `apps/desktop/src-tauri` | bin | `chordsketch-chordpro`, `tauri` (v2). Rust shell for the desktop app; loads `apps/desktop/dist/` (Vite build of a React app that mounts `@chordsketch/react`'s `<ChordProEditor>` / `<IrealProEditor>` against `@chordsketch/wasm`) inside the WebView. A `desktopBridge` singleton routes Tauri menus / Open-Save dialogs / updater events into the React layer (#2527). Excluded from default workspace operations via `default-members` because its transitive deps need webkit2gtk / WebView2. CI's `desktop-smoke` job in `ci.yml` covers fast Linux regression catching on every PR; `desktop-build.yml` runs the full 4-cell matrix (macOS x86_64 + aarch64, Windows, Linux) and uploads unsigned installer bundles as workflow artefacts (#2077); `desktop-release.yml` fires on `desktop-v*` tags and publishes a GitHub Release with bundles + `SHA256SUMS` (#2078), pushes `Casks/chordsketch.rb` to `koedame/homebrew-tap` so `brew install --cask chordsketch` picks up the new DMG (#2079), and publishes `latest.json` for the Tauri updater plugin to drive in-app auto-updates (#2076; keys managed per ADR-0005). Apple Developer ID signing / notarization (#2075) still layers on top for Gatekeeper. |

Additionally, these non-Rust packages exist:

| Package | Path | Description |
|---|---|---|
| `@chordsketch/wasm` | `packages/npm` | npm package, **dual build** (browser ESM + Node.js CJS) with TypeScript types. Lean bundle (~400 KB raw / ~175 KB gzipped) — parse + transpose + text / HTML / SVG / iReal chord-typography. Built from `crates/wasm` with `--no-default-features`; PDF / PNG exports are split into `@chordsketch/wasm-export` (#2466). |
| `@chordsketch/wasm-export` | `packages/npm-export` | npm package, same dual-build layout. Heavy bundle (~9.7 MB raw / ~6.4 MB gzipped) — adds `render_pdf` / `render_pdf_with_options` (ChordPro → PDF) and `renderIrealPng` / `renderIrealPdf` (iReal Pro → PNG / PDF) on top of every export the lean bundle ships. Built from the same `crates/wasm` source with default features, so the `png-pdf` Cargo feature pulls in `chordsketch-render-pdf` plus `chordsketch-render-ireal` `png` + `pdf` features (resvg / tiny-skia / svg2pdf / fontdb / harfrust transitive deps). Consumers dynamic-load this package only when actually exporting — `@chordsketch/react`'s `<PdfExport>` declares it as an optional peer dep and lazy-imports via `usePdfExport` (#2466). |
| `@chordsketch/node` | `crates/napi` | Native Node.js addon via napi-rs, multi-package prebuilt layout (main resolver + 5 platform packages). See `docs/releasing.md` §napi distribution. |
| `@chordsketch/ui-irealb-editor` | `packages/ui-irealb-editor` | Bar-grid GUI editor for iReal Pro charts (#2363, #2364, #2365); header-metadata editing (title / composer / style / key / time / tempo / transpose); roving-tabindex + Arrow / Home / End navigation, `role="grid"` / `role="row"` / `role="gridcell"` ARIA semantics, and a polite live region for structural-edit announcements (#2368). Wasm bridge (`parseIrealb` / `serializeIrealb`) is injected by the host, so the package has only a peer-dep relationship with `@chordsketch/wasm`. **Private workspace package**, not published to npm. External integrators should use `@chordsketch/react`'s `<IrealBarGrid>` / `<IrealProEditor>` instead per [ADR-0020](docs/adr/0020-ireal-pro-react-surface.md); this package is co-designed with the playground / desktop iteration loop and is not bound by semver. |
| `@chordsketch/react` | `packages/react` | React component library. v0.1.0 — first publishable release (#2473); v0.2.0 — iReal Pro surface reaches `@chordsketch/ui-irealb-editor` parity (#2505); v0.3.0 — three-tier component layout + hard symbol renames per [ADR-0022](docs/adr/0022-react-as-canonical-preview-surface.md) (#2527); v0.4.0 — the ChordPro chord editor lifts to a full-width footer spanning the editor + preview, driven by the editor caret (caret-on-chord auto-selects and the edit-only footer retypes / moves / removes it; idle shows a hint; the preview caret-marker is suppressed while a chord is selected), via the new `useChordEditor` hook + `<ChordSheet>`'s controlled-selection mode (`chordSelection` / `onChordSelectionChange`); the in-pane `<ChordInspector>` stays for standalone `<ChordSheet>` use (#2644, #2646, #2648). ChordPro surface (`<PdfExport>`+`usePdfExport`, `<ChordSheet>`+`useChordRender`, `<ChordTextarea>`+`useDebounced`, `<Transpose>`+`useTranspose`, `<ChordDiagram>`+`useChordDiagram`, `<ChordSourceArea>`, `<SplitLayout>`, `<RendererPreview>`, `<ChordProPreview>`, `<ChordProEditor>`, `<ChordInspector>`+`useChordEditor`) + iReal Pro surface (`<IrealBarGrid>`+`useIrealParse`+`useIrealSerialize`, `<IrealPreview>`+`useIrealRender`, `<IrealProEditor>`, `Ireal*` AST type re-exports). v0.3.0 renamed the legacy `<Playground>` / `<ChordEditor>` / `<SourceEditor>` / `<IrealEditor>` / `<IrealPlayground>` names with no deprecated aliases — the `Editor` suffix now denotes Tier 3 composed editors (`<ChordProEditor>`, `<IrealProEditor>`) while Tier 1 atoms use widget-type names (`<ChordTextarea>`, `<ChordSourceArea>`, `<IrealBarGrid>`). The `<ChordSheet format="html">` branch renders AST → JSX directly via the `chordpro-jsx` walker ([ADR-0017](docs/adr/0017-react-renders-from-ast.md), #2475) — `<RendererPreview format="html">` no longer wraps the output in an iframe. The `format="text"` branch keeps the wasm `render_text` path; `format="pdf"` stays a download action via `<PdfExport>`. The walker's inline `{tempo}` chip is rendered by an interactive `<MetronomeButton>` (backed by the `useMetronome` Web Audio hook) — the whole chip is the click target (clicking anywhere on the pill ticks audibly at the directive's BPM), the cursor becomes a speaker on hover, and while playing the chip's frame colour pulses once per beat; it degrades to a static, non-interactive chip under SSR / browsers without `AudioContext`. The walker's inline `{key}` chip is rendered by an interactive `<KeySignatureButton>` (backed by the `useKeyAudio` Web Audio hook, #2658) — clicking anywhere on the pill auditions the key by ear: the movable-do scale "do re mi fa sol la ti do" then the tonic triad strummed, major or minor per the key, sourced from the `keyScalePitches` / `keyTonicTriad` core exports; when a transpose is active it auditions the sounding key, and it degrades to the same static chip under SSR / no `AudioContext`. `unicodeAccidentals` lives in the leaf `music-glyphs` module (re-exported from `chordpro-jsx`) so the button and walker share it without a circular import; the shared lazy-wasm loader (`usePitchModule`) and oscillator stop helper (`stopVoices`) back both `useChordAudio` and `useKeyAudio`. The iReal Pro surface is a native React implementation per [ADR-0020](docs/adr/0020-ireal-pro-react-surface.md): v0.2.0 ships the interactive bar grid (ARIA `role="grid"` + roving tabindex + keyboard navigation), structural editing (section / bar add / rename / delete / move), and popover-based per-bar chord editing (`<IrealBarPopover>` with focus trap, chord-row editor, N-th ending input, symbol picker). Dual ESM + CJS build via tsup; React 18+ peer dep; CSS at `@chordsketch/react/styles.css`. `npm publish` is a maintainer-local manual step per [ADR-0008](docs/adr/0008-npm-publishing-is-local.md). |
| `@chordsketch/react-ui` | `packages/react-ui` | npm package — **wasm-free** React design-system primitives (`<Button>`, `<Card>`, `<Badge>` / `<Pill>`, and form controls `<Input>` / `<Textarea>` / `<Select>` / `<Checkbox>` / `<Radio>` / `<Switch>` / `<Segmented>` / `<Field>`) binding the canonical design-system class vocabulary from `design-system/DESIGN.md` §6 / `design-system/preview/components-*.html`. Per [ADR-0029](docs/adr/0029-react-ui-primitives-package.md): no `@chordsketch/wasm*` anywhere in its dependency graph (enforced by `tests/no-wasm-dep.test.ts`); `@chordsketch/react` stays domain-only and does NOT re-export it — when a domain component composes a primitive it declares `@chordsketch/react-ui` as a `peerDependency` to keep a single instance. CSS at `@chordsketch/react-ui/styles.css` (ships the `--cs-*` token layer + component rules; the design-system token names stay the source of truth). Dual ESM + CJS via tsup; React 18+ peer dep; manual `npm publish` per [ADR-0008](docs/adr/0008-npm-publishing-is-local.md). The playground consumes its `<Button>` via a vite alias (`packages/playground/vite.config.ts`). |
| Playground | `packages/playground` | Vite-based browser host that composes `@chordsketch/react`'s atomic components (`<ChordSourceArea>`, `<ChordSheet>`, `<Transpose>`, etc.) into a custom split-pane layout (not the `<ChordProEditor>` Tier 3 composed editor) against `@chordsketch/wasm`. Sample data lives at `packages/playground/src/sample.ts` (`SAMPLE_CHORDPRO` / `SAMPLE_IREALB`). Four multi-page entries: `landing` at the site root, `chordpro/`, `irealpro/`, and `docs/`. The `docs/` route is fully **pre-rendered static HTML** per [ADR-0021](docs/adr/0021-docs-site-co-located-with-playground.md) (#2506 stood up the route; #2514 converted it from a Markdown-driven SPA to per-page static output) — `scripts/build-docs-static.mjs` reads the canonical Markdown under `docs/sdk/` at build time and emits one `dist/docs/<slug>/index.html` file per registered page, each reachable at a clean URL like `/chordsketch/docs/embed-react/`. The Vite entry exists only so the CSS asset participates in the production build; the deployed HTML carries no JS beyond a small inline shim that redirects legacy `#/<slug>` URLs to the matching clean URL. Browser-level mount is gated by a Playwright smoke (`tests-e2e/`) running on every PR via `playground-smoke.yml`; see `.claude/rules/playground-smoke.md` for when new specs are required (#2397, #2506, #2514). |
| Python (`chordsketch`) | `crates/ffi` | Python package via UniFFI + maturin |
| Swift (`ChordSketch`) | `packages/swift` | Swift package with XCFramework |
| Kotlin (`chordsketch`) | `packages/kotlin` | Kotlin/JVM package via JNI |
| Ruby (`chordsketch`) | `packages/ruby` | Ruby gem via UniFFI |
| `@chordsketch/syntaxes` | `syntaxes/` | TextMate grammar and language configuration for ChordPro files (private, not published) |
| VS Code extension | `packages/vscode-extension` | VS Code / Open VSX extension with TextMate highlighting, live preview (React WebView mounting `<ChordProPreview>` from `@chordsketch/react`; the bespoke iframe-srcdoc implementation was retired in #2527), and LSP integration |
| GitHub Action | `packages/github-action` | Composite GitHub Action for rendering ChordPro files in CI |
| `tree-sitter-chordpro` | `packages/tree-sitter-chordpro` | Tree-sitter grammar for ChordPro syntax highlighting |
| ChordPro (Zed extension) | `packages/zed-extension` | Zed editor extension with tree-sitter highlighting and LSP integration (not in workspace; targets wasm32-wasi) |
| ChordPro (JetBrains plugin) | `packages/jetbrains-plugin` | JetBrains IDE plugin with TextMate syntax highlighting for ChordPro files |

The repository also ships a static design-system reference under
`design-system/` at the repo root: `DESIGN.md` (rationale + token
reference), `tokens.css` (single source of truth for color /
typography / space / radius / elevation / motion), `index.html`
(visual landing page), `preview/` (10 component preview pages +
index), and `ui_kits/web/` (four product-surface demos: editor,
viewer, library, iReal Pro chart editor). These are static
HTML/CSS — no build step. Token decisions in
`design-system/tokens.css` are the authoritative reference for
`@chordsketch/react`, the playground, and the desktop app.

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
   (or the 10-iteration safety cap in `.claude/rules/pr-workflow.md` fires).
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

This project supports multiple Claude Code instances working simultaneously
via tmux. Worktrees are the isolation mechanism **when running concurrently**;
single-session work does not need a worktree by default.

**Key principle**: When more than one instance is active, each works in an
isolated git worktree. No shared mutable state across concurrent instances.

| Resource | Isolation Method (concurrent runs) |
|---|---|
| Git branch | One branch per worktree, named `issue-{N}-{slug}` |
| Build artifacts | Each worktree has its own `target/` directory |
| Network ports | `3000 + issue_number` |
| Working directory | `../chordsketch-wt/issue-{N}-{slug}/` |

**Default (single instance)**: branch from latest `origin/main` in the main
checkout — no worktree.
**Concurrent runs / autopilot batches**: create a worktree under
`../chordsketch-wt/issue-{N}-{slug}/`.
**After PR merge**: delete the local branch (and remove the worktree if one
was created).

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
