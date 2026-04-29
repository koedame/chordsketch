//! iReal Pro chart renderer — SVG skeleton.
//!
//! This crate is the SVG renderer scaffold for the iReal Pro
//! feature set tracked under
//! [#2050](https://github.com/koedame/chordsketch/issues/2050).
//! It deliberately ships only the page frame, the metadata header
//! (title / composer / style / key), and an empty 4-bar-per-line
//! grid skeleton — chord text, barline shapes, repeat / ending
//! brackets, music symbols, and chord-name typography each have
//! their own follow-up issue.
//!
//! # Layout overview
//!
//! Output is a fixed-size SVG `(595 × 842)` with deterministic
//! integer coordinates so golden snapshots remain byte-stable.
//! The page is divided into:
//!
//! - **Header band** — title (top), composer (right), style + key
//!   (left, beneath the title).
//! - **Bar grid** — bars laid out 4-per-row in equal-width cells
//!   below the header. Each cell is currently an empty `<rect>`;
//!   chord text and inner glyphs are filled in by the follow-up
//!   crates / issues.
//!
//! # Dependency policy
//!
//! Only depends on [`chordsketch_ireal`] for the AST. SVG
//! generation is hand-rolled — no `xmlwriter`, no `svg` crate, no
//! templating engine. Keeps the transitive-dep surface minimal and
//! mirrors the zero-external-dep posture of `chordsketch-chordpro`
//! / `chordsketch-ireal`.
//!
//! # Stability
//!
//! Pre-1.0. The SVG output structure is expected to grow new
//! elements (chord text, barlines, music symbols) as #2057 / #2059
//! / #2060 / #2062 land. Existing elements stay stable so that
//! crate consumers (the playground preview, the PDF rasteriser
//! #2063, the PNG rasteriser #2064) can rely on a small set of
//! stable selectors / IDs.
//!
//! # Example
//!
//! ```
//! use chordsketch_ireal::IrealSong;
//! use chordsketch_render_ireal::{RenderOptions, render_svg};
//!
//! let song = IrealSong::new();
//! let svg = render_svg(&song, &RenderOptions::default());
//! assert!(svg.starts_with("<?xml version=\"1.0\" encoding=\"UTF-8\"?>"));
//! assert!(svg.contains("<svg "));
//! ```

#![forbid(unsafe_code)]

pub mod page;
mod svg;

use chordsketch_ireal::{Accidental, IrealSong, KeyMode};

pub use page::{
    BAR_ROW_HEIGHT, BARS_PER_ROW, GRID_TOP, HEADER_BAND_HEIGHT, MARGIN_X, MARGIN_Y, PAGE_HEIGHT,
    PAGE_WIDTH,
};

/// Caller-supplied render configuration.
///
/// The scaffold accepts only defaults. Adding fields is non-breaking
/// because the struct is `#[non_exhaustive]`; callers must construct
/// it via [`RenderOptions::default`] (or `RenderOptions { ..default() }`
/// once a setter materialises) so future additions cannot drop a
/// caller's customisations.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
#[non_exhaustive]
pub struct RenderOptions {}

/// Renders an iReal Pro chart as a fixed-size SVG document.
///
/// The output is well-formed SVG 1.1 with deterministic integer
/// coordinates so golden tests remain byte-stable. See the crate
/// documentation for the layout contract.
#[must_use = "rendering produces a string the caller is expected to consume"]
pub fn render_svg(song: &IrealSong, _options: &RenderOptions) -> String {
    let bar_count: usize = song.sections.iter().map(|s| s.bars.len()).sum();
    let row_count = bar_count.div_ceil(BARS_PER_ROW.max(1));
    let mut out = String::new();
    out.push_str("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n");
    out.push_str(&format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"{PAGE_WIDTH}\" \
height=\"{PAGE_HEIGHT}\" viewBox=\"0 0 {PAGE_WIDTH} {PAGE_HEIGHT}\">\n"
    ));
    write_page_frame(&mut out);
    write_header(&mut out, song);
    write_grid(&mut out, row_count);
    out.push_str("</svg>\n");
    out
}

fn write_page_frame(out: &mut String) {
    out.push_str(&format!(
        "  <rect x=\"0\" y=\"0\" width=\"{PAGE_WIDTH}\" height=\"{PAGE_HEIGHT}\" \
fill=\"white\" stroke=\"black\" stroke-width=\"1\"/>\n"
    ));
}

fn write_header(out: &mut String, song: &IrealSong) {
    let header_top = MARGIN_Y;
    let title_y = header_top + 32;
    let meta_y = header_top + 60;
    let title_text = if song.title.is_empty() {
        "Untitled".to_string()
    } else {
        svg::escape_xml(&song.title)
    };
    out.push_str(&format!(
        "  <text x=\"{MARGIN_X}\" y=\"{title_y}\" font-family=\"sans-serif\" \
font-size=\"24\" class=\"title\">{title_text}</text>\n"
    ));
    if let Some(composer) = song.composer.as_deref() {
        let escaped = svg::escape_xml(composer);
        let composer_x = PAGE_WIDTH - MARGIN_X;
        out.push_str(&format!(
            "  <text x=\"{composer_x}\" y=\"{title_y}\" font-family=\"sans-serif\" \
font-size=\"14\" text-anchor=\"end\" class=\"composer\">{escaped}</text>\n"
        ));
    }
    let meta_left = format_style_and_key(song);
    out.push_str(&format!(
        "  <text x=\"{MARGIN_X}\" y=\"{meta_y}\" font-family=\"sans-serif\" \
font-size=\"12\" class=\"meta\">{meta_left}</text>\n"
    ));
}

fn format_style_and_key(song: &IrealSong) -> String {
    // The iReal Pro app renders "Medium Swing" when a chart omits a
    // style tag; the AST stores `Option<String>` so the renderer
    // applies that fallback at the display boundary, mirroring the
    // app's behaviour without putting the default in the AST.
    let style = song.style.as_deref().unwrap_or("Medium Swing");
    let key = format_key(song);
    let combined = if key.is_empty() {
        style.to_string()
    } else {
        format!("{style} \u{2022} {key}")
    };
    svg::escape_xml(&combined)
}

fn format_key(song: &IrealSong) -> String {
    let root = song.key_signature.root;
    let acc = match root.accidental {
        Accidental::Natural => "",
        Accidental::Flat => "\u{266D}",
        Accidental::Sharp => "\u{266F}",
    };
    let mode = match song.key_signature.mode {
        KeyMode::Major => "major",
        KeyMode::Minor => "minor",
    };
    format!("{}{acc} {mode}", root.note)
}

fn write_grid(out: &mut String, row_count: usize) {
    if row_count == 0 {
        return;
    }
    let grid_left = MARGIN_X;
    let grid_right = PAGE_WIDTH - MARGIN_X;
    let cell_width = (grid_right - grid_left) / BARS_PER_ROW as i32;
    out.push_str("  <g class=\"bar-grid\">\n");
    for row in 0..row_count {
        let row_y = GRID_TOP + (row as i32) * BAR_ROW_HEIGHT;
        for col in 0..BARS_PER_ROW {
            let cell_x = grid_left + (col as i32) * cell_width;
            out.push_str(&format!(
                "    <rect x=\"{cell_x}\" y=\"{row_y}\" width=\"{cell_width}\" \
height=\"{BAR_ROW_HEIGHT}\" fill=\"none\" stroke=\"black\" stroke-width=\"1\"/>\n"
            ));
        }
    }
    out.push_str("  </g>\n");
}

/// Returns the library version (the workspace `Cargo.toml`
/// `version` field, baked in at compile time).
#[must_use]
pub fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}
