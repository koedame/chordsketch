//! PDF converter for the iReal Pro chart renderer.
//!
//! Wraps [`crate::render_svg`] in a `usvg` parse + `svg2pdf::to_pdf`
//! pipeline so callers can produce a PDF byte stream from an
//! [`IrealSong`] without leaving the crate. Compiled only when the
//! `pdf` cargo feature is enabled — see [`crate`] for the feature
//! gate rationale.
//!
//! # Page geometry
//!
//! The SVG renderer's `595 × 842` viewBox in CSS px (1 px = 1/96
//! inch) maps to `595 × 842` PDF user-space points at the assumed
//! 72 DPI svg2pdf uses, which is exactly ISO 216 A4
//! (210 × 297 mm = 595 × 842 pt). The output PDF therefore lands
//! on A4 with the chart filling the page; no margin clipping or
//! content scaling occurs.
//!
//! `Letter` (612 × 792 pt) is not in scope for this initial cut —
//! see the `## Deferred` note in the PR body.
//!
//! # Single-page scope
//!
//! The current renderer emits one page. Multi-page support is
//! deferred because the SVG renderer itself is single-page; an
//! overflow path needs SVG-side pagination first. Charts longer
//! than [`crate::page::MAX_BARS`] (256 bars) are truncated by the
//! SVG renderer well before any PDF page would overflow.

use crate::{RenderOptions, render_svg};
use chordsketch_ireal::IrealSong;
use std::fmt;

/// `svg2pdf` assumes 72 DPI when converting an SVG with CSS-px
/// dimensions to PDF user-space points; that matches our
/// `PAGE_WIDTH × PAGE_HEIGHT = 595 × 842` viewBox to A4.
const PDF_DPI: f32 = 72.0;

/// Caller-supplied PDF-conversion configuration.
///
/// Constructed via [`PdfOptions::default`] — the struct is
/// `#[non_exhaustive]` so future fields (e.g. `page_size`,
/// `compression`) are non-breaking.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
#[non_exhaustive]
pub struct PdfOptions {}

/// Errors produced by [`render_pdf`].
#[derive(Debug)]
pub enum PdfError {
    /// `usvg` rejected the SVG produced by [`render_svg`]. The
    /// renderer is supposed to emit only well-formed SVG, so a
    /// surface here is an internal-consistency bug — the variant
    /// exists so we can surface the underlying message rather than
    /// panicking.
    SvgParse(String),
    /// `svg2pdf::to_pdf` failed to produce the PDF byte stream.
    /// The contained string is the underlying message.
    Conversion(String),
}

impl fmt::Display for PdfError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::SvgParse(msg) => write!(f, "SVG parse failed: {msg}"),
            Self::Conversion(msg) => write!(f, "PDF conversion failed: {msg}"),
        }
    }
}

impl std::error::Error for PdfError {}

/// Renders an iReal Pro chart as a single-page A4 PDF byte stream.
///
/// Internally calls [`render_svg`], parses the result with
/// `svg2pdf::usvg::Tree::from_str`, and converts via
/// `svg2pdf::to_pdf`. The chart is embedded as vector content, so
/// the PDF is resolution-independent (no DPI knob).
///
/// # Errors
///
/// - [`PdfError::SvgParse`] — `usvg` could not parse the SVG. This
///   indicates an internal renderer bug; please file an issue.
/// - [`PdfError::Conversion`] — PDF conversion failed.
///
/// # Example
///
/// ```no_run
/// use chordsketch_ireal::IrealSong;
/// use chordsketch_render_ireal::pdf::{PdfOptions, render_pdf};
///
/// let song = IrealSong::new();
/// let bytes = render_pdf(&song, &PdfOptions::default()).unwrap();
/// assert_eq!(&bytes[..5], b"%PDF-");
/// ```
pub fn render_pdf(song: &IrealSong, _options: &PdfOptions) -> Result<Vec<u8>, PdfError> {
    let svg = render_svg(song, &RenderOptions::default());
    let usvg_options = svg2pdf::usvg::Options::default();
    let tree = svg2pdf::usvg::Tree::from_str(&svg, &usvg_options)
        .map_err(|e| PdfError::SvgParse(e.to_string()))?;

    let conversion_options = svg2pdf::ConversionOptions::default();
    let page_options = svg2pdf::PageOptions { dpi: PDF_DPI };

    svg2pdf::to_pdf(&tree, conversion_options, page_options)
        .map_err(|e| PdfError::Conversion(e.to_string()))
}
