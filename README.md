<p align="center">
  <img src="https://raw.githubusercontent.com/koedame/chordsketch/main/assets/logo.svg" alt="ChordSketch" width="100" height="100">
</p>

# ChordSketch

[![codecov](https://codecov.io/gh/koedame/chordsketch/branch/main/graph/badge.svg)](https://codecov.io/gh/koedame/chordsketch)

A Rust implementation of the [ChordPro](https://www.chordpro.org/) and
[iReal Pro](https://www.irealpro.com/) chord chart formats. 100% ChordPro
compatible (parse to a structured AST, render to plain text, HTML, and
PDF), full `irealb://` URL parsing, iReal Pro chart rendering to SVG /
PNG / PDF, and bidirectional ChordPro ↔ iReal Pro conversion.

## Stability

ChordSketch is pre-1.0 and still in a validation phase. **Until `1.0.0`
ships, any release may break compatibility** — public API items, rendered
output, CLI flags, binding surfaces, and the minimum supported Rust
version can all change in a `0.x` bump, without a deprecation cycle.
Breaking changes are named in the [CHANGELOG](CHANGELOG.md), and larger
ones get a guide under [`docs/migration/`](docs/migration/). Pin an exact
version if you depend on this crate today. The full policy is in
[Versioning and release process](docs/releasing.md#pre-10-breaking-changes-are-expected).

## Features

### ChordPro

- Full [ChordPro](https://www.chordpro.org/chordpro/) format parser with
  zero external dependencies in the core crate
- Three output formats: plain text, HTML, and PDF
- Chord transposition
- Configuration file system (chordsketch.json)
- Inline markup (bold, italic, etc.)
- Chord diagrams (vertical or horizontal / left-nut orientation for
  Japanese tablature publishing) and extended `{define}` directives
- Section environments (verse, chorus, tab, grid, custom)
- Delegate environments (ABC, Lilypond, SVG, textblock)
- Conditional directive selectors (instrument, user)
- Multi-song files (`{new_song}`)
- Font, size, and color directives
- Image directive
- Multi-page PDF with page control

### iReal Pro

- Full `irealb://` URL parser (single-song and multi-song collections)
  with zero external dependencies in the core crate. Accepts both the
  canonical 7..=9-field `irealb://` shape and the iRealBook 6-field
  `irealbook://` shape (`Title=Composer=Style=Key=TimeSig=Music`).
- Complete URL grammar coverage: `(altchord)` substitutions, `n`
  no-chord, `Kcl` / `x` / `r` repeat-previous-measure, `<text>`
  free-form captions, `S` segno, `Q` coda, `<D.C.>` / `<D.S.>` /
  `<Fine>` macros, repeat / final / double / single barlines, and
  N-th endings — all attached to the bar in which the marker
  appears.
- Chart renderer producing SVG, PNG (via resvg), and PDF (via svg2pdf)
  — 4-bars-per-line grid layout that wraps continuously across
  section boundaries, repeat / final / double barlines, N-th-ending
  brackets, section-letter labels, and Bravura SMuFL music symbols
  (segno, coda). Chord-name typography translates URL-stored
  shorthand (`b`→♭, `^`→Δ, `h`→ø, `o`→°, `-`→−, `#`→♯) and stacks
  multi-alteration extensions (`7♭9♯5` → two-line `7♭9 / ♯5`).
  Available as a `chordTypography` wasm export so React / Svelte /
  external consumers can drive the same span layout.
- Bidirectional ChordPro ↔ iReal Pro conversion with structured
  warnings for lossy drops. The iReal → ChordPro bridge handles
  the new AST fields end-to-end (`no_chord` → `N.C.` segment,
  `staff_texts` → parenthesised inline text — plain captions
  verbatim, `<Nx>` repeat-count overrides as `(Nx)`, and `<*XY...>`
  vertical positions surfaced as `LossyDrop` warnings since
  ChordPro has no equivalent —, `chord.alternate` → parenthesised
  alternate after the primary).
- `.irealb` (single song) and `.irealbook` (multi-song collection) file
  extensions — picked up by the CLI sniff, the desktop OS file
  associations, and the editor integrations (VS Code, JetBrains, Zed)
- Bar-grid GUI editor (`@chordsketch/ui-irealb-editor`) with header
  metadata editing, per-bar popovers, and structural section / bar
  reordering

## Try it Online

**[ChordSketch Playground](https://koedame.github.io/chordsketch/)** — try
ChordPro and iReal Pro rendering directly in your browser, no installation
required. The format toggle in the header switches between the ChordPro
text editor and the iReal Pro bar-grid GUI editor at runtime.

The same engine embedded through each UI package, one editable page per
binding: [Vue](https://koedame.github.io/chordsketch/vue/) and
[Svelte](https://koedame.github.io/chordsketch/svelte/). The ChordPro
playground above is the `@chordsketch/react` surface
([ADR-0053](docs/adr/0053-framework-demos-live-in-the-playground.md)).

## Documentation

**[ChordSketch Docs](https://koedame.github.io/chordsketch/docs/)** —
embedding recipes for `@chordsketch/react`, per-component API
reference, and cross-binding render / transpose guides. The
canonical Markdown sources live under
[`docs/sdk/`](docs/sdk/README.md) and the docs site renders them
in-place (see [ADR-0021](docs/adr/0021-docs-site-co-located-with-playground.md)).

## Editor Integration

ChordSketch provides syntax highlighting and Language Server Protocol (LSP)
support for multiple editors:

- **VS Code / Cursor / Windsurf / VSCodium** — install the [ChordSketch extension](https://marketplace.visualstudio.com/items?itemName=koedame.chordsketch)
- **JetBrains IDEs** (IntelliJ IDEA, PyCharm, WebStorm, etc.) — install the ChordPro plugin
- **Zed** — install the ChordPro extension from the extensions panel
- **Neovim** — manual tree-sitter + LSP configuration
- **Helix** — manual grammar + LSP configuration

See [docs/editors.md](docs/editors.md) for detailed setup instructions.

## Installation

### npm (WASM)

```bash
npm install @chordsketch/wasm
```

See the [@chordsketch/wasm README](packages/npm/README.md) for usage with
JavaScript/TypeScript.

### Homebrew (macOS / Linux)

CLI (formula):

```bash
brew install --formula koedame/tap/chordsketch
```

[Desktop app](#desktop-application) (cask, macOS only):

```bash
brew install --cask koedame/tap/chordsketch
```

The cask installs `ChordSketch.app` into `/Applications/`; Homebrew
clears the Gatekeeper quarantine flag automatically on install.

Both commands name the tap in full so that Homebrew taps `koedame/tap`
on demand and trusts just that one formula or cask; Homebrew 6.0.0 and
later refuse to load anything from an untrusted third-party tap. The
tap ships the CLI and the desktop app under the same `chordsketch`
name, so `--formula` and `--cask` say which of the two to install;
without either flag Homebrew picks the formula and warns that the name
was ambiguous.

### MacPorts (macOS)

```bash
sudo port install chordsketch
```

### Scoop (Windows)

```bash
scoop bucket add koedame https://github.com/koedame/scoop-bucket
scoop install chordsketch
```

### winget (Windows)

```bash
winget install koedame.chordsketch
```

### Chocolatey (Windows)

```bash
choco install chordsketch
```

### Snap (Linux)

```bash
sudo snap install chordsketch
```

### AUR (Arch Linux)

```bash
yay -S chordsketch
```

### Docker

```bash
docker run --rm ghcr.io/koedame/chordsketch --version
docker run --rm -v "$PWD:/data" ghcr.io/koedame/chordsketch /data/song.cho
```

### From crates.io

```bash
cargo install chordsketch
```

### From source

Requires Rust 1.88 or later.

```bash
git clone https://github.com/koedame/chordsketch.git
cd chordsketch
cargo install --path crates/cli
```

## Desktop application

ChordSketch also ships a native desktop editor (Tauri v2) with
live ChordPro preview, syntax highlighting, transpose, file
open/save, and PDF / HTML export. Install via the Homebrew cask
under `### Homebrew (macOS / Linux)` above.

If you instead download the `.dmg` directly from a GitHub
Release (bypassing Homebrew), macOS Gatekeeper will block the
unsigned bundle on first open. Clear the flag manually:

```bash
xattr -dr com.apple.quarantine /Applications/ChordSketch.app
```

Apple Developer ID signing + notarization (so the flag is not
needed regardless of install path) is tracked in
[#2075](https://github.com/koedame/chordsketch/issues/2075).

### Linux requirements

All three bundles need **glibc 2.35 or newer**. Where they differ is
webkit2gtk 4.1.

The `.deb` and the `.rpm` take it from the distribution, so they
install only where the distribution packages it: Ubuntu 22.04 and later
and Debian 12 and later (`libwebkit2gtk-4.1-0`), Fedora
(`webkit2gtk4.1`), and RHEL 10 / Rocky 10 / AlmaLinux 10 with EPEL
enabled (`webkit2gtk4.1`). Debian 11 and RHEL 8 / 9 — Rocky and
AlmaLinux included, with or without EPEL — package webkit2gtk 4.0 only,
so neither bundle can be installed there at any glibc version. In
practice the `.rpm` is a Fedora channel that also serves RHEL 10.

The `.AppImage` carries its own webkit2gtk 4.1 and asks the
distribution for nothing, but the glibc floor still applies: it runs on
RHEL 10 (glibc 2.39) and not on RHEL 8 (2.28) or RHEL 9 (2.34). RHEL 8
and 9 therefore have no desktop bundle in any format. The CLI is the
option there — it has no such constraint, running on glibc 2.18+ with
no system dependencies
([ADR-0056](https://github.com/koedame/chordsketch/blob/main/docs/adr/0056-desktop-bundles-target-ubuntu-2204.md),
[ADR-0057](https://github.com/koedame/chordsketch/blob/main/docs/adr/0057-desktop-rpm-stays-a-webkit2gtk-41-channel.md)).

## Usage

```bash
# Render a ChordPro file to plain text (default)
chordsketch song.cho

# Render a ChordPro file to HTML
chordsketch -f html song.cho -o song.html

# Render a ChordPro file to PDF
chordsketch -f pdf song.cho -o song.pdf

# Transpose up 2 semitones
chordsketch --transpose 2 song.cho

# Use a custom config file
chordsketch -c myconfig.json song.cho

# Process multiple ChordPro files
chordsketch -f pdf song1.cho song2.cho -o songbook.pdf

# Render an iReal Pro chart from a URL (always emits SVG)
chordsketch 'irealb://%54=…'

# Render an iReal Pro chart from an .irealb file (single song)
chordsketch song.irealb

# Render an iReal Pro chart from an .irealbook file (multi-song collection)
chordsketch songs.irealbook
```

## Library Usage

The core parsers and renderers are available as separate library crates,
one set per format. ChordPro:

```rust
use chordsketch_chordpro::parser::parse;
use chordsketch_render_text::render_song;

let input = "{title: Amazing Grace}\n{subtitle: Traditional}\n\n[G]Amazing [G7]grace, how [C]sweet the [G]sound";
let song = parse(input).unwrap();
let text = render_song(&song);
println!("{text}");
```

iReal Pro:

```rust
use chordsketch_ireal::parse as parse_ireal;
use chordsketch_render_ireal::{render_svg, RenderOptions};

let url = "irealb://%54=%66==%41%66%72%6F=%43==%31%72%33%34%4C%62%4B%63%75%37,%37%47,%2D%20%3E%43,%44,%37%42,%2D%23%46,%47%7C,%37%44,%41%2D,%45,%2D%45%7C,%37%42,%2D%23%46,%45%2D,%7C%44%3C%34%33%54%7C%43,%44%2D%37,%7C%46,%47%37,%43%20%7C%20==%31%34%30=%33";
let song = parse_ireal(url).expect("valid irealb URL");
let svg = render_svg(&song, &RenderOptions::default());
println!("{svg}");
```

## Workspace Structure

| Crate | Description |
|---|---|
| [`chordsketch-chordpro`](crates/chordpro) | ChordPro parser, AST, and transforms (zero external dependencies) |
| [`chordsketch-render-text`](crates/render-text) | ChordPro plain text renderer |
| [`chordsketch-render-html`](crates/render-html) | ChordPro HTML renderer |
| [`chordsketch-render-pdf`](crates/render-pdf) | ChordPro PDF renderer |
| [`chordsketch-ireal`](crates/ireal) | iReal Pro AST and `irealb://` URL parser / serializer (zero external dependencies) |
| [`chordsketch-render-ireal`](crates/render-ireal) | iReal Pro chart renderer (SVG / PNG / PDF) |
| [`chordsketch-convert`](crates/convert) | Bidirectional ChordPro ↔ iReal Pro converter |
| [`chordsketch-convert-musicxml`](crates/convert-musicxml) | MusicXML ↔ ChordPro bidirectional converter |
| [`chordsketch-wasm`](crates/wasm) | WebAssembly bindings via wasm-bindgen |
| [`chordsketch-ffi`](crates/ffi) | UniFFI bindings for Python, Ruby, Swift, and Kotlin |
| [`chordsketch-napi`](crates/napi) | Native Node.js addon via napi-rs |
| [`chordsketch`](crates/cli) | Command-line tool |
| [`chordsketch-lsp`](crates/lsp) | Language Server Protocol server |

### Packages

| Package | Path | Description |
|---|---|---|
| [`@chordsketch/wasm`](packages/npm) | `packages/npm` | npm WASM package with TypeScript types |
| [`@chordsketch/node`](crates/napi) | `crates/napi` | Native Node.js addon (prebuilt binaries, no Rust required) |
| [`@chordsketch/ui-irealb-editor`](packages/ui-irealb-editor) | `packages/ui-irealb-editor` | **Internal.** Bar-grid GUI editor for iReal Pro charts; co-designed with the playground. External integrators should use `@chordsketch/react`'s `<IrealBarGrid>` / `<IrealProEditor>` instead. |
| [`@chordsketch/react`](packages/react) | `packages/react` | React component library — embeds ChordPro **and** iReal Pro editors + previews in a few lines of React. |
| [`@chordsketch/vue`](packages/vue) | `packages/vue` | Vue 3 component library — the same ChordPro preview, editor, chord diagrams, transpose control and PDF export, as Composition-API components. |
| [`@chordsketch/svelte`](packages/svelte) | `packages/svelte` | Svelte 5 component library — the same ChordPro preview, editor, chord diagrams, transpose control and PDF export, as runes-based components. |
| [`@chordsketch/react-ui`](packages/react-ui) | `packages/react-ui` | Wasm-free React design-system primitives (buttons, cards, badges, form controls) for building app chrome around the editor. |
| [`@chordsketch/wasm-export`](packages/npm-export) | `packages/npm-export` | npm WASM package with the PDF / PNG export surface; loaded on demand by the export components. |
| [Python `chordsketch`](crates/ffi) | `crates/ffi` | Python package via UniFFI + maturin |
| [Swift `ChordSketch`](packages/swift) | `packages/swift` | Swift package with XCFramework |
| [Kotlin `chordsketch`](packages/kotlin) | `packages/kotlin` | Kotlin/JVM package via JNI |
| [Ruby `chordsketch`](packages/ruby) | `packages/ruby` | Ruby gem via UniFFI |
| [VS Code extension](packages/vscode-extension) | `packages/vscode-extension` | Syntax highlighting, live preview, and LSP integration |
| [JetBrains plugin](packages/jetbrains-plugin) | `packages/jetbrains-plugin` | TextMate syntax highlighting for JetBrains IDEs |
| [Zed extension](packages/zed-extension) | `packages/zed-extension` | Tree-sitter highlighting and LSP for Zed |
| [`tree-sitter-chordpro`](packages/tree-sitter-chordpro) | `packages/tree-sitter-chordpro` | Tree-sitter grammar for ChordPro |
| [GitHub Action](packages/github-action) | `packages/github-action` | Composite action for rendering ChordPro in CI |
| [Playground](packages/playground) | `packages/playground` | Browser-based ChordPro and iReal Pro editor and renderer |

## GitHub Actions

Use the composite action to render ChordPro files in any GitHub Actions
workflow — no Rust toolchain required:

```yaml
- uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6

- uses: koedame/chordsketch/packages/github-action@action-v1
  id: render
  with:
    input: songs/setlist.cho
    output: dist/setlist.html
    format: html

- uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4
  with:
    name: setlist-html
    path: ${{ steps.render.outputs.output-path }}
```

See [docs/github-action.md](docs/github-action.md) for full input/output
reference and additional examples.

## Migration Guides

- [v0.3.0 — `chordsketch-core` → `chordsketch-chordpro` rename](docs/migration/v0.3.md)

## Links

- [ChordPro file format specification](https://www.chordpro.org/chordpro/)
- [Unified SDK guide (all bindings, task-oriented)](docs/sdk/README.md)
- [Editor integration guide](docs/editors.md)
- [Configuration guide](docs/configuration.md)
- [Versioning and release process](docs/releasing.md)
- [GitHub Action reference](docs/github-action.md)
- [Architecture decision records](docs/adr/README.md)
- [SECURITY.md](SECURITY.md)
- [TRADEMARK.md](TRADEMARK.md)
- [CHANGELOG.md](CHANGELOG.md)

## License

SDK crates (core, renderers, CLI): [MIT](LICENSE)

Future application layer (Forum, Playground, Desktop): AGPL-3.0-only

## Trademark

The licences above cover the code, not the name. Describing, packaging, and
building on ChordSketch never needs permission; naming your own product
ChordSketch does. Forks are welcome and must rename — see
[TRADEMARK.md](TRADEMARK.md).
