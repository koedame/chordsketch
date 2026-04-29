//! iReal Pro chart renderer — SVG with chord-name typography.
//!
//! This crate renders an [`chordsketch_ireal::IrealSong`] AST as a
//! fixed-size SVG document. The current scope covers the page
//! frame, the metadata header (title / composer / style / key),
//! the 4-bars-per-line grid with section line breaks, and
//! superscript chord-name typography (root + accidental at base
//! size, quality / extensions raised as superscript, slash + bass
//! back at base size). Barlines, repeat / ending brackets, and
//! music symbols land in follow-up issues
//! (#2059 / #2062). Tracked under
//! [#2050](https://github.com/koedame/chordsketch/issues/2050).
//!
//! # Layout overview
//!
//! Output is a fixed-size SVG `(595 × 842)` with deterministic
//! integer coordinates so golden snapshots remain byte-stable.
//! The page is divided into:
//!
//! - **Header band** — title (top), composer (right), style + key
//!   (left, beneath the title).
//! - **Bar grid** — bars laid out 4-per-row by the
//!   [`layout::compute_layout`] engine. Each cell carries a
//!   centred chord-name `<text>` with mixed `<tspan>` runs:
//!   root + accidental at base size, quality / extensions
//!   raised as superscript at a smaller size, slash + bass at
//!   base size on the original baseline. Trailing cells in a
//!   section's last row are filled with empty placeholders so the
//!   visible grid stays a clean rectangle; barlines / repeats /
//!   endings / music symbols layer on top in #2059 / #2062.
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
//! elements (barlines, music symbols) as #2059 / #2062 land.
//! Existing elements stay stable so that crate consumers (the
//! playground preview, the PDF rasteriser #2063, the PNG
//! rasteriser #2064) can rely on a small set of stable selectors
//! / IDs (`class="title"`, `class="composer"`, `class="meta"`,
//! `class="bar-grid"`, `class="chord"`, `class="chord-root"`,
//! `class="chord-ext"`, `class="chord-slash"`, `class="chord-bass"`,
//! `class="empty"`).
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

pub mod chord_typography;
pub mod layout;
pub mod page;
mod svg;

use chordsketch_ireal::{Accidental, BarChord, IrealSong, KeyMode};

pub use chord_typography::{ChordTypography, SpanKind, TypographySpan};
pub use layout::{BarCoord, EmptyCell, Layout, compute_layout};
pub use page::{
    BAR_ROW_HEIGHT, BARS_PER_ROW, CHORD_FONT_SIZE_BASE, CHORD_FONT_SIZE_SUPERSCRIPT,
    CHORD_SUPERSCRIPT_DY, GRID_TOP, HEADER_BAND_HEIGHT, MARGIN_X, MARGIN_Y, MAX_BARS, PAGE_HEIGHT,
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
///
/// # Resource limits
///
/// The bar count is clamped to [`MAX_BARS`] before any allocation;
/// surplus bars are silently truncated. This mirrors the input-
/// bounds-check pattern in `chordsketch-chordpro`'s chord-diagram
/// renderer and the `MAX_COLUMNS` clamp in the HTML renderer (per
/// the validation-parity clause in `.claude/rules/renderer-parity.md`)
/// and prevents both unbounded `format!` allocation and overflow in
/// the y-coordinate arithmetic.
#[must_use = "rendering produces a string the caller is expected to consume"]
pub fn render_svg(song: &IrealSong, _options: &RenderOptions) -> String {
    let layout = compute_layout(song);
    let mut out = String::new();
    out.push_str("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n");
    out.push_str(&format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"{PAGE_WIDTH}\" \
height=\"{PAGE_HEIGHT}\" viewBox=\"0 0 {PAGE_WIDTH} {PAGE_HEIGHT}\">\n"
    ));
    write_page_frame(&mut out);
    write_header(&mut out, song);
    write_grid(&mut out, song, &layout);
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
    // Always run the title through `escape_xml`, even on the
    // hard-coded fallback. Asymmetric sanitisation (one branch
    // escaped, one branch raw) is the structural defect class
    // `.claude/rules/sanitizer-security.md` calls out; routing both
    // branches through the same helper closes the future-localisation
    // hole even though "Untitled" itself contains no reserved chars.
    let raw_title = if song.title.is_empty() {
        "Untitled"
    } else {
        song.title.as_str()
    };
    let title_text = svg::escape_xml(raw_title);
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
    // `format_key` always returns a non-empty string (mode is
    // always present), so we unconditionally interpolate both;
    // the dead empty-key branch was removed to reflect the
    // structural invariant.
    let combined = format!("{style} \u{2022} {key}");
    svg::escape_xml(&combined)
}

fn format_key(song: &IrealSong) -> String {
    let root = song.key_signature.root;
    let note_glyph = note_glyph_or_fallback(root.note);
    let acc = match root.accidental {
        Accidental::Natural => "",
        Accidental::Flat => "\u{266D}",
        Accidental::Sharp => "\u{266F}",
    };
    let mode = match song.key_signature.mode {
        KeyMode::Major => "major",
        KeyMode::Minor => "minor",
    };
    format!("{note_glyph}{acc} {mode}")
}

/// Returns `note` if it is in the documented `'A'..='G'` uppercase
/// ASCII range, otherwise `'?'`. Single source of truth for the
/// out-of-range fallback shared between [`format_key`] and
/// [`crate::chord_typography::chord_to_typography`]'s root / bass
/// writers, so a future tightening of the rule (per
/// `.claude/rules/sanitizer-security.md` "security asymmetry")
/// only needs to change one site.
///
/// The AST documents `root.note` as `'A'..='G'` uppercase ASCII
/// but the field is `pub` and not validated at construction. A
/// malformed AST that flows in via direct field assignment still
/// produces a deterministic, non-malicious string — `'?'` is
/// visually distinct from any valid one and is unaffected by
/// [`crate::svg::escape_xml`].
pub(crate) fn note_glyph_or_fallback(note: char) -> char {
    if matches!(note, 'A'..='G') { note } else { '?' }
}

fn write_grid(out: &mut String, song: &IrealSong, layout: &Layout) {
    if layout.bars.is_empty() && layout.trailing_empties.is_empty() {
        return;
    }
    out.push_str("  <g class=\"bar-grid\">\n");
    for cell in &layout.bars {
        out.push_str(&format!(
            "    <rect x=\"{x}\" y=\"{y}\" width=\"{w}\" height=\"{h}\" \
fill=\"none\" stroke=\"black\" stroke-width=\"1\"/>\n",
            x = cell.x,
            y = cell.y,
            w = cell.width,
            h = cell.height,
        ));
        let chords = chords_for_bar(song, cell);
        write_bar_chord_text(out, cell, chords);
    }
    // Paint trailing empties AFTER all bars. With `fill="none"`
    // SVG rectangles, paint order is invisible today — but #2059
    // is expected to add bar-level barlines / repeat brackets
    // and may rely on cell painting being interleaved by row.
    // Document the contract so #2059 either preserves the
    // bars-then-empties order or migrates to a row-interleaved
    // emit pattern explicitly.
    for empty in &layout.trailing_empties {
        out.push_str(&format!(
            "    <rect x=\"{x}\" y=\"{y}\" width=\"{w}\" height=\"{h}\" \
fill=\"none\" stroke=\"black\" stroke-width=\"1\" class=\"empty\"/>\n",
            x = empty.x,
            y = empty.y,
            w = empty.width,
            h = empty.height,
        ));
    }
    out.push_str("  </g>\n");
}

fn chords_for_bar<'a>(song: &'a IrealSong, cell: &BarCoord) -> &'a [BarChord] {
    // The layout engine guarantees `section_index` and
    // `bar_index_in_section` are valid for the song that produced
    // it, but defensive `get` lookups keep the renderer crash-free
    // if a caller hand-rolls a `Layout` for a different song.
    song.sections
        .get(cell.section_index)
        .and_then(|s| s.bars.get(cell.bar_index_in_section))
        .map(|b| b.chords.as_slice())
        .unwrap_or(&[])
}

/// Emits one `<text>` element per bar containing typography
/// `<tspan>` runs — root + accidental at base size, quality /
/// extension(s) raised as superscript at a smaller size, slash +
/// bass returning to the base size on the original baseline.
///
/// Multi-chord bars (split bars) are rendered as a single
/// space-separated `<text>` whose children alternate per chord.
/// Beat-aware horizontal placement (one chord per beat slot)
/// requires bar-cell subdivision and is deferred to #2059.
fn write_bar_chord_text(out: &mut String, cell: &BarCoord, chords: &[BarChord]) {
    if chords.is_empty() {
        return;
    }
    // Apply the same per-bar truncation the previous flat
    // formatter did — without it an adversarial AST with
    // `usize::MAX/2` chords in one bar would OOM the renderer on a
    // single `<text>` element. The compile-time
    // `const_assert!(MAX_CHORDS_PER_BAR > 0)` in `page.rs` keeps
    // `chord_limit` non-zero whenever `chords` is non-empty, so no
    // additional zero-guard is needed here.
    let chord_limit = chords.len().min(page::MAX_CHORDS_PER_BAR);
    let text_x = cell.x + cell.width / 2;
    // Centre the chord text inside the cell. The 0.62 y-fraction
    // matches iReal Pro's baseline placement (slightly above
    // mid-cell) so the future barline overlay (#2059) sits
    // beneath without collision.
    let text_y = cell.y + (cell.height * 62) / 100;
    out.push_str(&format!(
        "    <text x=\"{text_x}\" y=\"{text_y}\" font-family=\"serif\" \
font-size=\"{base}\" text-anchor=\"middle\" class=\"chord\">",
        base = page::CHORD_FONT_SIZE_BASE,
    ));
    for (i, bc) in chords.iter().take(chord_limit).enumerate() {
        if i > 0 {
            // Inter-chord separator stays on the base baseline.
            out.push_str("<tspan>\u{00A0}</tspan>");
        }
        let typography = chord_typography::chord_to_typography(&bc.chord);
        write_chord_spans(out, &typography);
    }
    out.push_str("</text>\n");
}

fn write_chord_spans(out: &mut String, typography: &ChordTypography) {
    let mut prev_kind: Option<SpanKind> = None;
    for span in &typography.spans {
        let escaped = svg::escape_xml(&span.text);
        match span.kind {
            SpanKind::Root => {
                out.push_str(&format!("<tspan class=\"chord-root\">{escaped}</tspan>"));
            }
            SpanKind::Extension => {
                // Smaller font + raised baseline. `dy` is relative
                // to the previous span's baseline, so we only need
                // to apply the shift once on entry.
                out.push_str(&format!(
                    "<tspan class=\"chord-ext\" font-size=\"{size}\" dy=\"{dy}\">{escaped}</tspan>",
                    size = page::CHORD_FONT_SIZE_SUPERSCRIPT,
                    dy = page::CHORD_SUPERSCRIPT_DY,
                ));
            }
            SpanKind::Slash | SpanKind::Bass => {
                let class = if matches!(span.kind, SpanKind::Slash) {
                    "chord-slash"
                } else {
                    "chord-bass"
                };
                // If the previous span raised the baseline, return
                // it to the original via the inverse `dy` shift,
                // and restore the base font size.
                if matches!(prev_kind, Some(SpanKind::Extension)) {
                    let restore_dy = -page::CHORD_SUPERSCRIPT_DY;
                    out.push_str(&format!(
                        "<tspan class=\"{class}\" font-size=\"{base}\" dy=\"{restore_dy}\">{escaped}</tspan>",
                        base = page::CHORD_FONT_SIZE_BASE,
                    ));
                } else {
                    out.push_str(&format!("<tspan class=\"{class}\">{escaped}</tspan>"));
                }
            }
        }
        prev_kind = Some(span.kind);
    }
}

/// Returns the library version (the workspace `Cargo.toml`
/// `version` field, baked in at compile time).
#[must_use]
pub fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}
