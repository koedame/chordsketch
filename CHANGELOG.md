# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `chordsketch-ireal` URL grammar coverage extended to the full
  iReal Pro chart format used by community charts:
  - `(altchord)` parens — substitution chords stack above the
    primary in the renderer (`Chord::alternate`).
  - `n` (No Chord) — `Bar::no_chord` flag drives the `N.C.`
    glyph in the renderer.
  - `Kcl` / `x` / `r` (repeat-previous-measure simile) —
    `Bar::repeat_previous` flag drives the percent-style 1-bar
    simile glyph (SMuFL U+E500).
  - `<text>` free-form captions (`<13 measure lead break>`,
    `<D.S. al 2nd ending>`) — preserved verbatim on
    `Bar::text_comment`. Anchored macro detection on `D.C.` /
    `D.S.` / `Fine` prefixes (start-of-comment, followed by
    space/dot/end) replaces a substring match that mis-fired
    on common English words like `refine` / `define`.
  - `irealbook://` 6-field URL shape
    (`Title=Composer=Style=Key=TimeSig=Music`) joins the
    canonical 7..=9-field `irealb://` shape. The 6-field path's
    numeric `TimeSig` is strictly validated and surfaces
    `ParseError::InvalidNumericField` on malformed input
    (sister-site parity with the 7-field BPM / Transpose
    validation per `.claude/rules/code-style.md` "Silent
    Fallback").
  - `S` (Segno), `Q` (Coda), `<D.C.>` / `<D.S.>` / `<Fine>`
    markers attach to the bar in which they appear (was
    previously queued for the next bar, leaking the marker
    onto the wrong bar in `,S,E-7|A7|`-style URL fragments).
- `JsonValue::Bool` variant — used by the `Bar::repeat_previous`
  and `Bar::no_chord` flags in the JSON debug serializer.
- `chordTypography` wasm export
  (`#[wasm_bindgen(js_name = chordTypography)]`) — exposes the
  same span layout the SVG renderer uses so React / Svelte /
  external consumers can drive consistent chord-name glyph
  layout without re-rendering the SVG.
- `chord_typography` URL-shorthand translation (`b`→♭, `^`→Δ,
  `h`→ø, `o`→°, `-`→−, `#`→♯) and two-or-more-alteration
  vertical stacking (`7♭9♯5` renders as `7♭9 / ♯5` via a
  `|`-separated payload the renderer reads as a stacked
  quality block).
- `convert::from_ireal` propagates the new AST fields into the
  ChordPro output: `no_chord` → `N.C.` text segment,
  `repeat_previous` → previous-chord replay (or `LossyDrop`
  warning when there is none), `text_comment` → parenthesised
  inline text, `chord.alternate` → parenthesised alternate
  chord after the primary.
- `.claude/rules/playground-is-a-sample.md` — establishes the
  rule that the playground at `packages/playground/` is a
  thin sample consumer of the chordsketch libraries; gaps in
  chart output are fixed in the libraries, not the playground.

### Changed

- iReal Pro playground (`packages/playground/`) rewritten as a
  minimal sample consumer:
  - Editable `irealb://` URL textarea on top, chart preview
    below; metadata form, bar inspector, Format / Insert /
    Export tool-groups and player-controls all removed.
  - Sample selector + Layout readout consolidated into the
    topnav header alongside the breadcrumb.
  - Three real samples (Autumn Leaves / Spain / Moon River)
    replace the previous editor-irealb mock data.
  - Chart layout: section markers centred above the left
    barline (raised when the bar also carries an ending
    bracket); ending brackets are 75 % cell width with both
    sides open; double-end glyph suppressed when followed by
    a double-start so section boundaries paint a single
    double barline; chord-line wrap continues across section
    boundaries (4-bars-per-row); root accidental lifted to
    cap-line superscript with daylight from the root letter;
    alternate chord rendered above the primary at ~50 %
    optical size in the inter-row whitespace.
  - Breadcrumb `Playground` is now a link on both the
    iRealPro and ChordPro sub-pages.
- `crates/render-ireal/src/lib.rs::write_header` SVG
  `font-family` attribute serialised with single-quoted inner
  font names (`'Source Serif 4', Georgia, serif`) instead of
  the inner `\"…\"` form that broke svg2pdf / resvg downstream.
- `crates/ireal/src/parser.rs::queue_ending` and
  `queue_symbol` set the field directly on `current_bar`
  (was queued for the NEXT bar via a pending field). Mirrors
  iReal Pro's convention where `N1` / `S` / `Q` /
  `<D.C.>` / `<D.S.>` / `<Fine>` label the bar that contains
  them. The pending-symbol-and-ending model produced phantom
  trailing bars at section ends and shifted markers off by
  one bar.

### Fixed

- `scripts/check-release-channels.py`: the `ghcr`, `docker-hub`,
  and `maven-central` probes returned `<error>` on every release in
  the rollup table, even though the underlying publishes succeeded.
  Three independent bugs:
  - **Docker Hub / GHCR**: the probe URLs prepended a `v` to the
    version (`tags/v0.4.0/`, `manifests/v0.4.0`), but `docker.yml`
    uses `metadata-action` with `pattern={{version}}` which strips
    the `v` and pushes images as `0.4.0`, `0.4`, `latest`. The
    probe URLs now match the bare semver.
  - **GHCR auth**: anonymous GET against the v2 manifest endpoint
    always returned 401 because the Docker Registry v2 protocol
    requires `Authorization: Bearer <token>` even for public
    packages. The probe now fetches a pull token from
    `https://ghcr.io/token?…&scope=repository:<repo>:pull` first.
    Token availability is itself the visibility check for public
    packages.
  - **GHCR Accept header**: the manifest endpoint returns 404
    unless the request advertises a manifest media type via
    `Accept`. Multi-arch images come back as either OCI
    image-index or Docker manifest-list, so the probe now sends
    both content types in the negotiation list.
  - **Maven Central**: `ci/release-channels.toml` declared the
    package as `io.github.koedame:chordsketch`, but the actual
    publish coordinates are `me.koeda:chordsketch` (reverse-DNS
    of the `koeda.me` domain registered on Sonatype Central
    Portal). The probe is also rebuilt to read the authoritative
    `repo1.maven.org/maven2/<group>/<artifact>/maven-metadata.xml`
    rather than `search.maven.org/solrsearch`, which was
    empirically not indexing this artifact at all. Sister
    references in `.github/workflows/kotlin.yml` deployment URL
    and `docs/releasing.md` Distribution Channels table are
    corrected. (#2418)

### Changed

- `scripts/macports-regen-cargo-crates.py --check`: when the tag
  auto-resolved from `packaging/macports/Portfile`'s `github.setup`
  line does not yet exist (release-cut PR window), gracefully fall
  back to comparing the `cargo.crates` block against
  `HEAD:Cargo.lock` with an advisory note on stderr instead of
  failing. Explicit `--from-ref REF` invocations still fail
  loudly when `REF` is missing — preserves user intent. The
  next normal CI run, after the tag is pushed, validates against
  the real tagged `Cargo.lock` per the original tag-relative
  invariant (ADR-0012). Removes the workaround that forced the
  v0.4.0 release-cut PR to revert its Portfile bump and ship a
  separate post-release Portfile refresh PR. (#2413)

## [0.4.0] - 2026-05-06

### Added

#### iReal Pro support (multi-format track, #2050)

- New crate `chordsketch-ireal` — iReal Pro AST + zero-dependency JSON
  debug serializer / parser foundation. (#2055)
- New crate `chordsketch-render-ireal` — iReal Pro chart SVG renderer
  with a 4-bars-per-line grid layout engine, superscript chord-name
  typography, repeat / final / double barlines, N-th-ending brackets,
  section-letter labels, and music-symbol glyphs. Segno / coda glyphs
  use real Bravura SMuFL outlines baked into `bravura.rs` as static SVG
  `<path>` data; `D.C.` / `D.S.` / `Fine` remain italic text because
  iReal Pro models them as text directives. (#2058, #2060, #2057, #2059,
  #2062, #2348 / ADR-0014)
- `chordsketch-render-ireal`: PNG rasterisation via `resvg` (#2064) and
  PDF conversion via `svg2pdf` (#2063).
- `chordsketch-ireal`: parse `irealb://` URLs into iReal AST (#2054)
  and serialize `IrealSong` back to `irealb://` (#2052).
- New crate `chordsketch-convert` — bidirectional ChordPro ↔ iReal Pro
  conversion. (#2051, #2053, #2061)
- CLI auto-detects ChordPro vs `irealb://` input. (#2335)
- CLI: `.irealb` (single song) and `.irealbook` (collection) file
  extensions are authoritative for iReal-pipeline dispatch
  (case-insensitive); the existing first-KiB content sniffer is
  retained as fallback for untyped files. (#2358)
- Desktop (Tauri): Open / Save dialogs surface a dedicated iReal Pro
  filter group, and `bundle.fileAssociations` registers `.irealb` /
  `.irealbook` as OS-level associations on macOS, Windows, and Linux.
  (#2358)
- `@chordsketch/ui-web`: routes `irealb://` input through
  `render_ireal_svg` to render a read-only iReal Pro chart preview
  alongside the ChordPro pipeline. (#2362)
- VS Code extension: registers `.irealb` / `.irealbook` as a new
  language id with TextMate grammar so iReal files highlight
  separately from ChordPro. (#2359)
- JetBrains plugin and Zed extension: register `.irealb` /
  `.irealbook` extensions for the same separate-language treatment.
  (#2360)

#### iReal Pro bar-grid editor (`@chordsketch/ui-irealb-editor`)

- New private workspace package — pluggable bar-grid GUI editor for
  iReal Pro charts that slots into `@chordsketch/ui-web`'s
  `MountOptions.createEditor` via the `EditorAdapter` contract.
  Scaffolded with header metadata editing (title / composer / style /
  key / time / tempo / transpose) plus a 4-bars-per-line read-only
  grid. (#2363)
- Bar popover for inline editing of chord, barline, ending, and
  music-symbol fields. (#2364)
- Structural section / bar add / remove / reorder operations with
  ChordPro round-trip stability. (#2365)
- Keyboard shortcuts for bar delete and reorder. (#2376)
- Roving-tabindex grid navigation, `role="grid"` / `role="row"` /
  `role="gridcell"` ARIA semantics, and a polite live region for
  structural-edit announcements. (#2368)
- Playground / `@chordsketch/ui-web`: runtime editor swap via
  `ChordSketchUiHandle.replaceEditor` driving a ChordPro / iRealb
  format toggle in the playground header. (#2366)
- Desktop (Tauri): Open / Save dispatch routes `.irealb` /
  `.irealbook` files to the grid editor, with a View → Edit as Grid
  / Edit as URL Text menu pair to switch between the bar-grid GUI
  and the raw URL textarea. (#2367)

#### Bindings (multi-format track, #2067)

- All bindings (WASM / NAPI / FFI, with FFI flowing to Python / Kotlin /
  Swift / Ruby) expose the iReal Pro surface in four phases: conversion
  APIs (Phase 1, #2339), `render_ireal_svg` (Phase 2a, #2340), AST parse
  / serialize (Phase 2b, #2341), and `render_ireal_png` /
  `render_ireal_pdf` (Phase 2c, #2342).

#### ChordPro parser

- `settings.strict` mode + missing-`{key}` warning for songs without
  an explicit key directive. (#2293)
- `keys.force-common` / `keys.flats` config + canonicalizer to drive
  enharmonic spelling. (#2301)
- Transposable `{chord: [X]}` / `{define: [X]}` directives — the chord
  inside the directive value now follows the song's transpose. (#2303)
- Charango instrument voicings added to the built-in chord-diagram
  database. (#2299)

#### Renderers

- `chordsketch-render-html`: body-only HTML export + new
  `render_html_css()` to surface the embedded stylesheet separately.
  (#2284)
- `chordsketch-render-html`: new `settings.wraplines` option for
  long-line wrapping behavior. (#2297)
- `chordsketch-render-pdf`: PDF `/Info` `/Title` is now populated from
  `{title}` for single-song renders, encoded as a UTF-16BE hex string.
  Multi-song renders deliberately omit `/Info` because chordsketch has
  no songbook abstraction. Mirrors upstream ChordPro R6.101.0. (#2399)

#### Desktop app

- Native menu filled out (About / Preferences / Window / Help). (#2283)
- File I/O keyboard shortcuts: `Cmd/Ctrl+O` / `Cmd/Ctrl+S` /
  `Cmd/Ctrl+Shift+S`. (#2307)
- Focus-toggle keyboard shortcuts: `Cmd/Ctrl+Shift+E` /
  `Cmd/Ctrl+Shift+P`. (#2314)
- Transpose keyboard shortcuts: `Cmd/Ctrl+Alt+ArrowUp` /
  `Cmd/Ctrl+Alt+ArrowDown`. (#2315)

#### Linux

- Standalone GNOME thumbnailer for `.cho` files (part of #861). (#2290)

### Changed

- All `@chordsketch/*` npm publishing is now maintainer-local rather
  than CI-driven; the corresponding `environment:` blocks were removed
  from the publish workflows. (#2275, ADR-0008)
- `release.yml` and `desktop-release.yml` now require
  `RELEASE_DISPATCH_TOKEN` (a fine-grained PAT, not `GITHUB_TOKEN`) on
  the `gh release create` step so the eight downstream `release:
  published` workflows fire automatically. (#2277, ADR-0009)

### Fixed

- `chordsketch-render-pdf`: ToC no longer emits adjacent duplicate
  entries. (#2295)
- VS Code extension: body-only render preview eliminates lyric baseline
  drift between editor and preview. (#2285)
- Desktop updater: rotated pubkey to one paired with a non-empty
  password and superseded ADR-0005 accordingly. (#2256, #2259, #2262,
  ADR-0007)
- Desktop release: per-arch `.app.tar.gz` naming and `desktop-v*`
  releases are no longer marked as the repo's `latest`. (#2278)
- `ui-web`: apply viewport flex chain to the mount root so the
  preview pane fills available height. (#2281)
- Playground / `ui-web`: drop double-wrapped HTML doc, ship favicon,
  add defensive iframe reload. (#2322)
- `@chordsketch/ui-web`: `mountChordSketchUi` now awaits
  `Renderers.init()` before invoking the editor factory, so factories
  may safely use wasm-backed helpers in their constructors.
  Playground gains a Playwright browser smoke
  (`packages/playground/tests-e2e/`) so the wasm-init race that
  motivated this fix cannot recur silently. (#2397)

## [0.3.0] - 2026-04-25

### Added

- `@chordsketch/react` — npm package scaffold (no components yet; the
  surface lands in #2041–#2045). Dual ESM + CJS build via tsup,
  React 18+ peer dependency, `@chordsketch/wasm` runtime dependency,
  stylesheet at `@chordsketch/react/styles.css`, `version()` as the
  only exported symbol. CI workflow `.github/workflows/react.yml`
  covers typecheck, vitest smoke, and a build-artefact integrity
  check. (#2040)
- `@chordsketch/react`: `<PdfExport>` button + `usePdfExport` hook.
  Lazy-loads `@chordsketch/wasm` on first call, caches the
  initialised module for subsequent calls, renders to PDF via
  `render_pdf` / `render_pdf_with_options`, and triggers a browser
  download. `<PdfExport>` sets `disabled` + `aria-busy` while the
  render is in flight and forwards `onExported` / `onError`
  callbacks alongside all standard `<button>` attributes. (#2041)
- `@chordsketch/react`: `<Transpose>` control + `useTranspose`
  hook. Accessible `−` / readout / `+` / reset UI with per-button
  `aria-label`s, an `<output aria-live="polite">` indicator, and
  `+` / `-` / `0` keyboard shortcuts while focus is inside.
  `useTranspose` returns `{ value, increment, decrement, reset,
  setValue }` with configurable `initial` / `min` / `max` bounds
  (default `-11`…`+11`); every setter clamps into range and
  `setValue` normalises `NaN` to `min` so direct binding to a
  numeric input is safe. Baseline styles under
  `@chordsketch/react/styles.css` use transparent backgrounds and
  `currentColor` so the control inherits the host theme. (#2044)
- `@chordsketch/react`: `<ChordSheet>` component + `useChordRender`
  hook. Renders ChordPro source to HTML (default) or plain text
  via `@chordsketch/wasm`. Memoises the render against
  `(source, format, transpose, config)` so re-renders without
  input changes do not re-parse. Errors (parse / WASM init /
  render) surface via an inline `role="alert"` fallback by
  default — pass `errorFallback={(err) => ...}` to customise or
  `errorFallback={null}` to hide entirely and keep the stale
  previous render visible. `aria-busy` is set on the wrapper
  during init and in-flight renders so assistive tech observes
  the loading state. (#2042)
- `@chordsketch/react`: `<ChordEditor>` component +
  `useDebounced` hook. Split-pane editor with a plain `<textarea>`
  (auto-correct / spell-check / auto-capitalise disabled so
  ChordPro tokens don't trigger browser corrections) and a
  debounced `<ChordSheet>` live preview on the right. Supports
  controlled (`value` + `onChange`) and uncontrolled
  (`defaultValue`) modes. Keyboard shortcuts
  `Ctrl+ArrowUp` / `Ctrl+ArrowDown` (`Cmd` on macOS) fire
  `onTransposeChange` with the next value clamped into
  `[minTranspose, maxTranspose]`, so consumers can bind the
  editor directly to `useTranspose()` for live transposition
  without leaving the textarea. `readOnly`, `previewFormat`,
  `config`, `errorFallback`, and `debounceMs` (default 250 ms;
  `0` flushes synchronously for tests) are all forwarded.
  `useDebounced(value, delay)` is exported standalone for
  hosts that want the debouncer without the editor shell. (#2043)
- `chordsketch-wasm` (`@chordsketch/wasm` npm package): new
  `chord_diagram_svg(chord, instrument)` export. Looks up the
  chord in the built-in voicing database (156 voicings: 60
  guitar / 36 ukulele / 60 piano) and returns inline SVG, or
  `null` when the database has no entry. Accepted
  `instrument` values: `"guitar"`, `"ukulele"` (alias
  `"uke"`), and `"piano"` (aliases `"keyboard"`, `"keys"`).
  Unknown instruments reject with a `JsError`. The underlying
  Rust `chord_diagram::render_svg` / `render_keyboard_svg`
  generators are unchanged; this change only widens the WASM
  public API. (#2045)
- `@chordsketch/react`: `<ChordDiagram>` component +
  `useChordDiagram` hook. Renders inline SVG chord diagrams
  for guitar / ukulele / piano via the new
  `chord_diagram_svg` WASM export. The SVG inherits
  `currentColor` so diagrams match the host theme without
  extra styling. `notFoundFallback` (default: inline
  `role="note"` with the chord name) covers chords outside
  the built-in database; `errorFallback` (default: inline
  `role="alert"`; pass `null` to hide) covers unsupported
  instruments or WASM init failures. (#2045)
- `chordsketch-napi` (`@chordsketch/node` npm package):
  `chordDiagramSvg(chord, instrument)` export. Sister of
  the WASM export added in #2164. Accepted `instrument`
  values + error semantics match the WASM binding;
  unknown instruments reject with a napi `Error`
  (`InvalidArg`). `crates/napi/index.d.ts` carries the new
  declaration. (#2167)
- `chordsketch-ffi` (UniFFI): `chord_diagram_svg(chord,
  instrument)` UDL function. Picked up automatically by the
  Python (`chordsketch.chord_diagram_svg`), Swift
  (`ChordSketch.chordDiagramSvg`), Kotlin
  (`uniffi.chordsketch.chordDiagramSvg`), and Ruby
  (`Chordsketch.chord_diagram_svg`) bindings. Unknown
  instrument errors via
  `ChordSketchError::InvalidConfig`. Five new unit tests
  exercise the happy path, unknown chord (returns `None`),
  unsupported instrument (errors), and the
  `uke` / `keyboard` aliases. (#2165)

### Changed

- **Breaking:** Renamed the core parser/AST crate from `chordsketch-core`
  to `chordsketch-chordpro` (and directory `crates/core/` →
  `crates/chordpro/`). Rust consumers must update dependency names
  and `use` paths (`chordsketch_core::` → `chordsketch_chordpro::`);
  public APIs are otherwise unchanged. Part of the v0.3.0 multi-format
  track (iReal Pro support). See the
  [v0.3.0 migration guide](docs/migration/v0.3.md) for the bulk-rename
  commands and per-binding impact matrix. (#2056, #2050, #2065)

## [0.2.2] - 2026-04-18

### Added

- Bundle `chordsketch-lsp` binary in platform-specific VS Code extension VSIXes (#1789)

### Changed

- Refactor render-html `{define}` arm to remove redundant block wrapper (#1804)
- VS Code extension: add L2-compliant README (#1808)
- VS Code extension: package.json keyword + README command table follow-ups (#1812)
- Document VS Code README PNG requirement (SVG rejected by `vsce package`) (#1813)
- Document Open VSX first-time setup procedure in releasing.md (#1801)
- Document 8-VSIX procedure and release-verify workflow in releasing.md (#1803)
- Document manual workflow dispatch in release checklist (#1785)
- Swift `Package.swift` bumped to v0.2.1 (#1783)
- CI: document fail-closed intent in matrix-publish workflows (#1818)

### Fixed

- CI: fix YAML parse error in post-release Flathub heredoc (#1782)
- CI: remove incorrect environment blocks from npm/napi publish workflows (#1791)
- CI(vscode): add `continue-on-error` to build-platform job (#1805)

### Security

- CI: audit release workflows for `inputs.tag` script-injection vectors (#1814)
- CI(npm-publish): validate `inputs.version` format before `npm version` (#1819)
- CI: route release workflow step outputs via env to prevent injection (#1820)
- CI(readme-smoke): adopt `set -euo pipefail` for fail-closed script behavior (#1807)

## [0.2.1] - 2026-04-16

### Added

- Publish `tree-sitter-chordpro` grammar to npm with CI workflow (#1745)
- Publish chordsketch to AUR (`yay -S chordsketch`) (#1609)
- Publish chordsketch to Snap Store (`sudo snap install chordsketch`) (#1613)
- Publish ChordSketch podspec to CocoaPods (#1614)
- Register chordsketch on Chocolatey (auto-publish on next release) (#1611)
- Add nixpkgs reference derivation with verified hashes (#1762)
- Submit nixpkgs PR (NixOS/nixpkgs#510263) (#1610)
- Add CLI `convert` subcommand integration tests (13 tests) (#1732)
- Add Chocolatey, AUR, Snap install sections to README (#1773)

### Fixed

- Replace hardcoded `/tmp` paths in CLI tests with `NamedTempFile` (#1736, #1739, #1741, #1743)
- Switch Snap base from core22 to core24 for glibc 2.39 compatibility (#1774)

### Changed

- Add missing crates and packages to README workspace tables (#1731)
- Document npm new-package publish procedure in releasing.md (#1748)
- Document AUR, Snap, CocoaPods first-time setup procedures (#1766)

## [0.2.0] - 2026-04-12

### Added

#### WASM / npm (`@chordsketch/wasm`)

- New crate `chordsketch-wasm` exposing the full parse-and-render API to
  JavaScript via `wasm-bindgen`
- npm package `@chordsketch/wasm` published to npmjs.com — dual package
  layout (browser ESM + Node.js CJS) so the same package works in both
  environments without configuration
- Render functions: `renderHtml`, `renderText`, `renderPdf`,
  `renderHtmlWithOptions`, `renderTextWithOptions`, `renderPdfWithOptions`,
  `validate`, `version`
- Render warnings (transpose saturation, chorus recall limits, etc.) routed
  to `console.warn` instead of being silently dropped
- Panic hook via `console_error_panic_hook` — unexpected panics now surface
  as readable messages in the browser console instead of opaque wasm traps

#### Web Playground

- Interactive browser playground deployed to GitHub Pages at
  `https://koedame.github.io/chordsketch/`
- Editor pane with live ChordPro input and three output modes: HTML preview,
  plain text, and PDF download
- Imports `@chordsketch/wasm` via npm for the rendering backend

#### Native Node.js addon (`chordsketch-napi`)

- New crate `chordsketch-napi` providing a native Node.js addon via napi-rs
- Same API surface as the WASM package but as a compiled `.node` binary —
  no WASM runtime overhead
- Transpose parameter accepts any integer (same as CLI and UniFFI bindings);
  values outside `i8` range are clamped before the renderer reduces modulo 12

#### Python (`chordsketch` on PyPI)

- Python package published to PyPI via maturin + UniFFI
- Supports CPython 3.8+ on Linux x86_64/aarch64, macOS aarch64, and
  Windows x86_64
- Uses PyPI Trusted Publishing (OIDC) — no long-lived API token

#### Swift (`ChordSketch` via Swift Package Manager)

- Swift package published via Swift Package Manager pointing to a pre-built
  XCFramework uploaded to each GitHub Release
- Supports macOS 12+, iOS 15+, with both arm64 and x86_64 slices
- Automated checksum update in `Package.swift` after each release via CI

#### Kotlin (`me.koeda:chordsketch` on Maven Central)

- Kotlin/JVM package published to Maven Central under the `me.koeda`
  namespace (reverse-DNS of `koeda.me`)
- Built via Gradle with the Vanniktech maven-publish plugin targeting the
  Sonatype Central Portal
- GPG-signed; sources jar included

#### Ruby (`chordsketch` on RubyGems)

- Ruby gem published to RubyGems.org via UniFFI
- Supports Linux x86_64/aarch64, macOS aarch64, and Windows x86_64
- Uses RubyGems Trusted Publishing (OIDC) — no long-lived API key

#### Docker images

- Multi-arch Docker images (linux/amd64, linux/arm64) published to:
  - `ghcr.io/koedame/chordsketch` (GitHub Container Registry)
  - `docker.io/koedame/chordsketch` (Docker Hub)
- Image tags: `latest` (most recent release), `X.Y.Z`, `X.Y`
- Based on Alpine 3 (release image) and Debian bookworm (build stage)

#### Package managers

- **Homebrew**: `brew tap koedame/tap && brew install chordsketch`
- **Scoop**: `scoop bucket add koedame https://github.com/koedame/scoop-bucket && scoop install chordsketch`
- **winget**: `winget install koedame.chordsketch` (pending Microsoft review)
- Homebrew formula and Scoop manifest auto-updated by CI on each release

### Changed

- `@chordsketch/wasm`: upgraded from broken single-target `0.1.0` (browser
  only, broken on Node.js) to dual-package `0.1.1+`; the Rust crate version
  (returned by `version()`) remains at `0.2.0`

### Fixed

- WASM render warnings were silently dropped via `eprintln!` in browser
  context; they now surface through `console.warn`
- napi binding previously rejected `transpose` values outside `[-12, 12]`
  while all other bindings (CLI, WASM, UniFFI) accept the full `i8` range;
  napi now matches the other bindings by clamping to `i8` range

## [0.1.0] - 2026-04-04

Initial release of ChordSketch.

### Added

#### Core Parser (`chordsketch-chordpro`)

- Full ChordPro file format parser with zero external dependencies
- 100+ directive types supported
- Structured AST representation of songs
- Chord transposition (by semitone count)
- Metadata extraction (`{title}`, `{subtitle}`, `{artist}`, `{key}`, `{meta}`, etc.)
- Section environments: verse, chorus, tab, grid, custom sections
- Chorus recall (`{chorus}`)
- Inline markup (bold, italic, superscript, subscript)
- Delegate environments (ABC, Lilypond, SVG, textblock)
- Conditional directive selectors (instrument, user)
- Multi-song file support (`{new_song}` / `{ns}`)
- Font, size, and color directives (legacy formatting)
- Image directive
- Chord definition and diagram directives (`{define}`, `{chord}`)
- Configuration file system with RRJSON support
- `{transpose}` directive
- Input size limits and parser safety controls

#### Text Renderer (`chordsketch-render-text`)

- Plain text output with chords above lyrics
- Unicode-aware column alignment
- Multi-column layout support
- Section label rendering

#### HTML Renderer (`chordsketch-render-html`)

- Self-contained HTML5 document output
- Chord positioning above lyrics
- Metadata display (title, subtitle, artist)
- Section styling

#### PDF Renderer (`chordsketch-render-pdf`)

- PDF document generation (A4, Helvetica)
- Multi-page layout with page breaks
- Chord diagrams rendering
- Multi-column layout
- Text clipping at column boundaries
- Image embedding
- Font size and color support

#### CLI (`chordsketch`)

- Three output formats: text, HTML, PDF
- Chord transposition via `--transpose`
- Configuration file loading via `--config`
- Runtime config overrides via `--define`
- Instrument selection via `--instrument`
- Multiple input file processing
- Optional default config suppression via `--no-default-configs`

### Security

- Input size limits to prevent memory exhaustion
- Path traversal protections for file operations
- No unsafe code in the core parser

### Compatibility

- Tested against the Perl ChordPro reference implementation
- See [docs/known-deviations.md](docs/known-deviations.md) for known differences

[Unreleased]: https://github.com/koedame/chordsketch/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/koedame/chordsketch/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/koedame/chordsketch/releases/tag/v0.1.0
