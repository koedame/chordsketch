# 0014. Bravura SMuFL glyphs ship as inline SVG paths, not as a bundled font

- **Status**: Accepted
- **Date**: 2026-05-02

## Context

Issue #2062 originally specified that the iReal renderer should render
the segno (U+E047) and coda (U+E048) music symbols using the
[Bravura SMuFL font](https://github.com/steinbergmedia/bravura) loaded
via `@font-face`. PR #2328 deferred that work and shipped SVG-primitive
approximations instead, with the explicit defer condition recorded in
its `## Deferred` section:

> Doing so would inflate every SVG export by a megabyte-scale
> payload (the Bravura WOFF2 distribution is in that range; an
> optimised subset would still cost meaningful per-export bytes —
> measure before re-proposing).

Issue #2348 lifts the defer. A natural follow-up proposal is to
publish two `@chordsketch/wasm` packages (one with Bravura, one
without) so consumers can opt in or out of the bundle. The decision
this ADR records is whether that split is worth the operational
cost, given the actual measured byte-impact of bundling.

## Decision

Bake the Bravura outlines for U+E047 and U+E048 into the
`chordsketch-render-ireal` crate as static SVG `<path d="…">`
constants in `src/bravura.rs`. Render them as a single
`<path class="music-symbol-segno|coda" transform="…" d="…"/>`
element each, with a composite `translate · scale · translate`
transform that maps font units to SVG units and flips the Y axis.

Do **not** bundle the font binary, do **not** publish a separate
"with-Bravura" build, and do **not** introduce a
`bravura` cargo feature flag. There is one default build, and every
consumer (CLI, WASM, NAPI, FFI, desktop, playground) gets the same
glyphs.

## Rationale

Three measurements settle the bundling-architecture question:

### Subset size (full font vs. WOFF2 vs. extracted paths)

Subsetting Bravura.otf to just U+E047 + U+E048 with `pyftsubset`
(`--no-hinting --desubroutinize --drop-tables+=DSIG --no-name-legacy`):

| Variant                         | Size       | vs. full Bravura.otf |
|---------------------------------|------------|----------------------|
| Bravura.otf (full)              | 512,924 B  | —                    |
| Subset OTF (segno + coda only)  | 14,820 B   | −97.1%               |
| Subset WOFF2                    | 4,324 B    | −99.2%               |
| Inline SVG path data (combined) | 1,599 B    | −99.7%               |

Extracting the two glyphs as raw SVG `<path>` data via
`fontTools.pens.svgPathPen` gives **1,119 B for segno** + **480 B for
coda**. That is smaller than the WOFF2 subset (4,324 B) and ~73%
smaller than the smallest practical font binary (14,820 B OTF after
aggressive table dropping).

### Per-export byte cost on each output target

Comparing a 4-bar empty section against the same section with one
extra symbol in bar 1, all measured against `cargo run --release`:

| Output            | No glyph   | + Segno    | + Coda     | Δ Segno  | Δ Coda   |
|-------------------|------------|------------|------------|----------|----------|
| SVG               | 954 B      | 2,207 B    | 1,567 B    | +1,253 B | +613 B   |
| PDF (svg2pdf)     | 1,399 B    | 1,965 B    | 1,670 B    | +566 B   | +271 B   |
| PNG (resvg, 300 DPI) | 170,244 B | 172,688 B | 173,188 B | +2,444 B | +2,944 B |

The PDF delta is **smaller** than the SVG delta because svg2pdf zlib-
compresses content streams, so a vector path encoded in PDF native
operators is more compact than its SVG-text source. The PNG delta
comes from extra rendered black pixels at 300 DPI, not from the path
itself; it is dominated by the PNG container baseline (~170 KB) and
is operationally irrelevant.

For comparison, embedding the WOFF2 subset as a base64
`@font-face` would cost ~5,765 B per SVG (font binary +33% base64
inflation) **whether or not the SVG actually uses a glyph**, plus
fontdb registration in the PNG / PDF pipelines.

### Cross-format pipeline cost

The crate's PDF and PNG renderers funnel SVG through `usvg::Tree::from_str`.
Inline `<path>` data flows through that parser as native vector content
and reaches both backends with zero font-resolution overhead — `usvg`
does not consult `fontdb` for elements that are not `<text>`. A bundled-
font architecture would have required:

- Adding `usvg::Options::fontdb` registration to `pdf.rs` and `png.rs`.
- Pulling the font binary into both binding cdylibs (WASM, NAPI, FFI)
  via `include_bytes!` so the glyph resolves at render time without
  filesystem access.
- Auditing the pinned `resvg 0.43 / svg2pdf 0.12 / usvg 0.43` line for
  fontdb-API stability (resvg 0.45+ requires Rust 1.87, blocked by the
  workspace MSRV per `crates/render-ireal/Cargo.toml`).

The path-baked approach drops all three concerns.

### License attribution

Extracting outlines from Bravura produces a derivative work covered
by the [SIL Open Font License 1.1](https://scripts.sil.org/OFL).
§4 of the OFL requires that every copy of the derivative carry the
same OFL attribution, so a `NOTICE` entry and a link from
`crates/render-ireal/README.md` are required regardless of whether
we bundle the font binary or its derived outlines. The path-baked
approach therefore inherits the same attribution obligations as a
bundled-font approach without inheriting the byte cost.

## Consequences

**Positive**

- Every consumer gets canonical SMuFL segno / coda glyphs by
  default. No opt-in flag, no two-build matrix, no dual npm
  package, no `RenderOptions` toggle for consumers to learn.
- The `chordsketch-render-ireal` crate keeps its current
  zero-additional-runtime-deps posture. PNG and PDF features
  continue to gate `resvg` / `tiny-skia` / `svg2pdf` only; no
  `fontdb` initialisation.
- Per-SVG cost is bounded by raw path bytes (~1,253 B for segno,
  ~613 B for coda) and only paid when the symbol actually appears.

**Negative**

- The path data is opaque (a long `d=` string). A future
  contributor cannot eyeball-debug the glyph — they must
  re-render it.
  - *Mitigation*: `crates/render-ireal/src/bravura.rs` documents
    the extraction provenance, and the regenerator script will
    live under `scripts/extract-bravura-paths.py` so the data
    is reproducible.
- We diverge from a strict "use the font as the SMuFL spec
  intends" posture. Other SMuFL consumers can render Bravura
  glyphs by codepoint; we cannot.
  - *Mitigation*: Stable selectors `class="music-symbol-segno"` /
    `class="music-symbol-coda"` give downstream stylesheets a
    hook if a consumer wants to swap in their own glyph.
- Adding new SMuFL glyphs in the future means re-running the
  extraction script and committing more path data.
  - *Mitigation*: Acceptable cost given that the iReal Pro
    renderer is unlikely to need many more SMuFL codepoints —
    accidentals already use Unicode `U+266D`–`U+266F` from
    system fonts, and barlines / repeats are line primitives
    that don't benefit from font glyphs.

## Alternatives considered

### Alternative 1: Bundle the WOFF2 subset and reference via `@font-face`

Embed the 4,324 B WOFF2 subset in the SVG as
`<style>@font-face{src:url('data:font/woff2;base64,…');font-family:…}</style>`.

Rejected because:

- Per-SVG inflation is **larger**, not smaller, than baking paths
  (~5,765 B base64-inflated vs. 1,599 B raw paths).
- The cost is paid on every render whether or not a glyph appears —
  `<style>` lives in the document head, not next to the `<path>` it
  serves.
- PNG and PDF backends would need `usvg::fontdb` registration plumbed
  through `png.rs` and `pdf.rs`, adding a `fontdb` API surface that
  the pinned 0.43 line guarantees only on a best-effort basis.

### Alternative 2: Two-build matrix (`@chordsketch/wasm` slim + bundled)

Publish two npm packages, two NAPI builds, two FFI cdylibs — one with
Bravura, one without. Document the choice in the README and let
consumers pick.

Rejected because:

- The byte savings the split would offer (~1.6 KB per WASM build)
  are not worth the doubling of:
  - `npm publish` runs (per [ADR-0008](0008-npm-publishing-is-local.md)
    every publish is a manual maintainer-local operation).
  - CI build matrix cells.
  - User-facing documentation that has to explain when each variant
    applies.
- The sub-2-KB savings disappear once the consumer ships any other
  binary asset alongside the chart.
- Per `.claude/rules/fix-propagation.md` "Bindings" group, splitting
  WASM into two variants without splitting NAPI / FFI introduces
  binding asymmetry. Splitting all three multiplies the operational
  cost further.

### Alternative 3: Keep SVG-primitive approximations

Status quo before this ADR. Hand-rolled S-curve + slash + dots for
segno; circle + cross for coda.

Rejected because:

- The visual fidelity is poor. The S-curve approximation does not
  match SMuFL's segno; the coda's cross is geometrically square,
  not the SMuFL "+" with a vertical stem and shorter horizontal.
- The approximation code (~80 lines) is replaced by ~10 lines of
  transform composition + two path constants — net code reduction.
- All measured byte costs are well within the deferred-decision
  envelope (no megabyte-scale inflation; no fontdb dependency).

### Alternative 4: Lazy load the font from the playground host

Have the WASM consumer load Bravura from a CDN at runtime. Zero
bundle cost.

Rejected because:

- Adds a runtime network dependency to a function that is otherwise
  pure (`render_svg(song)` becoming `Promise<string>`).
- Defeats the use case of running offline (the desktop app, the
  CLI, CI smoke jobs) — a CDN failure becomes a render failure.
- Indirection: every consumer would need to wire up the same font-
  loading boilerplate.

## References

- Issue [#2348](https://github.com/koedame/chordsketch/issues/2348)
  — implementation issue this ADR governs.
- Issue [#2050](https://github.com/koedame/chordsketch/issues/2050)
  — iReal Pro tracker.
- PR [#2328](https://github.com/koedame/chordsketch/pull/2328)
  — original deferral; `## Deferred` section is the trigger this
  ADR resolves.
- [SMuFL specification](https://www.smufl.org/version/latest/)
  — codepoint registry for U+E047 SEGNO and U+E048 CODA.
- [Bravura upstream](https://github.com/steinbergmedia/bravura) —
  source of the extracted outlines (SIL OFL-1.1).
- [`.claude/rules/adr-discipline.md`](../../.claude/rules/adr-discipline.md)
  — process this ADR follows.
- [ADR-0008](0008-npm-publishing-is-local.md) — npm publishing
  posture cited in Alternative 2's rejection.

### Watch signals (revisit if any of these change)

- **Bravura adds glyph variants we want.** Re-running the extractor
  is cheap; the ADR's analysis still holds.
- **The iReal renderer needs more than ~10 SMuFL glyphs.** At ~10×
  the current path-byte cost the analysis tilts back toward bundling
  the font binary.
- **`usvg`'s API for non-fontdb path rendering changes.** The
  current decision relies on `usvg` parsing inline `<path>` without
  consulting `fontdb`. If a future `usvg` makes that no longer
  true, this ADR should be revisited.
