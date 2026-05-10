//! iReal Pro chart renderer — SVG with chord-name typography,
//! repeat barlines, ending brackets, section labels, and music
//! symbols.
//!
//! This crate renders an [`chordsketch_ireal::IrealSong`] AST as a
//! fixed-size SVG document. The current scope covers the page
//! frame, the metadata header (title / composer / style / key),
//! the 4-bars-per-line grid with section line breaks, superscript
//! chord-name typography (root + accidental at base size, quality
//! / extensions raised as superscript, slash + bass back at base
//! size), repeat / final / double barline glyphs, N-th-ending
//! brackets with `1.` / `2.` labels, section-letter labels above
//! each section start, and music symbols (segno / coda glyphs;
//! `D.C.` / `D.S.` / `Fine` text directives) above the bar that
//! carries them. Tracked under
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
//!   base size on the original baseline. Bar boundaries display
//!   the appropriate barline glyph (`Single` via the cell-rect
//!   stroke; `Double`, `Final`, `OpenRepeat`, `CloseRepeat`
//!   overlay the cell stroke). N-th-ending brackets, section-
//!   letter labels, and music-symbol glyphs all sit above the
//!   row in the same band; music symbols are drawn last so they
//!   layer on top of any overlapping bracket. Trailing cells in a
//!   section's last row are filled with empty placeholders so the
//!   visible grid stays a clean rectangle.
//!
//! # Dependency policy
//!
//! Only depends on [`chordsketch_ireal`] for the AST. SVG
//! generation is hand-rolled — no `xmlwriter`, no `svg` crate, no
//! templating engine. Keeps the transitive-dep surface minimal and
//! mirrors the zero-external-dep posture of `chordsketch-chordpro`
//! / `chordsketch-ireal`.
//!
//! Enabling the `png` cargo feature additionally pulls in `resvg`
//! and `tiny-skia` for the `png::render_png` rasteriser; enabling
//! `pdf` pulls in `svg2pdf` for the `pdf::render_pdf` converter.
//! Both features are off by default; SVG-only consumers stay on
//! the single-dep build. (Inline code-spans — not intra-doc links —
//! because the `png` and `pdf` modules are `#[cfg(feature = ...)]`
//! and a crate-level rustdoc link would break the default-features
//! `cargo doc --no-deps` run that gates CI.)
//!
//! # Cargo features
//!
//! | Feature | Default? | Notes |
//! |---|---|---|
//! | `png` | off | Enables `png::render_png` (rasterises the SVG via `resvg`). |
//! | `pdf` | off | Enables `pdf::render_pdf` (converts the SVG to PDF via `svg2pdf`). |
//!
//! # Stability
//!
//! Pre-1.0. The SVG output structure is expected to grow new
//! elements as the iReal Pro tracker (#2050) closes its remaining
//! items. Existing elements stay stable so that crate consumers
//! (the playground preview, the PDF rasteriser #2063, the PNG
//! rasteriser #2064) can rely on a small set of stable selectors
//! / IDs (`class="title"`, `class="composer"`, `class="meta"`,
//! `class="bar-grid"`, `class="chord"`, `class="chord-root"`,
//! `class="chord-ext"`, `class="chord-slash"`, `class="chord-bass"`,
//! `class="empty"`, `class="section-label"`,
//! `class="ending-bracket"`, `class="ending-label"`,
//! `class="barline-double"`, `class="barline-final"`,
//! `class="barline-repeat-thick"`, `class="barline-repeat-thin"`,
//! `class="barline-repeat-dot"`, `class="music-symbol-segno"`,
//! `class="music-symbol-coda"`, `class="music-symbol-text"`).
//!
//! The previous segno / coda selector set
//! (`music-symbol-segno-curve` / `-slash` / `-dot` and
//! `music-symbol-coda-circle` / `-cross`) covered SVG-primitive
//! approximations and was removed when #2348 swapped in real
//! Bravura SMuFL outlines as a single `<path>` element each.
//! Stylesheets that previously targeted any of those selectors
//! should retarget to the consolidated
//! `class="music-symbol-segno"` / `class="music-symbol-coda"`,
//! which is now a single filled `<path>` per glyph (no stroke).
//! The crate is pre-1.0 so this is documented as a stability note
//! rather than a breaking-change deprecation cycle.
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

mod barlines;
mod bravura;
pub mod chord_typography;
pub mod layout;
mod markers;
mod music_symbols;
pub mod page;
#[cfg(feature = "pdf")]
pub mod pdf;
#[cfg(feature = "png")]
pub mod png;
mod svg;

use chordsketch_ireal::{Accidental, BarChord, IrealSong, KeyMode};

pub use chord_typography::{ChordTypography, SpanKind, TypographySpan, chord_to_typography};
pub use layout::{BarCoord, EmptyCell, Layout, compute_layout};
pub use page::{
    BAR_ROW_HEIGHT, BARS_PER_ROW, CHORD_FONT_SIZE_BASE, CHORD_FONT_SIZE_SUPERSCRIPT, GRID_TOP,
    HEADER_BAND_HEIGHT, MARGIN_X, MARGIN_Y, MAX_BARS, MAX_CHORDS_PER_BAR, MAX_SECTIONS,
    PAGE_HEIGHT, PAGE_WIDTH,
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
    // Pure white page; the engraved chart no longer paints a
    // black 1px frame around the entire SVG (it competed with the
    // chart's own barlines and read as "boxed", not "engraved").
    out.push_str(&format!(
        "  <rect x=\"0\" y=\"0\" width=\"{PAGE_WIDTH}\" height=\"{PAGE_HEIGHT}\" \
fill=\"white\"/>\n"
    ));
}

fn write_header(out: &mut String, song: &IrealSong) {
    // Three-column header band — italic Source-Serif style label
    // on the left, centred bold title, italic "Lead Sheet" tag on
    // the right. Mirrors the chart-card header in
    // `design-system/ui_kits/web/editor-irealb.html`.
    let header_top = MARGIN_Y;
    let center_y = header_top + 32;
    let raw_title = if song.title.is_empty() {
        "Untitled"
    } else {
        song.title.as_str()
    };
    let title_text = svg::escape_xml(raw_title);
    let center_x = PAGE_WIDTH / 2;
    // Header typography — Source Serif 4 italic for the (style) /
    // Lead Sheet / composer marks per
    // `design-system/ui_kits/web/editor-irealb.html`. The host
    // (playground / desktop / VS Code preview) loads the design-
    // system fonts via Google Fonts; the SVG falls back through
    // `serif` for environments that did not preload the family.
    let serif_stack = "'Source Serif 4', Georgia, serif";
    out.push_str(&format!(
        "  <text x=\"{center_x}\" y=\"{center_y}\" font-family=\"{serif_stack}\" \
font-weight=\"700\" font-size=\"22\" text-anchor=\"middle\" class=\"title\">{title_text}</text>\n"
    ));
    let style = song.style.as_deref().unwrap_or("Medium Swing");
    let style_text = svg::escape_xml(&format!("({style})"));
    out.push_str(&format!(
        "  <text x=\"{MARGIN_X}\" y=\"{center_y}\" font-family=\"{serif_stack}\" \
font-style=\"italic\" font-size=\"13\" class=\"meta\">{style_text}</text>\n"
    ));
    let lead_x = PAGE_WIDTH - MARGIN_X;
    out.push_str(&format!(
        "  <text x=\"{lead_x}\" y=\"{center_y}\" font-family=\"{serif_stack}\" \
font-style=\"italic\" font-size=\"13\" text-anchor=\"end\" class=\"lead-sheet\">Lead Sheet</text>\n"
    ));
    if let Some(composer) = song.composer.as_deref() {
        let escaped = svg::escape_xml(composer);
        out.push_str(&format!(
            "  <text x=\"{center_x}\" y=\"{composer_y}\" font-family=\"{serif_stack}\" \
font-size=\"12\" font-style=\"italic\" text-anchor=\"middle\" class=\"composer\">{escaped}</text>\n",
            composer_y = center_y + 18,
        ));
    }
    // Thin rule separating the header band from the chart body.
    let rule_y = header_top + page::HEADER_BAND_HEIGHT - 8;
    out.push_str(&format!(
        "  <line x1=\"{MARGIN_X}\" y1=\"{rule_y}\" x2=\"{rule_x2}\" y2=\"{rule_y}\" \
stroke=\"#E8E6EA\" stroke-width=\"1\"/>\n",
        rule_x2 = PAGE_WIDTH - MARGIN_X,
    ));
}

#[allow(dead_code)] // retained for future use; the engraved header no longer needs it.
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

#[allow(dead_code)] // retained for future use; the engraved header no longer needs it.
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

    // Group bars by row so we can decide which barline (left/right)
    // to draw per cell. The layout engine already groups via
    // `cell.y`; bars sharing a `y` belong to the same chart line.
    // The right-side barline of a bar that abuts another bar in the
    // same line is the LEFT side of its right neighbour, so we only
    // need to emit one barline per boundary.

    // First, paint barlines for filled cells. Each cell contributes
    // its left barline (single by default, or the kind the bar's
    // `start` field declares). The rightmost cell in a row also
    // contributes a right barline at its right edge.
    for (idx, cell) in layout.bars.iter().enumerate() {
        let bar = song
            .sections
            .get(cell.section_index)
            .and_then(|s| s.bars.get(cell.bar_index_in_section));
        let start_kind = bar
            .map(|b| b.start)
            .unwrap_or(chordsketch_ireal::BarLine::Single);
        let end_kind = bar
            .map(|b| b.end)
            .unwrap_or(chordsketch_ireal::BarLine::Single);
        out.push_str(&barlines::render_left_barline(cell, start_kind));
        // Emit the right barline only when no neighbour will paint
        // a left barline at the same x. The next filled cell with
        // the same `y` would do so; otherwise (end of row, end of
        // section, end of song) the right barline closes the bar.
        let next_filled_at_same_y = layout
            .bars
            .get(idx + 1)
            .is_some_and(|next| next.y == cell.y && next.x == cell.x + cell.width);
        if !next_filled_at_same_y {
            out.push_str(&barlines::render_right_barline(cell, end_kind));
        }
        let chords = chords_for_bar(song, cell);
        write_bar_chord_text(out, cell, chords, song.time_signature.numerator);
    }

    // Trailing empties stay invisible — the engraved chart
    // doesn't paint placeholder barlines past a section's last
    // real bar. The empties are still tracked so future renderers
    // (PDF / PNG #2063 / #2064) keep deterministic layout
    // boundaries; the `for` loop below is preserved as a no-op
    // to keep the layout-engine contract obvious.
    for _empty in &layout.trailing_empties {
        // intentionally empty — see comment above.
    }
    // Time signature on line 1.
    write_time_signature(out, song, layout);
    // Section labels (black-filled square with letter), ending
    // brackets, and music-symbol glyphs all sit ABOVE the cells in
    // the row's gap area. Paint them last so they layer above the
    // chord text. Music symbols come last so their glyphs sit on
    // top of any overlapping ending bracket.
    out.push_str(&markers::render_section_labels(song, layout));
    out.push_str(&markers::render_endings(song, layout));
    out.push_str(&music_symbols::render_music_symbols(song, layout));
    out.push_str("  </g>\n");
}

/// Stacked numerator/denominator at the very start of line 1, in
/// the reserved indent area before the first bar's left barline.
/// Renders only when the AST carries a non-default time signature
/// or always — iReal Pro charts always show the time signature on
/// line 1.
fn write_time_signature(out: &mut String, song: &IrealSong, layout: &Layout) {
    let Some(first) = layout.bars.first() else {
        return;
    };
    let num = song.time_signature.numerator;
    let denom = song.time_signature.denominator;
    // Centre the digits in the indent area immediately to the left
    // of the first bar's barline, vertically centred against the
    // bar's chord row.
    let cx = first.x - 14;
    let cy = first.y + first.height / 2;
    let num_y = cy - 4;
    let denom_y = cy + 14;
    out.push_str(&format!(
        "    <text x=\"{cx}\" y=\"{num_y}\" font-family=\"serif\" \
font-weight=\"700\" font-size=\"16\" text-anchor=\"middle\" class=\"time-sig-num\">{num}</text>\n"
    ));
    out.push_str(&format!(
        "    <line x1=\"{x1}\" y1=\"{y}\" x2=\"{x2}\" y2=\"{y}\" \
stroke=\"black\" stroke-width=\"1\" class=\"time-sig-rule\"/>\n",
        x1 = cx - 6,
        x2 = cx + 6,
        y = cy + 1,
    ));
    out.push_str(&format!(
        "    <text x=\"{cx}\" y=\"{denom_y}\" font-family=\"serif\" \
font-weight=\"700\" font-size=\"16\" text-anchor=\"middle\" class=\"time-sig-denom\">{denom}</text>\n"
    ));
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
/// requires bar-cell subdivision and is deferred to a follow-up
/// of the iReal Pro tracker (#2050).
/// Beat-positioned chord typography.
///
/// editor-irealb.html lays each bar out as a 4-column metric grid
/// (one column per beat in 4/4); chords with `position.beat = N`
/// land in column N. We approximate the same here: a bar's chord
/// list is mapped onto `time_signature.numerator` equal slots, each
/// chord's slot derived from its `position.beat` (clamped to the
/// numerator), and emitted as one `<text>` element per chord with
/// its own `x` anchor. This produces the metric placement the
/// reference shows without requiring full grid lines.
fn write_bar_chord_text(out: &mut String, cell: &BarCoord, chords: &[BarChord], beats_per_bar: u8) {
    if chords.is_empty() {
        return;
    }
    let chord_limit = chords.len().min(page::MAX_CHORDS_PER_BAR);
    let beats = beats_per_bar.max(1) as i32;
    // Inset the beat columns inside the bar so glyphs don't kiss
    // the barlines. 6 px on each side keeps the chord ink clear of
    // the 1 px barline strokes at the bar boundaries.
    let inner_left = cell.x + 8;
    let inner_right = cell.x + cell.width - 4;
    let inner_w = (inner_right - inner_left).max(0);
    // Chord baseline sits ~62 % of the way down the bar so the
    // engraved cap-line lands roughly at the bar's centre and the
    // descender clears the lower barline area.
    let base_y = cell.y + (cell.height * 62) / 100;
    // Distribution strategy:
    //
    //   * exactly-one-chord bar → place it at the chord's beat,
    //     defaulting to beat 1 (the leftmost slot).
    //   * multiple chords at distinct beats → place each at its
    //     own beat slot.
    //   * multiple chords sharing a beat (or more chords than
    //     beats — common for irealb URLs that pack 4 chords into a
    //     3/4 bar without explicit beat data) → fall back to
    //     even-spaced index distribution.
    //
    // Compact-mode horizontal scale (~70 %) kicks in whenever the
    // chord count exceeds the beat count so dense bars stay
    // legible.
    let unique_beats: std::collections::BTreeSet<i32> = chords
        .iter()
        .take(chord_limit)
        .map(|bc| bc.position.beat.get() as i32)
        .collect();
    let by_beat = chord_limit <= beats as usize && unique_beats.len() == chord_limit;
    let compact = (chord_limit as i32) > beats || !by_beat;
    let scale_pct: f32 = if compact { 0.7 } else { 1.0 };
    for (i, bc) in chords.iter().take(chord_limit).enumerate() {
        let slot = if by_beat {
            let beat = bc.position.beat.get() as i32;
            ((beat - 1) * inner_w) / beats
        } else {
            ((i as i32) * inner_w) / (chord_limit as i32)
        };
        let chord_x = inner_left + slot;
        let transform_attr = if compact {
            // SVG transforms compose right-to-left around the
            // origin: pre-translate to the anchor, scale, then
            // un-translate so the chord stays centred on its slot.
            format!(
                " transform=\"translate({chord_x} 0) scale({scale_pct} 1) translate({negx} 0)\"",
                negx = -chord_x,
            )
        } else {
            String::new()
        };
        out.push_str(&format!(
            "    <text x=\"{chord_x}\" y=\"{base_y}\" font-family=\"Roboto, sans-serif\" \
font-weight=\"700\" font-size=\"{base}\" class=\"chord\"{transform_attr}>",
            base = page::CHORD_FONT_SIZE_BASE,
        ));
        let typography = chord_typography::chord_to_typography(&bc.chord);
        write_chord_spans(out, &typography);
        out.push_str("</text>\n");
    }
}

fn write_chord_spans(out: &mut String, typography: &ChordTypography) {
    // Cumulative `dy` cursor position. SVG `dy` is relative to the
    // previous span's baseline, so each transition between baseline
    // states must emit the inverse of the previous shift before
    // applying the new one. Tracking the current offset keeps that
    // accounting honest across Root → Accidental → Extension →
    // Slash → Bass → Accidental sequences.
    let mut current_dy: i32 = 0;
    let acc_dy = page::CHORD_ACCIDENTAL_DY;
    let qual_dy = page::CHORD_QUALITY_DY;
    for span in &typography.spans {
        let escaped = svg::escape_xml(&span.text);
        match span.kind {
            SpanKind::Root => {
                let restore = -current_dy;
                let dy_attr = if restore == 0 {
                    String::new()
                } else {
                    format!(
                        " font-size=\"{base}\" dy=\"{restore}\"",
                        base = page::CHORD_FONT_SIZE_BASE
                    )
                };
                out.push_str(&format!(
                    "<tspan class=\"chord-root\"{dy_attr}>{escaped}</tspan>"
                ));
                current_dy = 0;
            }
            SpanKind::Accidental => {
                // Smaller font + raised baseline so the sharp / flat
                // sits as a superscript next to the root letter.
                let target = acc_dy;
                let shift = target - current_dy;
                out.push_str(&format!(
                    "<tspan class=\"chord-acc\" font-size=\"{size}\" dy=\"{shift}\">{escaped}</tspan>",
                    size = page::CHORD_FONT_SIZE_ACCIDENTAL,
                ));
                current_dy = target;
            }
            SpanKind::Extension => {
                // Smaller font + slight subscript so the quality
                // hangs just below the chord baseline, matching
                // editor-irealb.html's `vertical-align: -0.15em`.
                let target = qual_dy;
                let shift = target - current_dy;
                out.push_str(&format!(
                    "<tspan class=\"chord-ext\" font-size=\"{size}\" dy=\"{shift}\">{escaped}</tspan>",
                    size = page::CHORD_FONT_SIZE_SUPERSCRIPT,
                ));
                current_dy = target;
            }
            SpanKind::Slash => {
                let restore = -current_dy;
                let attrs = if restore == 0 {
                    String::new()
                } else {
                    format!(
                        " font-size=\"{base}\" dy=\"{restore}\"",
                        base = page::CHORD_FONT_SIZE_BASE
                    )
                };
                out.push_str(&format!(
                    "<tspan class=\"chord-slash\"{attrs}>{escaped}</tspan>"
                ));
                current_dy = 0;
            }
            SpanKind::Bass => {
                let restore = -current_dy;
                let attrs = if restore == 0 {
                    String::new()
                } else {
                    format!(
                        " font-size=\"{base}\" dy=\"{restore}\"",
                        base = page::CHORD_FONT_SIZE_BASE
                    )
                };
                out.push_str(&format!(
                    "<tspan class=\"chord-bass\"{attrs}>{escaped}</tspan>"
                ));
                current_dy = 0;
            }
        }
    }
}

/// Returns the library version (the workspace `Cargo.toml`
/// `version` field, baked in at compile time).
#[must_use]
pub fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}
