//! Bravura SMuFL glyph outlines, baked as SVG `<path>` data.
//!
//! Source: [Bravura.otf](https://github.com/steinbergmedia/bravura)
//! `redist/otf/Bravura.otf` from upstream `master`, extracted via
//! `pyftsubset` + `fontTools.pens.svgPathPen`. Distributed under the
//! [SIL Open Font License 1.1](https://scripts.sil.org/OFL); see
//! `NOTICE` and the crate `README.md` for the attribution required by
//! §4 of the license.
//!
//! # Why path-baked instead of `@font-face`
//!
//! See [ADR-0014](../../../docs/adr/0014-bravura-glyphs-as-svg-paths.md)
//! for the full rationale; in short: the two SMuFL glyphs the iReal
//! renderer needs (segno U+E047, coda U+E048) compress to ~1.6 KB of
//! raw `<path>` data when extracted as outlines, vs. ~4.3 KB for a
//! WOFF2 subset of the same two codepoints. Path-baked also dodges the
//! `usvg::fontdb` registration that an `@font-face` / font-binary path
//! would require for the PNG and PDF renderers, keeping the
//! transitive-dep surface unchanged.
//!
//! # Coordinate system
//!
//! The path strings below are in **font units** with the OpenType
//! convention: origin at the glyph's left-baseline anchor, +X right,
//! +Y up. The em is 1000 units (`UPEM`). SVG's coordinate system has
//! +Y down, so call sites apply `scale(s, -s)` to flip the axis when
//! they render.
//!
//! All numeric constants here are derived from the upstream font
//! file deterministically by `scripts/extract-bravura-paths.py` —
//! re-run that script if Bravura is upgraded, then commit the
//! refreshed constants alongside the new font version.

/// OpenType units-per-em from `head.unitsPerEm` in the source file.
/// Glyph path coordinates are integers expressed in these units.
pub(crate) const UPEM: i32 = 1000;

/// Bounding-box center, in font units, for U+E047 SEGNO.
///
/// Used as the `(font_cx, font_cy)` argument to the renderer's
/// transform composition so the glyph's visual center aligns with the
/// SVG anchor point chosen by the caller.
pub(crate) const SEGNO_FONT_CX: i32 = 277;
/// Bounding-box vertical center, in font units, for U+E047 SEGNO.
pub(crate) const SEGNO_FONT_CY: i32 = 366;

/// Bounding-box center, in font units, for U+E048 CODA. The X
/// component is `951 / 2 = 475.5` so it must stay an `f32` constant
/// — rounding to `476` shifts the glyph by 0.009 SVG units at the
/// renderer's default scale, which is invisible but produces a
/// non-byte-stable golden.
pub(crate) const CODA_FONT_CX: f32 = 475.5;
/// Bounding-box vertical center, in font units, for U+E048 CODA.
pub(crate) const CODA_FONT_CY: i32 = 370;

/// SVG path data for U+E047 SEGNO, copied verbatim from
/// `pyftsubset` + `SVGPathPen` output. Coordinates are in font
/// units; the caller applies a `scale + translate` transform at
/// render time so this constant stays viewer-independent.
pub(crate) const SEGNO_PATH_D: &str = "M135 665C141 665 148 663 151 652L153 645C160 618 175 559 226 559C267 559 295 583 295 626C295 641 292 657 287 673C271 719 204 736 153 736C83 736 4 650 4 551C4 527 9 502 20 477C52 404 197 315 205 312C209 310 211 308 211 304C211 300 209 295 205 288C198 274 54 15 54 15C52 11 51 6 51 2C51 -14 63 -27 79 -27C89 -27 99 -21 104 -12C104 -12 259 268 262 274C262 273 270 279 274 279C289 276 489 217 489 122C489 83 465 57 431 52L428 51C407 51 390 65 390 96V107C390 145 365 173 337 173C333 173 329 172 325 171C288 162 254 146 254 106C254 45 316 -8 375 -8C388 -8 402 -6 417 -1C497 26 550 91 550 174C550 183 549 193 548 203C533 313 375 402 363 408C351 415 346 419 346 424C346 426 347 428 348 430C353 438 508 717 508 717C511 722 512 726 512 731C512 747 499 759 484 759C474 759 464 754 459 745C459 745 300 458 294 449C291 444 289 441 285 441C282 441 279 442 275 444C266 447 115 505 89 550C83 561 75 582 75 603C75 630 87 658 129 665ZM415 466C415 435 441 409 472 409C504 409 529 435 529 466C529 498 504 523 472 523C441 523 415 498 415 466ZM140 264C140 295 115 321 83 321C52 321 26 295 26 264C26 232 52 207 83 207C115 207 140 232 140 264Z";

/// SVG path data for U+E048 CODA, same provenance as
/// [`SEGNO_PATH_D`].
pub(crate) const CODA_PATH_D: &str = "M937 400H818C808 588 668 739 506 752V881C506 894 495 898 482 898C469 898 458 894 458 881V752C296 739 157 589 146 400H14C0 400 -4 389 -4 376C-4 363 0 352 14 352H146C157 165 296 13 458 0V-140C458 -154 469 -158 482 -158C495 -158 506 -154 506 -140V0C668 13 808 165 818 352H937C951 352 955 363 955 376C955 389 951 400 937 400ZM653 400H506V696C646 684 653 562 653 400ZM458 696V400H316C316 562 316 684 458 696ZM316 352H458V48C329 63 317 198 316 352ZM506 48V352H653C650 199 631 63 506 48Z";

#[cfg(test)]
mod tests {
    use super::*;

    /// Sanity check the path data starts with an absolute moveto so
    /// the `scale(-1)` Y-flip we apply at render time has a
    /// well-defined starting position. A regression that re-extracts
    /// the data with relative `m` would silently break alignment;
    /// this catches it before goldens get regenerated.
    #[test]
    fn glyph_paths_start_with_absolute_moveto() {
        assert!(SEGNO_PATH_D.starts_with('M'), "{SEGNO_PATH_D:.40}…");
        assert!(CODA_PATH_D.starts_with('M'), "{CODA_PATH_D:.40}…");
    }

    /// The path strings are pure ASCII — `extract-bravura-paths.py`
    /// rejects any extracted glyph that is not, but pinning the
    /// invariant in a Rust test means the byte-slicing the tests in
    /// `music_symbols.rs` perform on these constants stays valid
    /// even if a future contributor edits `bravura.rs` by hand
    /// rather than via the script.
    #[test]
    fn glyph_paths_are_ascii() {
        assert!(SEGNO_PATH_D.is_ascii());
        assert!(CODA_PATH_D.is_ascii());
    }

    /// The SMuFL Bravura `head.unitsPerEm` is 1000. A regression that
    /// regenerates the paths against a font with a different em would
    /// change the visual scale; pin the value so an inadvertent
    /// upstream re-extraction is caught.
    #[test]
    fn upem_matches_bravura_head_table() {
        assert_eq!(UPEM, 1000);
    }

    /// Pin the bbox-center constants. A future regenerator that
    /// picks up a slightly different Bravura release would shift
    /// these by a font unit or two; without pinning them here, the
    /// drift would only surface in the golden snapshots — by which
    /// point the goldens would already have been regenerated. With
    /// this test, `cargo test` fails fast in `bravura.rs` before
    /// the renderer outputs anything.
    #[test]
    fn glyph_centers_match_pinned_commit() {
        assert_eq!(SEGNO_FONT_CX, 277);
        assert_eq!(SEGNO_FONT_CY, 366);
        // CODA_FONT_CX is `f32`; compare with a float literal. The
        // value comes from `(-4 + 955) / 2 = 475.5` — exactly
        // representable in `f32`, so equality is safe.
        assert_eq!(CODA_FONT_CX, 475.5);
        assert_eq!(CODA_FONT_CY, 370);
    }
}
