//! PNG rasteriser for the iReal Pro chart renderer.
//!
//! Wraps [`crate::render_svg`] in a `usvg` parse + `resvg` render
//! pipeline so callers can produce a PNG byte stream from an
//! [`IrealSong`] without leaving the crate. Compiled only when the
//! `png` cargo feature is enabled — see [`crate`] for the feature
//! gate rationale.
//!
//! # DPI semantics
//!
//! The SVG document produced by [`crate::render_svg`] uses a fixed
//! `595 × 842` viewBox (in CSS pixels). PNG rasterisation scales the
//! output by `dpi / 96.0` because the CSS px definition fixes 1 px =
//! `1/96` inch (per the [CSS Values 4][1] spec, §6.1). A `dpi` of
//! 300 therefore produces a `(595 × 300/96) × (842 × 300/96)`-pixel
//! image (≈ 1860 × 2632), suitable for printing without resampling.
//!
//! [1]: https://www.w3.org/TR/css-values-4/#absolute-lengths

use crate::{RenderOptions, render_svg};
use chordsketch_ireal::IrealSong;
use std::fmt;

/// CSS px → physical inch conversion factor: 1 inch = 96 CSS px.
const CSS_PX_PER_INCH: f32 = 96.0;

/// Default rasterisation density in DPI when [`PngOptions::dpi`] is
/// `None`. Matches the AC for #2064 ("Configurable DPI (default 300)").
pub const DEFAULT_DPI: u32 = 300;

/// Hard ceiling on the rasterisation density. Caps the pixmap
/// allocation at roughly `(595 × 1200/96) × (842 × 1200/96) × 4 B`
/// = ~330 MiB, which is the largest size we are willing to allocate
/// before returning [`PngError::DpiOutOfRange`]. Keeps adversarial
/// `dpi` values from producing a multi-gigabyte allocation.
pub const MAX_DPI: u32 = 1200;

/// Caller-supplied PNG-rasterisation configuration.
///
/// Constructed via [`PngOptions::default`] — the struct is
/// `#[non_exhaustive]` so future fields are non-breaking. The single
/// field `dpi` controls the output resolution in dots-per-inch.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
#[non_exhaustive]
pub struct PngOptions {
    /// Output density in DPI. `None` selects [`DEFAULT_DPI`] (300).
    /// Must be in `1 ..= MAX_DPI` when `Some`; values outside that
    /// range cause [`render_png`] to return
    /// [`PngError::DpiOutOfRange`].
    pub dpi: Option<u32>,
}

impl PngOptions {
    /// Creates a [`PngOptions`] with the supplied DPI.
    ///
    /// `dpi` is recorded verbatim — this constructor performs no
    /// range validation. Out-of-range values surface as
    /// [`PngError::DpiOutOfRange`] from [`render_png`] so the rule
    /// that "validation lives at the public boundary" (per
    /// `.claude/rules/defensive-inputs.md`) has a single
    /// implementation site at the rendering boundary rather than
    /// duplicated copies on the constructor and the renderer.
    ///
    /// Construction does not fail; pass any `u32`. Use
    /// [`PngOptions::default`] when the default DPI is fine.
    #[must_use]
    pub const fn with_dpi(dpi: u32) -> Self {
        Self { dpi: Some(dpi) }
    }
}

/// Errors produced by [`render_png`].
#[derive(Debug)]
pub enum PngError {
    /// The supplied DPI is `0` or exceeds [`MAX_DPI`]. The contained
    /// value is the offending input.
    DpiOutOfRange(u32),
    /// `usvg` rejected the SVG produced by [`render_svg`]. The
    /// renderer is supposed to emit only well-formed SVG, so a
    /// surface here is an internal-consistency bug — the variant
    /// exists so we can surface the underlying message rather than
    /// panicking.
    SvgParse(String),
    /// Pixel-buffer allocation failed. `tiny_skia::Pixmap::new`
    /// returns `None` when the requested dimensions overflow the
    /// internal buffer-size invariant; the contained tuple is
    /// `(width, height)` in pixels.
    PixmapAlloc(u32, u32),
    /// PNG encoding failed. The contained string is the underlying
    /// `tiny_skia` error message.
    PngEncode(String),
}

impl fmt::Display for PngError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::DpiOutOfRange(dpi) => {
                write!(f, "dpi {dpi} is out of the supported range 1..={MAX_DPI}")
            }
            Self::SvgParse(msg) => write!(f, "SVG parse failed: {msg}"),
            Self::PixmapAlloc(w, h) => write!(f, "pixmap allocation failed for {w} x {h} pixels"),
            Self::PngEncode(msg) => write!(f, "PNG encode failed: {msg}"),
        }
    }
}

impl std::error::Error for PngError {}

/// Renders an iReal Pro chart as a PNG byte stream.
///
/// Internally calls [`render_svg`] and rasterises the result via
/// `resvg` at the supplied DPI (default 300). Returns the encoded
/// PNG bytes.
///
/// # Errors
///
/// - [`PngError::DpiOutOfRange`] — `options.dpi` is `0` or above
///   [`MAX_DPI`].
/// - [`PngError::SvgParse`] — `usvg` could not parse the SVG. This
///   indicates an internal renderer bug; please file an issue.
/// - [`PngError::PixmapAlloc`] — pixel buffer allocation failed.
/// - [`PngError::PngEncode`] — PNG encoding failed.
///
/// # Example
///
/// ```no_run
/// use chordsketch_ireal::IrealSong;
/// use chordsketch_render_ireal::png::{PngOptions, render_png};
///
/// let song = IrealSong::new();
/// let bytes = render_png(&song, &PngOptions::default()).unwrap();
/// assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n");
/// ```
#[must_use = "the PNG bytes produced by render_png are expected to be consumed"]
pub fn render_png(song: &IrealSong, options: &PngOptions) -> Result<Vec<u8>, PngError> {
    let dpi = options.dpi.unwrap_or(DEFAULT_DPI);
    if dpi == 0 || dpi > MAX_DPI {
        return Err(PngError::DpiOutOfRange(dpi));
    }
    let svg = render_svg(song, &RenderOptions::default());
    let usvg_options = resvg::usvg::Options::default();
    let tree = resvg::usvg::Tree::from_str(&svg, &usvg_options)
        .map_err(|e| PngError::SvgParse(e.to_string()))?;

    // The SVG document carries dimensions in CSS px (96 DPI). Scaling
    // by `dpi / 96` turns those into the requested print density.
    let scale = dpi as f32 / CSS_PX_PER_INCH;
    let svg_size = tree.size();
    // `ceil` so a non-integer scaled dimension does not chop the
    // last partial row / column. Casting after `ceil` is safe because
    // the inputs are bounded: `svg_size <= page::PAGE_*` (842 max)
    // and `scale <= MAX_DPI / CSS_PX_PER_INCH` (12.5), so the product
    // fits in `u32` with comfort.
    let width = (svg_size.width() * scale).ceil() as u32;
    let height = (svg_size.height() * scale).ceil() as u32;
    let mut pixmap =
        tiny_skia::Pixmap::new(width, height).ok_or(PngError::PixmapAlloc(width, height))?;

    let transform = tiny_skia::Transform::from_scale(scale, scale);
    resvg::render(&tree, transform, &mut pixmap.as_mut());

    pixmap
        .encode_png()
        .map_err(|e| PngError::PngEncode(e.to_string()))
}
