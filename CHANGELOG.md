# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Horizontal (left-nut) orientation for fretted-instrument chord
  diagrams, alongside the existing vertical layout. Enable via the
  `diagrams.orientation = "horizontal"` config key (honoured by the
  Rust HTML and PDF renderers) or by passing
  `orientation="horizontal"` to `@chordsketch/react`'s
  `<ChordDiagram>` and `chordpro-jsx` walker option. Wasm / NAPI / FFI
  binding surfaces expose the new
  `chord_diagram_svg_with_orientation` and
  `chord_diagram_svg_with_defines_orientation` exports for hosts that
  need orientation control without going through the renderer config.
  Horizontal mode is reader-view only (high pitch on top, matching
  tablature stave order — see
  [ADR-0026](docs/adr/0026-horizontal-chord-diagram-default-string-order.md));
  the player-view layout is not exposed as a knob. ASCII output
  (`render_ascii`) and keyboard diagrams have no orientation knob —
  ASCII is a single line and the keyboard layout is already
  horizontal by nature. (#2572)

### Changed

- **Breaking**: `{capo: N}` now transposes the rendered chord names
  by `-N` semitones across every rendering surface (text / HTML /
  PDF Rust renderers and the `@chordsketch/react` `chordpro-jsx`
  walker), matching what a guitarist expects when reaching for the
  capo control. The `{capo}` directive itself stays in the AST and
  each renderer's existing capo-annotation behaviour is unchanged.
  Composes with `{transpose}` and the CLI / API transpose offset
  via a new `effective_transpose(file, cli, capo)` helper in
  `chordsketch_chordpro::transpose`; renderers route through this
  helper so the rule lives in one place. See
  [ADR-0023](docs/adr/0023-capo-transposes-displayed-chords.md).
  Consumers that depended on the old "capo is a printed annotation
  only" behaviour will see chord-line output shift; strip the
  `{capo}` directive before rendering, or pass `cli_transpose +
  capo` explicitly, to recover the pre-change output. (#2560)
- `@chordsketch/react`: `<Capo>` and `<Transpose>` switch from
  `− / + / Reset` buttons to a native `<input type="range">`
  slider with a current-value readout. Keyboard support now comes
  from the native range input (arrow keys, Home / End, PageUp /
  PageDown); the legacy `+ / = / − / _ / 0` wrapper-level
  shortcuts are removed. `<Capo>` accepts a new `bestPositions`
  prop that paints ★ markers at the "easiest capo position" tied
  set — pair with the new `computeBestCapoPositions` helper.
  `<Transpose>`'s default UI range narrows to `±6` (down from
  `±11`); the feature ceiling `TRANSPOSE_MIN` / `TRANSPOSE_MAX`
  remains `±11` and hosts can pass explicit `min` / `max` to
  widen the slider. **Breaking**: the `resetValue` prop is
  removed from both `<Capo>` and `<Transpose>` — there is no
  longer a Reset button, and the native slider's Home key (or a
  controlled `onChange(0)` from the host) covers the same
  ergonomics. (#2560)
- `@chordsketch/react`: the `<Capo>` slider's host-supplied
  `value` (controlled mode) and the source-derived `{capo: N}`
  (source-pair mode) are now clamped into `[min, max]` at render
  time as well as at change time, so a host that passes
  `value=10` with default `max=12` sees the slider thumb and the
  `<output>` readout agree on the displayed value. Same change
  applied to `<Transpose>`. (#2560)
- `@chordsketch/react`: `<Capo>`'s `aria-describedby` id is now
  generated via React 18's `useId()` instead of `Math.random()`,
  so server-rendered hosts (Next.js, Remix) no longer hit
  hydration mismatches when the ★ markers are visible. (#2560)
- `chordsketch_chordpro::render_result::validate_capo` warning
  messages now end with `(rendered as no capo)` so a user who
  writes an out-of-range or non-integer `{capo}` value learns
  both what was wrong with their input and what the rendered
  output represents. (#2560)
- `chordsketch-wasm`'s `do_parse_chordpro` (the React preview's
  parse entry point) now calls `validate_capo` so invalid
  `{capo}` values surface the same warning the Rust renderers
  emit, closing the validation-parity gap between the React
  surface and the static-output renderers. (#2560)

### Added

- `@chordsketch/react`: new `computeBestCapoPositions(ast)` helper
  (and the matching `BEST_CAPO_MAX` constant /
  `BestCapoResult` type) — computes the capo positions tied for
  the lowest accidental-glyph count from a parsed song, driving
  `<Capo>`'s ★ slider markers. Mirrors the canonical-spelling
  pipeline from `chordsketch_chordpro::transpose::canonical_key_spelling`
  on the React side so no extra wasm function is needed. (#2560)
- `chordsketch_chordpro::transpose::effective_transpose(file, cli,
  capo)` — single-source helper that composes the file-level
  `{transpose}` value, the CLI / API transpose offset, and the
  song's `{capo}` value into the chord-line shift the four
  rendering surfaces apply. Wired into each Rust renderer in place
  of the previous `combine_transpose` call. (#2560)
- New [ADR-0023](docs/adr/0023-capo-transposes-displayed-chords.md)
  records the `{capo}` semantic change and the
  `effective_transpose` helper's place in the pipeline. (#2560)
- `@chordsketch/react`: new `<PreviewToolbar>` performance-toolbar
  component composing `<Transpose>` + `<Capo>` + `<PdfExport>`,
  plus the new `<Capo>` primitive (mirrors the `<Transpose>` API
  with an additional source-pair shape that round-trips through
  `{capo: N}` via the new `readCapo` / `setCapoInSource` helpers).
  `<ChordProPreview>` gains a `toolbar` prop
  (`"transpose-only"` (default, backwards-compatible) /
  `"performance"` / `false` / custom `ReactNode`) — opt into
  `"performance"` to surface the new toolbar without composing
  primitives by hand. (#2545)
- `@chordsketch/react`: exported `CAPO_MIN`, `CAPO_MAX`,
  `TRANSPOSE_MIN`, `TRANSPOSE_MAX` constants alongside the existing
  drag-to-reposition helpers in `chord-source-edit.ts`. (#2545)
- `@chordsketch/react`: exported `PDF_EXPORT_DEFAULT_LABEL`
  (`"Export PDF"`) — the single source of truth for the
  `<PdfExport>` button's default `children` and the
  `<PreviewToolbar>` Export group's button label. Downstream
  consumers building their own export UI can import the constant
  to stay in lockstep with the library's default. (#2558)
- `@chordsketch/react`: `<PreviewToolbar>` now accepts an
  `@internal` `wasmLoader` prop forwarded to the inner
  `<PdfExport>` so tests can drive the Export-group click path
  with a stubbed renderer. Production consumers do not supply
  this; the default dynamic import of `@chordsketch/wasm-export`
  resolves at click time as before. (#2558)
- VS Code extension: preview WebView now uses `<ChordProPreview
  toolbar="performance">` so the Capo and Export PDF controls
  reach feature parity with the playground. Capo edits round-trip
  through a new `edit-capo` host message that applies a
  `WorkspaceEdit` against the live `TextDocument`. (#2545)
- `@chordsketch/react` v0.3.0: new `<ChordProPreview>` Tier 2
  component — a preview pane with format toggle and transpose
  controls but no source editor. Drop-in for hosts that own the
  source (e.g. the VS Code WebView). (#2527, #2533)
- New [ADR-0022](docs/adr/0022-react-as-canonical-preview-surface.md)
  records the consolidation decision —
  `@chordsketch/react` becomes the canonical preview surface and
  `@chordsketch/ui-web` is retired. [ADR-0017](docs/adr/0017-react-renders-from-ast.md)'s
  "non-React consumers" list updated accordingly. (#2527)

### Changed

- `@chordsketch/react`: PDF export button label unified to
  `"Export PDF"` across `<RendererPreview>` (PDF branch) and
  `<PreviewToolbar>` to match `<PdfExport>`'s own default and the
  desktop app's `File → Export PDF…` menu. The default is now a
  single exported source of truth, `PDF_EXPORT_DEFAULT_LABEL`, which
  `<PdfExport>` uses as its `children` default and which
  `<PreviewToolbar>` consumes for its Export-group button so both
  call sites stay in lockstep with any future relabel. Tests and
  documentation examples updated; behaviour for direct `<PdfExport>`
  consumers is unchanged (the default value is the same string). (#2558)
- VS Code extension: command titles renamed from `ChordSketch: …`
  to `ChordPro: …` (Open Preview / Open Preview to the Side /
  Transpose Up / Transpose Down / Export As…) so the commands
  group with other file-format actions in the Command Palette
  search. Command IDs (`chordsketch.*`) and keybindings are
  unchanged. (#2544)
- Playground (`packages/playground`): preview pane now consumes
  the new `<PreviewToolbar>` from `@chordsketch/react` instead of
  the hand-rolled `pane-toolbar` block. The inline `readCapo` /
  `setCapoInSource` helpers and the `CAPO_*` / `TRANSPOSE_*`
  constants moved into the React package per
  [playground-is-a-sample.md](.claude/rules/playground-is-a-sample.md).
  (#2545)
- **Breaking — `@chordsketch/react` v0.3.0 component renames** (no
  deprecated aliases; external consumers must update imports at the
  v0.3.0 boundary):
  - `<Playground>` → `<ChordProEditor>`
  - `<IrealPlayground>` → `<IrealProEditor>`
  - `<ChordEditor>` → `<ChordTextarea>`
  - `<SourceEditor>` → `<ChordSourceArea>`
  - `<IrealEditor>` → `<IrealBarGrid>`

  The `Editor` suffix is now reserved for Tier 3 composed editors
  (`<ChordProEditor>`, `<IrealProEditor>`); Tier 1 atoms use
  widget-type names. The internal helper symbol `IrealBarGrid` was
  renamed to `IrealBarGridLayout` to free the public name. CSS
  classes mirror the new names (e.g. `chordsketch-playground*` →
  `chordsketch-chord-pro-editor*`). See
  [ADR-0022](docs/adr/0022-react-as-canonical-preview-surface.md)
  for the rationale. (#2533)
- **Breaking — `<ChordTextarea>` `minTranspose` / `maxTranspose`
  props renamed to `transposeMin` / `transposeMax`** to match the
  `<ChordProPreview>` prop names and the `<Transpose>` primitive's
  `min` / `max` props. No deprecated aliases. (#2534)
- **Breaking — `<IrealPreview>` `errorFallback` type narrowed**: the
  prop now accepts `((error: Error) => ReactNode) | null` only — the
  bare `ReactNode` branch was removed to make the type symmetric with
  `<ChordSheet>`, `<ChordProPreview>`, and `<ChordTextarea>`. Callers
  who passed a static `ReactNode` should wrap it: `() => node`.
  (#2534)
- VS Code preview WebView: rewritten as a React app mounting
  `<ChordProPreview>` from `@chordsketch/react`. The bespoke
  iframe-srcdoc implementation is gone. The WebView bundle grew
  +438 KB raw / +96 KB gzipped (one-time install cost; measured
  via `npm run build` in `packages/vscode-extension` against the
  pre-#2528 and post-#2528 esbuild outputs, gzipped via
  `gzip -9 -k`). (#2528)
- Tauri desktop: migrated off the deleted `mountChordSketchUi` flow
  to a React root. The shell composes Tier 1 / Tier 2 components
  for app-specific layout: a local `<ChordProDesktopEditor>`
  (CodeMirror 6 + `tree-sitter-chordpro`) plus `<ChordProPreview>`
  for ChordPro mode, and a local `<IrealGridEditor>` plus
  `<IrealPreview>` for iReal Pro mode. Tauri menus / Open-Save
  dialogs / updater events now route through a new `desktopBridge`
  singleton. (#2529)
- Playground page: `SAMPLE_CHORDPRO` / `SAMPLE_IREALB` moved to
  `packages/playground/src/sample.ts` and re-used by the Tauri
  desktop via a Vite alias. The page composes Tier 1 atoms
  directly (`<RendererPreview>`, `<Transpose>`, ...) into its own
  layout rather than mounting the all-in-one Tier 3 component, so
  the playground keeps full control of its chrome and routing.
  All component symbol references updated to v0.3.0 names.
  (#2530)

### Removed

- **Breaking** — `chordsketch.preview.defaultMode` VS Code setting
  removed; the preview pane is HTML-only. The Format `<select>` in
  the preview toolbar is hidden. Users who had explicitly set the
  setting will see an "unknown configuration" warning that can be
  cleared by deleting the key from `settings.json`. (#2535)
- **Breaking** — `@chordsketch/ui-web` private workspace package
  deleted entirely. It was a private package (never published to
  npm); external consumers should use `@chordsketch/react`
  directly per
  [ADR-0022](docs/adr/0022-react-as-canonical-preview-surface.md).
  (#2527, #2532)
- `packages/vscode-extension/webview/preview.ts` (the bespoke
  487-line WebView script) replaced by `webview/preview.tsx` (a
  319-line React entry).
- `apps/desktop/src/codemirror-editor.ts` lifted into
  `apps/desktop/src/ChordProDesktopEditor.tsx` (a React wrapper
  that preserves the tree-sitter-chordpro integration).
- `.github/workflows/ui-web.yml` removed (the package it tested no
  longer exists).

### Fixed

- **Inline `{key}` directive now follows the active transpose
  offset across all three Rust renderers, preserving modal
  qualifiers, extensions, and slash-bass notes (#2522).** Before
  this fix, `chordsketch --transpose=2` against a song authored
  `{key: G}` emitted `[Key: G]` (text) /
  `<span class="meta-inline__value">G</span>` (HTML) /
  `Key: G` (PDF) alongside chord lines transposed to A — the
  authored key leaked through unchanged.

  All three renderers now route through a new
  `chordsketch_chordpro::transpose::canonical_transposed_key_with_style(value, semitones, prefer_flat)`
  helper that:

  - **Uses the same `prefer_flat` as the chord lines** (derived
    via `transposed_key_prefers_flat(&song.metadata, transpose_offset)`),
    so a multi-`{key:}` song where the last anchor lands sharp
    side renders `[Key: G♯]` next to `G#` chord lines instead of
    the previously-divergent `[Key: A♭]` next to `G#`. Closes
    the §"Validation Parity" gap surfaced by the silent-failure
    audit of #2522.
  - **Preserves the modal qualifier** — `{key: C dorian}` ↦
    `[Key: D dorian]` at +2 (the trailing text "dorian" is not a
    transposable theory token; preserved verbatim from the
    parsed `ChordDetail::extension`). Sister cases:
    `{key: G mixolydian}`, `{key: A lydian}`, etc.
  - **Preserves spelled-out `minor`** — `{key: Bb minor}` ↦
    `[Key: C minor]` at +2 (the leading space prevents the
    chord parser's `min` prefix match, so "minor" lands in
    `ChordDetail::extension` and round-trips verbatim).
  - **Preserves extensions** — `{key: G7}` ↦ `[Key: A7]` at +2;
    `{key: Gmaj7}` ↦ `[Key: Amaj7]`; `{key: Gsus4}` ↦
    `[Key: Asus4]`.
  - **Transposes slash-bass** — `{key: G/B}` ↦ `[Key: A/C♯]` at
    +2 (the bass note transposes in lockstep with the root via
    `transpose_detail_with_style`).
  - **Compact-form minor** — `{key: Em}` ↦ `[Key: G♭m]` at +2
    (uses `ChordQuality::Minor`; emits `m` after the
    transposed-and-respelled accidental).
  - **Unparseable values** (e.g. a string that doesn't start
    with a note letter at all — `{key: Hidden}`) fall through
    to the authored text rather than producing nonsense.

  The React JSX walker
  (`packages/react/src/chordpro-jsx.tsx:3199-3234`) already
  emits an "Original → Playing" key-pair when the primary
  `{key}` differs from the host-supplied `transposedKey`, so
  the primary-key case is already correct over there. Mid-song
  `{key}` changes in the walker still fall through to the
  authored single chip per the walker's documented limitation
  (the host's `transposedKey` only carries the primary key's
  transposition) — a cross-surface parity gap with the Rust
  renderers' new behaviour is tracked as a follow-up.

  The v0.5.0 binaries shipped with this regression; it surfaced
  as `Test action (*)` failures across every PR after the
  v0.5.0 tag was pushed, because the github-action smoke does
  `grep -qw 'G'` on the transposed output to verify the chord
  lines actually transposed — and was catching the untransposed
  `[Key: G]` header.

## [0.5.0] - 2026-05-20

### Added

- **Documentation site at `chordsketch.koeda.me/docs/` (#2506,
  closes §4 of #2473; per-page static deploy landed in #2514).**
  Embedding recipes, per-component API reference for
  `@chordsketch/react`, and cross-binding render / transpose guides
  — co-located with the existing playground as a fourth Vite
  multi-page entry per
  [ADR-0021](docs/adr/0021-docs-site-co-located-with-playground.md).
  Canonical Markdown lives under `docs/sdk/`;
  `packages/playground/scripts/build-docs-static.mjs` renders it via
  `marked` + JSDOM + DOMPurify at build time and emits one
  `dist/docs/<slug>/index.html` file per registered page. Pages are
  served as plain static HTML at clean URLs like
  `/chordsketch/docs/embed-react/`; legacy `#/<slug>` hash URLs
  redirect via a small inline shim. Builds and deploys via the
  existing `deploy-playground.yml` workflow (now triggered by
  `docs/sdk/**` edits); covered by `playground-smoke.yml` Playwright
  assertions on every PR. Root README, `packages/react/README`, and
  the playground header bars cross-link to the docs URL.

### Fixed

- **Playground and VS Code extension preview no longer go blank
  on ChordPro / iRealb format toggle (#2422).** Chromium retains
  the previous DOM between `iframe.srcdoc` updates when only the
  inline doctype changes, surfacing as a blank preview pane after
  toggling between ChordPro and iRealb formats. The `srcdoc` value
  now gets a hidden cache-bust comment derived from a monotonically-
  incrementing counter so each format swap forces a fresh document
  navigation. Affects `@chordsketch/ui-web`'s host preview (lines
  ~936-940, 989) and `packages/vscode-extension/src/preview.ts:567-571`
  — both surfaces still render through an iframe per
  [ADR-0017](docs/adr/0017-react-renders-from-ast.md) (the React
  package's `<RendererPreview>` migrated off iframes in #2475, but
  the VS Code extension and the ui-web host still iframe the static
  HTML output).
- **`chordsketch-ireal` parser now accepts the spec's `n`
  absent-header sentinel in the open-protocol `irealbook://`
  TimeSig field (#2423).** The 6-field shape's worked example "A
  Walkin Thing" (per
  <https://www.irealpro.com/ireal-pro-custom-chord-chart-protocol>)
  encodes its key + meter as `=D-=n=` and carries the actual
  meter on an inline `T44` directive at the head of the music
  body. Previously, the strict-numeric parse arm added in #2424
  rejected the literal example with
  `InvalidNumericField("n")`. The parser now treats `n` as a
  documented "no header time signature; rely on the inline
  `T..` directive" marker and defers to the music body for the
  actual meter (falling back to the spec default 4/4 when the
  body declares no inline `T..` either). Other non-numeric
  TimeSig values still surface as `InvalidNumericField` to
  preserve sister-site parity with the 7-field path's strict
  numeric validation. New round-trip golden fixture at
  `crates/ireal/tests/fixtures/parser_open_protocol/a_walkin_thing/`
  drives the spec example through `parse` →
  `serialize_open_protocol` → `parse` and asserts AST equality,
  closing the umbrella's last load-bearing acceptance criterion.

### Added

- **`@chordsketch/react@0.2.0` — iReal Pro surface reaches
  `@chordsketch/ui-irealb-editor` parity ([#2505](https://github.com/koedame/chordsketch/issues/2505)).**
  Three slices land in the v0.2.0 release window:
  - **Foundation hooks + AST-helper parity
    ([#2510](https://github.com/koedame/chordsketch/pull/2510)).**
    `useFocusTrap` hook (focus trap + Escape + outside-click
    dismissal, sister-site to `popover.ts:451-525`); `useAnnouncer`
    hook (polite ARIA live region with same-tick coalescing
    semantics, sister-site to `index.ts:105-127`); AST helpers
    `irealCanonicalSymbolText` / `irealIsDaCapo` / `irealIsDalSegno`
    closing the asymmetry with `packages/ui-irealb-editor/src/ast.ts`.
  - **Interactive bar grid + structural editing + keyboard
    navigation
    ([#2511](https://github.com/koedame/chordsketch/pull/2511)).**
    `<IrealBarGrid>` component with ARIA grid semantics
    (`role="grid"` / `role="row"` / `role="gridcell"`,
    `aria-rowcount` / `aria-colcount={4}` / `aria-rowindex` /
    `aria-colindex`), roving tabindex per W3C APG (exactly one
    bar cell carries `tabindex="0"`), and per-bar accessible
    name that includes the chord text. Structural editing —
    section / bar add / rename / delete / move with re-anchoring
    of the active-bar ref. Keyboard shortcuts on the focused bar
    cell: `Arrow{Left,Right,Up,Down}` / `Home` / `End` roving
    navigation, `Alt+ArrowLeft` / `Alt+ArrowRight` reorder,
    `Delete` / `Backspace` to remove. Polite live-region
    announcements for every structural op. New
    `promptSectionLabel` / `confirmDeleteSection` props for hosts
    that want styled modals instead of `window.prompt` /
    `window.confirm`.
  - **Popover-based per-bar chord editing
    ([#2512](https://github.com/koedame/chordsketch/pull/2512),
    this PR).** `<IrealBarPopover>` modal dialog (`role="dialog"`
    `aria-modal="true"` with focus trap + Escape / outside-click
    dismissal). Edits every bar field: start / end barlines,
    chord rows (root + accidental + 12 named qualities + Custom
    + optional `/X` bass + beat position 1 / 1.5 / 2 / 2.5 / 3 /
    3.5 / 4 / 4.5; add / remove / reorder), N-th ending (empty /
    `0` untitled / `1..9` numbered), musical symbol (None +
    Segno + Coda + Fine + Fermata + Break + 11 D.C. / D.S. macro
    variants). Three-valued bass parser distinguishes empty /
    valid / invalid so a malformed entry keeps the previous
    bass and surfaces a
    `chordsketch-ireal-editor__input--invalid` modifier class.
    Save commits via the host's `emit` path; Cancel / Escape /
    outside-click discard the draft. A `...rest`-spread on the
    seed bar preserves AST fields the popover does not edit
    (staff-text, system-break hints, beat-grouping overrides).
  Architectural rationale recorded in
  [ADR-0020](docs/adr/0020-ireal-pro-react-surface.md): the
  React port replaces the imperative `renderChordsSection`
  rebuild from `packages/ui-irealb-editor/src/popover.ts` with
  React state; behaviour parity is preserved at the contract
  level (ARIA semantics, structural-op signatures, keyboard
  dispatch table, bass parser, ending range, symbol picker
  exhaustiveness). `packages/ui-irealb-editor/src/render.ts`'s
  bar-cell `aria-label` was updated in lockstep with the React
  port to include chord-text content per
  `.claude/rules/fix-propagation.md`.
- **`@chordsketch/react@0.1.0` — first publishable release (#2473).**
  The React component library moves from `0.0.0` (unpublished
  scaffold) to `0.1.0` and gains a full iReal Pro surface alongside
  the existing ChordPro components:
  - `<IrealEditor source onChange />` — header metadata form
    (title / composer / style / key root + accidental + mode /
    time numerator + denominator / tempo / transpose) +
    read-only bar grid + round-trip URL textarea, all wired
    through `@chordsketch/wasm`'s `parseIrealb` / `serializeIrealb`.
  - `<IrealPreview source />` — SVG preview via `renderIrealSvg`.
  - `<IrealPlayground />` — composite drop-in editor + preview
    analogous to `<Playground />` for ChordPro. Supports both
    uncontrolled (`defaultValue`) and controlled (`source` +
    `onChange`) modes.
  - Hooks: `useIrealParse`, `useIrealSerialize`, `useIrealRender`,
    each lazy-loading wasm once per hook instance.
  - AST types and helpers: `IrealSong`, `IrealSection`, `IrealBar`,
    `IrealChord`, `IrealChordQuality`, `IrealMusicalSymbol`, …
    plus `irealChordToString`, `irealSectionLabelToString`, …
  - Runtime dep on `@chordsketch/wasm` bumped from `^0.3.0` to
    `^0.4.0` to match the currently-published wasm major.
  - README extended to L3 quality bar from
    `.claude/rules/package-documentation.md`: API reference table
    covering every public export, platform compatibility table,
    peer-dependency table, Next.js / SSR notes, and the optional
    `@chordsketch/wasm-export` install hint for `<PdfExport>`.
  Architectural rationale recorded in
  [ADR-0020](docs/adr/0020-ireal-pro-react-surface.md): the iReal
  Pro React surface is a native React implementation (MVP feature
  set) rather than a wrapper around the private
  `@chordsketch/ui-irealb-editor`. `@chordsketch/ui-web` and
  `@chordsketch/ui-irealb-editor` READMEs gain prominent banners
  stating that external integrators should use `@chordsketch/react`
  rather than depending on the private packages directly.
- **`chordsketch-ireal` preserves full staff-text content (#2426).**
  New `StaffText` enum on the AST captures the spec's three staff-
  text shapes — `<text>` (plain caption), `<*XYtext>` (caption
  raised by a two-digit position `*XY` ∈ `00..=74`), and `<Nx>`
  (repeat-count override for the enclosing `{ ... }` block). The
  repeat-count payload is `core::num::NonZeroU16`, mirroring the
  `Ending::Numbered(NonZeroU8)` precedent — `<0x>` ("play zero
  times") falls through to a plain `Text` entry since the spec
  gives it no defined meaning. Each bar carries an ordered
  `Vec<StaffText>` on `Bar::staff_texts`, replacing the
  single-string `Bar::text_comment` so multiple `<...>` tokens on
  one bar round-trip in source order. Parser classifies the
  structured forms eagerly: `*XY` outside `0..=74` and single-digit
  prefixes fall through to plain captions so hand-authored exports
  survive verbatim. URL serializer zero-pads single-digit positions
  to match the parser's two-digit-prefix rule; JSON round-trip is
  additive (`staff_texts` omitted on bars that have none, preserving
  pre-#2426 snapshot byte stability) and `FromJson` rejects `<0x>` /
  `vertical_position > 74` / `count > u16::MAX` with typed errors.
  New `staff-text` SVG class in `chordsketch-render-ireal` paints
  each entry as an italic serif caption, interpolated linearly
  between the below-bar default baseline (`pos = 0`) and the
  music-symbol band (`pos = 74`). `convert::from_ireal` projects
  each entry into the ChordPro output and surfaces a structured
  `LossyDrop` warning when a `vertical_position` is dropped
  (ChordPro has no equivalent surface).
- **`chordsketch-ireal` open-protocol plain-text serializer (#2425).**
  New `serialize_open_protocol(&IrealSong) -> String` and
  `serialize_open_protocol_collection(&[IrealSong], Option<&str>)`
  emitting the 6-field `Title=Composer=Style=Key=TimeSig=Music`
  shape documented at
  <https://www.irealpro.com/ireal-pro-custom-chord-chart-protocol>.
  Music is plain text (no `MUSIC_PREFIX`, no `obfusc50`); TimeSig
  is the spec's packed-digit form (`44`, `34`, `68`, `128`). The
  percent-encoder covers the spec's reserved set
  (`=`, space, `{`, `}`, `[`, `]`, `<`, `>`, `,`, `#`, `^`) plus
  the `%` sigil itself, every byte >= 0x80 (UTF-8 safety per RFC
  3986), and the HTML-attribute hazards (`"`, `'`, `&`) so the
  output is safe inside a quoted `href`. Single-song output
  round-trips through `crate::parse`; tempo and transpose are not
  represented by the 6-field shape and are documented as dropped.
- **`chordsketch-ireal` distinguishes the eleven player-recognised
  D.C. / D.S. macro variants (#2427).** `MusicalSymbol::DaCapo` and
  `DalSegno` now carry a `JumpTarget` enum (`Unspecified` for the
  legacy bare `<D.C.>` / `<D.S.>` forms; `AlCoda`, `AlFine`,
  `AlEnding(NonZeroU8)` for the spec phrases). `MusicalSymbol::canonical_text`
  is the single source of truth shared with the SVG renderer
  (`crates/render-ireal`), the URL serializer, and the ChordPro
  converter (`crates/convert`). Parser uses exact-phrase
  classification (case-insensitive, whitespace-tolerant) with
  synonym tolerance for `End` / `Ending` alongside the spec
  `End.`; strict ordinal-suffix check (`1st`/`2nd`/`3rd`/`Nth`)
  matches the JSON deserializer's grammar.
- **`chordsketch-ireal` compound-time beat grouping (#2449).**
  Recognises iReal Pro v2024.4+'s `<a+b(+c)*>` staff-text
  directive that customises how an odd-meter time signature is
  felt internally (5/4 as `3+2` or `2+3`, 7/8 as `4+3` / `3+4` /
  `3+2+2`, …). New [`BeatGrouping`] struct holding a non-empty
  `Vec<NonZeroU8>` of subgroup sizes plus a `Bar::beat_grouping_override`
  field. Parser validates the sum against the active time
  signature's numerator and persists the override across bars
  ("remains until the opposite is used"); meter changes reset the
  running state. Malformed inputs (`<2++3>`, `<+3>`, sum
  mismatches) fall through to `Bar::staff_texts` (#2426) so the
  original token round-trips losslessly. The 6-field `irealbook://`
  header's time signature now seeds the music-body parser's
  meter state so `<a+b>` directives validate against the
  declared chart meter even when the body has no inline `T..`
  directive. URL serializer emits `<a+b>` only at change points
  to match the spec's one-token-per-change convention. JSON
  serialiser uses the additive-omit pattern (default `None`
  omitted) so pre-#2449 snapshots stay byte-stable.

- **`chordsketch-ireal` pause-slash (`p`) support.** The spec's
  pause-slash token (`|C7ppF7|`: repeat the preceding chord at
  each `p` beat slot) now round-trips through the AST instead of
  being silently dropped. New `BarChordKind { Played, SlashRepeat }`
  enum on [`BarChord`]; the parser emits a `SlashRepeat` entry
  whose `chord` field carries a snapshot of the preceding chord
  (across bar boundaries when the slash sits in a new bar), the
  URL serializer re-emits `p` for each `SlashRepeat`, and the
  SVG renderer paints a single `/` glyph in the bar's beat
  column. JSON serializer uses the same additive-omit convention
  as `size` so existing snapshots stay byte-stable (#2435).
- **`chordsketch-ireal` Fermata (`f`) marker (#2474).** New
  `MusicalSymbol::Fermata` variant attaches an arc-and-dot
  fermata to the bar in which the token appears. Parser
  classifies the bare lower-case `f` token alongside `S` / `Q` /
  `<Fine>` / `<Break>`; URL serializer round-trips it back to
  the same single-character form. JSON serialiser stays additive
  (`musical_symbol: "Fermata"`) so prior snapshots remain
  byte-stable. SVG renderer paints the fermata above the bar's
  music-symbol band using a Bravura SMuFL outline (sister-site
  to the segno / coda glyphs baked in #2348). `convert::from_ireal`
  projects it as a `(Fermata) ` inline lyrics-text segment, the
  same shape used for the rest of the Segno / Coda / D.C. / D.S.
  / Fine / Break family — no warning is emitted because the
  symbol carries a visible text representation in the ChordPro
  output.
- **`chordsketch-ireal` `<Break>` drum-silence marker (#2489).**
  The spec's `<Break>` staff-text directive (one bar of complete
  rhythm-section silence) is now recognised as the structured
  `MusicalSymbol::Break` variant instead of falling through to a
  plain `<text>` caption. Parser uses exact-phrase
  classification (case-insensitive); URL serializer re-emits
  `<Break>`; the SVG renderer paints `Break` as italic staff text
  at the bar cell's left-edge music-symbol slot (the same
  `emit_text_directive` path D.C. / D.S. / Fine route through);
  `convert::from_ireal` projects it as a `(Break) ` inline
  lyrics-text segment, matching the rest of the canonical-symbol
  family.
- **`chordsketch-ireal` chord-size markers `s` / `l` (#2477).**
  iReal Pro's per-chord size prefix (`|s C7 lF7|`: small `C7`,
  default `F7`) round-trips through the AST via a new
  `ChordSize { Default, Small }` field on [`BarChord`]. Parser
  recognises `s` / `l` as state-mode markers between chord tokens,
  updating the running chord-size state that applies to every
  subsequent chord until the next opposite marker; URL serializer
  tracks a matching `current_size` state and re-emits the
  transition marker on every change (so a `Default` chord
  following a `Small` chord serialises with a leading `l`). JSON
  serializer uses the additive-omit pattern (default omitted) so
  pre-#2477 snapshots stay byte-stable. **The SVG renderer paints
  `ChordSize::Small` chords in a narrower font (#2487)** so the
  size hint reaches the rendered chart.
- **`chordsketch-ireal` vertical-space hint `Y` / `YY` / `YYY`
  (#2472).** The spec's between-system vertical-space directive
  (one, two, or three `Y` tokens hinting "leave 1/2/3 extra
  blank line(s) before the next system") is now preserved on
  `Bar::system_break_space` (clamped to `0..=3`). URL serializer
  re-emits the exact `Y` count at the bar's position; JSON
  serialiser uses additive-omit (default `0` omitted); the SVG
  renderer adds proportional vertical padding above the row
  whose leading bar carries a non-zero hint
  (`VERTICAL_BREAK_PER_LEVEL` user-units per level).

### Changed

- **`chordsketch-wasm` / `chordsketch-napi` ABI surfaces moved to
  `bindings.rs` (#2516, closes #2352).** Every `#[wasm_bindgen]`
  / `#[napi]` declaration is now in a sibling `bindings.rs` file
  per binding crate, excluded from `cargo llvm-cov` measurement
  via `codecov.yml`'s `ignore:` list. The proc-macro-generated
  ABI thunks were depressing the bindings-group line-coverage
  number (~67% napi / ~73% wasm) without being reachable from
  unit tests — moving them out lifts both crates above 95% and
  brings the bindings group's intra-group skew from ~21 pp to
  ~10 pp per `.claude/rules/fix-propagation.md` §"Coverage
  Floors". No public-API change; the wasm / napi npm packages
  expose exactly the same surface as 0.4.x.

- **iReal Pro CI smoke is hard-gating on every install path
  except winget (#2403).** v0.4.0 (2026-05-06) shipped iReal Pro
  binaries to Homebrew, Scoop, Snap, Docker, and crates.io;
  these channels' iReal smoke steps are now hard-gating (the
  pre-release `continue-on-error: true` carve-out is removed
  from `.github/actions/cli-render-smoke/action.yml`'s three
  iReal Pro steps for every install path that uses the default
  `tolerate-ireal-failure: false`). winget-pkgs has not yet
  ingested the v0.4.0 manifest — `winget install chordsketch`
  currently resolves to the pre-iReal 0.1.0 binary — so the
  winget job alone passes `tolerate-ireal-failure: 'true'` to
  the composite action; the iReal Pro smoke remains
  informational on that channel until the
  `packaging/winget/koedame.chordsketch.installer.yaml`
  manifest is refreshed (stale SHA256 → v0.4.0 SHA256) and
  submitted to winget-pkgs. `readme-smoke.yml`'s `library-smoke`
  job's crates.io-mode branch is also flipped on for the iReal
  half: `chordsketch-ireal = "^0.4"` and
  `chordsketch-render-ireal = "^0.4"` are now pinned alongside
  the existing ChordPro constraints. Daily-cron smoke now
  covers the iReal Pro snippet end-to-end against the published
  crates.

- **React surface renders ChordPro AST → JSX directly**
  ([ADR-0017](docs/adr/0017-react-renders-from-ast.md), #2475).
  `<ChordSheet format="html">` and `<RendererPreview format="html">`
  no longer round-trip through `chordsketch-render-html`'s
  string output and no longer wrap the preview in an
  `<iframe srcdoc>`. The wasm bundle exposes the parsed `Song`
  AST via `parseChordpro` / `parseChordproWithOptions`; the new
  `chordpro-jsx` walker in `@chordsketch/react` emits a React
  tree matching the Rust HTML renderer's DOM contract
  (`.song`, `.line`, `.chord-block`, `.chord`, `.lyrics`,
  `<section class="…">`, `<p class="comment">`, `<h1>`, `<h2>`,
  `<p class="meta">`). The Rust HTML renderer
  (`chordsketch-render-html`) stays as the canonical static-HTML
  emitter for the CLI (`--format html`), FFI bindings, GitHub
  Action, and the VS Code extension's iframe preview — every
  surface that does not own a JS / React runtime. Sister-site
  parity rules (`.claude/rules/renderer-parity.md` and
  `.claude/rules/fix-propagation.md`) updated to track the
  React JSX walker as a fourth rendering surface alongside the
  text / HTML / PDF Rust renderers.

### Added

- `chordsketch-chordpro::json` — hand-rolled, zero-dep JSON
  serialiser for the full `Song` AST, mirroring the
  `chordsketch-ireal::json` pattern (#2055).
- `parseChordpro` / `parseChordproWithOptions` wasm exports
  (`@chordsketch/wasm` 0.4.x and later) returning the AST as
  a JSON string; TS shape declared in
  `packages/react/src/chordpro-ast.ts`.
- `useChordproAst(source, options)` hook in `@chordsketch/react`
  paralleling `useChordRender`, plus the public
  `renderChordproAst(song)` walker for consumers that need to
  drive their own React tree off the same AST without the
  `<ChordSheet>` shell.

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
    `Bar::staff_texts` (see the dedicated #2426 entry above for
    the structured `StaffText` shape and the `<*XYtext>` /
    `<Nx>` variants). Anchored macro detection on `D.C.` /
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
  - Section-label vocabulary reconciled with iReal Pro's own
    rehearsal-mark set (`A` / `B` / `C` / `D` / `IN` / `V`).
    Uppercase `*V` now maps to `SectionLabel::Verse` per the
    spec example (#2432). The `*c` / `*b` / `*o` tokens were
    never emitted by iReal Pro — `SectionLabel::Chorus`,
    `Bridge`, and `Outro` variants have been removed; the
    convert crate now round-trips ChordPro's
    `start_of_chorus` / `start_of_bridge` directives via
    `Custom("Chorus")` / `Custom("Bridge")` so the
    ChordPro-side semantics are preserved without producing
    out-of-spec `irealb://` tokens (#2450).
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
  warning when there is none), `staff_texts` → parenthesised
  inline text (plain captions verbatim, `<Nx>` overrides as
  `(Nx)`, `<*XYtext>` raises surfaced as `LossyDrop` warnings
  per the #2426 entry above), `chord.alternate` → parenthesised
  alternate chord after the primary.
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
