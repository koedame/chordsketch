//! SVG chord diagram generator.
//!
//! Generates inline SVG chord diagram strings from chord definition data.
//! The diagrams show fret positions, open/muted strings, and finger numbers
//! for fretted string instruments.
//!
//! # Examples
//!
//! ```
//! use chordsketch_chordpro::chord_diagram::{DiagramData, render_svg};
//!
//! let data = DiagramData {
//!     name: "Am".to_string(),
//!     display_name: None,
//!     strings: 6,
//!     frets_shown: 5,
//!     base_fret: 1,
//!     frets: vec![-1, 0, 2, 2, 1, 0],
//!     fingers: vec![],
//! };
//! let svg = render_svg(&data);
//! assert!(svg.contains("<svg"));
//! assert!(svg.contains("Am"));
//! ```

/// Minimum number of strings for a valid chord diagram.
pub const MIN_STRINGS: usize = 2;

/// Maximum number of strings for a valid chord diagram (covers 12-string guitar).
pub const MAX_STRINGS: usize = 12;

/// Default number of frets shown in a chord diagram.
pub const DEFAULT_FRETS_SHOWN: usize = 5;

/// Maximum allowed `base_fret` value (typical 24-fret guitar).
pub const MAX_BASE_FRET: u32 = 24;

/// Minimum number of frets shown in a rendered chord diagram.
pub const MIN_FRETS_SHOWN: usize = 1;

/// Maximum number of frets shown in a rendered chord diagram (24-fret instrument).
pub const MAX_FRETS_SHOWN: usize = 24;

/// Data needed to render a chord diagram.
#[derive(Debug, Clone)]
pub struct DiagramData {
    /// Chord name (identifier used for matching).
    pub name: String,
    /// Display name override from `{define}` `display` attribute.
    ///
    /// When present, diagram titles should show this instead of `name`.
    pub display_name: Option<String>,
    /// Number of strings (e.g., 6 for guitar, 4 for ukulele).
    ///
    /// Valid range: 2–12 (enforced by [`from_raw`](Self::from_raw)).
    pub strings: usize,
    /// Number of frets shown in the diagram.
    pub frets_shown: usize,
    /// The base fret (1 = open position, >1 shows fret number).
    pub base_fret: u32,
    /// Fret values for each string: -1 = muted (x), 0 = open, 1+ = fret number.
    ///
    /// Positive values are clamped to `frets_shown` to prevent rendering
    /// outside the visible grid.
    pub frets: Vec<i32>,
    /// Optional finger numbers for each string (0 = none).
    pub fingers: Vec<u8>,
}

impl DiagramData {
    /// Returns the title to display above the diagram.
    ///
    /// Uses the `display_name` override if present, otherwise falls back to `name`.
    #[must_use]
    pub fn title(&self) -> &str {
        self.display_name.as_deref().unwrap_or(&self.name)
    }
}

impl DiagramData {
    /// Parse fretted chord data from a raw definition string, inferring the
    /// string count from the number of fret values provided.
    ///
    /// This is equivalent to calling [`from_raw`](Self::from_raw) with
    /// `num_strings` set to `0`, so the actual fret count determines the
    /// number of strings in the diagram.
    #[must_use]
    pub fn from_raw_infer(name: &str, raw: &str) -> Option<Self> {
        Self::from_raw(name, raw, 0)
    }

    /// Like [`from_raw_infer`](Self::from_raw_infer) but uses a custom
    /// `frets_shown` value instead of the default (5).
    #[must_use]
    pub fn from_raw_infer_frets(name: &str, raw: &str, frets_shown: usize) -> Option<Self> {
        Self::from_raw_frets(name, raw, 0, frets_shown)
    }

    /// Parse fretted chord data from a `ChordDefinition` raw string.
    ///
    /// Expected format: `base-fret N frets f1 f2 ... [fingers g1 g2 ...]`
    /// where fret values are numbers or `x`/`X` for muted strings.
    ///
    /// `num_strings` sets a minimum string count; the actual count will be
    /// the maximum of this value and the number of fret values parsed.
    ///
    /// Returns `None` if:
    /// - No fret values are provided
    /// - The resulting string count is outside the valid range (2–12)
    ///
    /// Positive fret values exceeding `frets_shown` are clamped to
    /// prevent rendering outside the visible grid. Uses the default
    /// frets shown value ([`DEFAULT_FRETS_SHOWN`]).
    #[must_use]
    pub fn from_raw(name: &str, raw: &str, num_strings: usize) -> Option<Self> {
        Self::from_raw_frets(name, raw, num_strings, DEFAULT_FRETS_SHOWN)
    }

    /// Like [`from_raw`](Self::from_raw) but uses a custom `frets_shown`
    /// value instead of the default.
    ///
    /// The keywords `display` and `format` act as stop-words that terminate
    /// fret and finger value parsing when encountered as tokens.
    #[must_use]
    pub fn from_raw_frets(
        name: &str,
        raw: &str,
        num_strings: usize,
        frets_shown: usize,
    ) -> Option<Self> {
        let mut base_fret: u32 = 1;
        let mut frets: Vec<i32> = Vec::new();
        let mut fingers: Vec<u8> = Vec::new();

        let tokens: Vec<&str> = raw.split_whitespace().collect();
        let mut i = 0;
        while i < tokens.len() {
            let tok_lower = tokens[i].to_ascii_lowercase();
            match tok_lower.as_str() {
                "base-fret" if i + 1 < tokens.len() => {
                    base_fret = tokens[i + 1].parse().unwrap_or(1).clamp(1, MAX_BASE_FRET);
                    i += 2;
                }
                "base-fret" => {
                    i += 1;
                }
                "frets" => {
                    i += 1;
                    while i < tokens.len() {
                        let low = tokens[i].to_ascii_lowercase();
                        if matches!(
                            low.as_str(),
                            "frets" | "fingers" | "base-fret" | "display" | "format"
                        ) {
                            break;
                        }
                        let val = match low.as_str() {
                            "x" | "n" => -1,
                            s => {
                                let v = s.parse::<i32>().unwrap_or(-1);
                                if v < -1 { -1 } else { v }
                            }
                        };
                        frets.push(val);
                        i += 1;
                    }
                }
                "fingers" => {
                    i += 1;
                    while i < tokens.len() {
                        let low = tokens[i].to_ascii_lowercase();
                        if matches!(
                            low.as_str(),
                            "frets" | "fingers" | "base-fret" | "display" | "format"
                        ) {
                            break;
                        }
                        // Stop finger parsing on any token that is not a
                        // valid `u8`. Previously this used `unwrap_or(0)`,
                        // which silently mapped overflow values like `256`
                        // and garbage tokens like `abc` to `0` — the same
                        // sentinel that means "no finger shown" — so a
                        // typo in a ChordPro `fingers` list would silently
                        // produce a visually plausible but wrong diagram.
                        // See code-style.md §Silent Fallback.
                        let Ok(n) = tokens[i].parse::<u8>() else {
                            break;
                        };
                        fingers.push(n);
                        i += 1;
                    }
                }
                _ => {
                    i += 1;
                }
            }
        }

        if frets.is_empty() {
            return None;
        }

        let strings = num_strings.max(frets.len());

        // Validate string count is within reasonable range.
        if !(MIN_STRINGS..=MAX_STRINGS).contains(&strings) {
            return None;
        }

        // Clamp frets_shown to the valid range, mirroring base_fret clamping.
        let frets_shown = frets_shown.clamp(MIN_FRETS_SHOWN, MAX_FRETS_SHOWN);

        // Clamp positive fret values to the visible range to prevent
        // rendering dots outside the fret grid.
        let frets: Vec<i32> = frets
            .into_iter()
            .map(|f| {
                if f > frets_shown as i32 {
                    frets_shown as i32
                } else {
                    f
                }
            })
            .collect();

        Some(Self {
            name: name.to_string(),
            display_name: None,
            strings,
            frets_shown,
            base_fret,
            frets,
            fingers,
        })
    }
}

// ---------------------------------------------------------------------------
// Orientation
// ---------------------------------------------------------------------------

/// Layout orientation for fretted-instrument chord diagrams.
///
/// `Vertical` is the Western convention (nut on top, fretboard running
/// downward) that ChordPro renderers have always emitted. `Horizontal` (nut
/// on the left, fretboard running rightward) is the convention used in many
/// Japanese tablature publications; see ADR-0026 for the corpus the decision
/// referenced.
///
/// The horizontal layout is reader-view only — high pitch on top, matching
/// the six-line tablature stave order so a reader fluent with tab parses
/// the diagram with no mental flip. The historical player-view alternative
/// (low pitch on top, mirroring what a right-handed player sees looking
/// down at the instrument) is intentionally not offered as a knob; see
/// ADR-0026 for the rationale.
///
/// The enum is `#[non_exhaustive]` so future layout variants (e.g.
/// `HorizontalLefty` with the nut on the right) can be added without an
/// API break.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
#[non_exhaustive]
pub enum Orientation {
    /// Vertical layout — nut on top, frets running downward. Default.
    #[default]
    Vertical,
    /// Horizontal layout — nut on the left, frets running rightward,
    /// high pitch on top.
    Horizontal,
}

/// Physical size of a rendered chord diagram.
///
/// `Regular` is the original full-size diagram suited to the
/// end-of-song diagram grid. `Compact` is a chordsketch extension
/// laid out for sitting directly above a lyric line (the
/// `{diagrams: inline}` / `{diagrams: hover}` modes): the grid
/// geometry is shrunk substantially while the chord-name title and
/// the finger / open / muted glyphs are kept near their legibility
/// floor — a separate layout rather than a CSS `transform: scale()`,
/// which would shrink the text into illegibility along with the
/// geometry.
///
/// The enum is `#[non_exhaustive]` so a future intermediate size can
/// be added without an API break, mirroring [`Orientation`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
#[non_exhaustive]
pub enum DiagramSize {
    /// Full-size diagram — the original layout. Default.
    #[default]
    Regular,
    /// Compact layout for diagrams shown above a lyric line.
    Compact,
}

// ---------------------------------------------------------------------------
// SVG rendering constants
// ---------------------------------------------------------------------------

/// Cell width in SVG user units (pixels at 1:1 zoom).
///
/// Intentionally larger than the PDF renderer's 10.0 pt because SVG
/// diagrams target on-screen display where more generous spacing
/// improves readability. The PDF renderer uses smaller values (10x12 pt)
/// suited for printed page layout.
const CELL_W: f32 = 16.0;
/// Cell height in SVG user units. See [`CELL_W`] for rationale.
const CELL_H: f32 = 20.0;
const TOP_MARGIN: f32 = 30.0;
const LEFT_MARGIN: f32 = 20.0;
const DOT_RADIUS: f32 = 5.0;
const OPEN_RADIUS: f32 = 4.0;
/// Faint inlay-marker dot radius. Smaller and lighter than the
/// finger-position dots so it sits behind the chord shape
/// without competing for attention.
const POSITION_DOT_RADIUS: f32 = 2.2;
/// Distance from the nut at which open / muted single-string glyphs
/// sit. In the vertical renderer this is the vertical offset
/// `nut_y - 10.0` (above the nut); in the horizontal renderer it is
/// the analogous horizontal offset `nut_x - 10.0` (left of the nut).
/// Pinned at 10 SVG-pixels so glyphs clear the nut line + stroke
/// width without colliding with the chord title text above.
const NUT_MARGIN_GLYPH_OFFSET: f32 = 10.0;
/// Fraction of `CELL_W` / `CELL_H` by which the 12-fret octave inlay's
/// two dots offset from their cell centre. Slightly past the half-cell
/// (0.50) so the gap reads as "two dots" rather than "one dot wider
/// than usual" at typical viewing scales. The same factor is used in
/// both the vertical (along the x-axis) and horizontal (along the
/// y-axis) renderers so the visual weight stays consistent.
const OCTAVE_DOUBLE_DOT_OFFSET: f32 = 0.55;

/// All size-dependent measurements for one fretted-diagram render pass.
///
/// The vertical and horizontal renderers read every geometry value and
/// font size from this struct instead of the module-level constants
/// directly, so the only difference between a [`DiagramSize::Regular`] and
/// a [`DiagramSize::Compact`] render is which constructor
/// ([`regular`](Self::regular) / [`compact`](Self::compact)) built the
/// metrics. This keeps the two size variants from forking into duplicate
/// renderer functions — a geometry fix lands once and applies to both
/// sizes (cf. `.claude/rules/fix-propagation.md`).
///
/// `regular()` reproduces the historical hard-coded values verbatim; the
/// `render_svg_default_byte_identical_across_chord_shapes` test pins that
/// the regular output is byte-for-byte unchanged by this indirection.
#[derive(Debug, Clone, Copy)]
struct DiagramMetrics {
    /// String-to-string spacing (SVG x-axis in vertical mode).
    cell_w: f32,
    /// Fret pitch (SVG y-axis in vertical mode).
    cell_h: f32,
    /// Space above the nut for the title + open/muted glyph row.
    top_margin: f32,
    /// Side gutter on each edge.
    left_margin: f32,
    /// Padding below the grid in the vertical layout.
    bottom_pad_vertical: f32,
    /// Padding below the grid in the horizontal layout.
    bottom_pad_horizontal: f32,
    /// Filled finger-position dot radius.
    dot_radius: f32,
    /// Open-string ring radius.
    open_radius: f32,
    /// Faint fretboard-inlay dot radius.
    position_dot_radius: f32,
    /// Distance from the nut at which open / muted glyphs sit.
    nut_margin_glyph_offset: f32,
    /// Chord-name title font size.
    title_font: f32,
    /// Baseline y of the chord-name title text.
    title_baseline: f32,
    /// Font size for the base-fret label and the muted-string `X` glyph.
    label_font: f32,
    /// Font size for finger numbers inside the dots.
    finger_font: f32,
    /// Baseline-centring offset added to a marker's centre y when drawing
    /// text on/near it (the historical `+ 3.0`).
    text_v_center: f32,
    /// Nut line stroke width.
    nut_stroke: f32,
    /// String / fret line stroke width.
    line_stroke: f32,
    /// Extra CSS class appended to the root `<svg>` `class` attribute
    /// (empty for regular, `" chord-diagram-compact"` for compact).
    class_extra: &'static str,
    /// Whether to draw a fret-number label at every fret line across the
    /// visible window (the absolute fret number `base_fret - 1 + j`).
    ///
    /// `true` for the regular size — the full axis subsumes the legacy
    /// single base-fret label. `false` for the compact size, which keeps
    /// the minimal single base-fret label so the above-a-lyric layout
    /// stays uncluttered (see [`DiagramSize::Compact`]).
    show_fret_numbers: bool,
}

impl DiagramMetrics {
    /// Full-size metrics — byte-for-byte the historical layout.
    const fn regular() -> Self {
        Self {
            cell_w: CELL_W,
            cell_h: CELL_H,
            top_margin: TOP_MARGIN,
            left_margin: LEFT_MARGIN,
            bottom_pad_vertical: 30.0,
            bottom_pad_horizontal: 20.0,
            dot_radius: DOT_RADIUS,
            open_radius: OPEN_RADIUS,
            position_dot_radius: POSITION_DOT_RADIUS,
            nut_margin_glyph_offset: NUT_MARGIN_GLYPH_OFFSET,
            title_font: 14.0,
            title_baseline: 15.0,
            label_font: 10.0,
            finger_font: 8.0,
            text_v_center: 3.0,
            nut_stroke: 3.0,
            line_stroke: 1.0,
            class_extra: "",
            show_fret_numbers: true,
        }
    }

    /// Compact metrics for diagrams shown directly above a lyric line
    /// (the `{diagrams: inline}` / `{diagrams: hover}` chordsketch modes).
    ///
    /// Grid geometry shrinks to roughly 0.55x of regular, but the glyph
    /// fonts shrink only to ~0.8x and never below a legibility floor
    /// (title 11, fingers 7). That divergence is the whole reason a
    /// compact layout exists rather than a CSS `transform: scale()`,
    /// which would shrink the text into illegibility along with the
    /// geometry. `top_margin` is kept generous enough (22) that the
    /// title and the open/muted glyph row do not collide.
    const fn compact() -> Self {
        Self {
            cell_w: 9.0,
            cell_h: 11.0,
            top_margin: 22.0,
            left_margin: 9.0,
            bottom_pad_vertical: 10.0,
            bottom_pad_horizontal: 8.0,
            dot_radius: 3.2,
            open_radius: 2.6,
            position_dot_radius: 1.4,
            nut_margin_glyph_offset: 5.0,
            title_font: 11.0,
            title_baseline: 9.0,
            label_font: 8.0,
            finger_font: 7.0,
            text_v_center: 2.4,
            nut_stroke: 2.0,
            line_stroke: 0.75,
            class_extra: " chord-diagram-compact",
            // Compact diagrams sit directly above a lyric line where a full
            // fret-number axis would add clutter and height; keep the legacy
            // single base-fret label instead.
            show_fret_numbers: false,
        }
    }

    /// Metrics for the requested [`DiagramSize`].
    const fn for_size(size: DiagramSize) -> Self {
        match size {
            DiagramSize::Regular => Self::regular(),
            DiagramSize::Compact => Self::compact(),
        }
    }
}

/// Fretboard position-marker frets for the given instrument
/// (number of strings). Western guitar (6 strings) has inlays
/// at 3, 5, 7, 9, 12, 15, 17, 19, 21. Ukulele (4 strings) has
/// inlays at 3, 5, 7, 10, 12, 15. Other string counts get no
/// inlays — chord diagrams for non-standard instruments stay
/// clean.
fn position_marker_frets(strings: usize) -> &'static [u8] {
    match strings {
        6 => &[3, 5, 7, 9, 12, 15, 17, 19, 21],
        4 => &[3, 5, 7, 10, 12, 15],
        _ => &[],
    }
}

/// Render a chord diagram as an inline SVG string in the default
/// (vertical) orientation.
///
/// Equivalent to calling [`render_svg_with_orientation`] with
/// `Orientation::Vertical` — kept for backward compatibility with every
/// pre-existing caller.
#[must_use]
pub fn render_svg(data: &DiagramData) -> String {
    render_svg_with_orientation(data, Orientation::Vertical)
}

/// Render a chord diagram as an inline SVG string in the specified
/// orientation.
///
/// `Orientation::Horizontal` is reader-view only (high pitch on top); the
/// variant is a unit case and carries no row-order parameter — see ADR-0026.
///
/// # Examples
///
/// ```
/// use chordsketch_chordpro::chord_diagram::{
///     DiagramData, Orientation, render_svg_with_orientation,
/// };
///
/// let data = DiagramData {
///     name: "Am".to_string(),
///     display_name: None,
///     strings: 6,
///     frets_shown: 5,
///     base_fret: 1,
///     frets: vec![-1, 0, 2, 2, 1, 0],
///     fingers: vec![],
/// };
/// let svg = render_svg_with_orientation(&data, Orientation::Horizontal);
/// assert!(svg.contains("chord-diagram-horizontal"));
/// ```
#[must_use]
pub fn render_svg_with_orientation(data: &DiagramData, orientation: Orientation) -> String {
    render_svg_with_options(data, orientation, DiagramSize::Regular)
}

/// Render a chord diagram as an inline SVG string with explicit
/// orientation and [size](DiagramSize).
///
/// [`render_svg`] and [`render_svg_with_orientation`] are thin wrappers
/// that call this with [`DiagramSize::Regular`]; pass
/// [`DiagramSize::Compact`] for the smaller above-a-lyric layout used by
/// the `{diagrams: inline}` / `{diagrams: hover}` modes. The compact SVG
/// carries an extra `chord-diagram-compact` class on its root element so
/// consumers can target it from CSS.
///
/// Returns an empty string when `data.strings` or `data.frets_shown` is
/// outside the valid range (same guard as the other entry points).
///
/// # Examples
///
/// ```
/// use chordsketch_chordpro::chord_diagram::{
///     DiagramData, DiagramSize, Orientation, render_svg_with_options,
/// };
///
/// let data = DiagramData {
///     name: "Am".to_string(),
///     display_name: None,
///     strings: 6,
///     frets_shown: 5,
///     base_fret: 1,
///     frets: vec![-1, 0, 2, 2, 1, 0],
///     fingers: vec![],
/// };
/// let svg = render_svg_with_options(&data, Orientation::Vertical, DiagramSize::Compact);
/// assert!(svg.contains("chord-diagram-compact"));
/// ```
#[must_use]
pub fn render_svg_with_options(
    data: &DiagramData,
    orientation: Orientation,
    size: DiagramSize,
) -> String {
    if data.strings < MIN_STRINGS
        || data.strings > MAX_STRINGS
        || data.frets_shown < MIN_FRETS_SHOWN
        || data.frets_shown > MAX_FRETS_SHOWN
        // `base_fret` is a public field, so a directly-constructed
        // `DiagramData` can carry an out-of-range value the parser would
        // have clamped. Reject it here the same way `strings` / `frets_shown`
        // are rejected, so the fret-number axis cannot emit a negative label
        // (`base_fret - 1` for `base_fret == 0`) or an absurd one.
        || data.base_fret < 1
        || data.base_fret > MAX_BASE_FRET
    {
        return String::new();
    }
    let metrics = DiagramMetrics::for_size(size);
    // Exhaustive inside the defining crate — `#[non_exhaustive]` only forces
    // a wildcard on downstream consumers (see `render-pdf`). Adding a new
    // `Orientation` variant fails compilation here until a layout is added.
    match orientation {
        Orientation::Vertical => render_svg_vertical_inner(data, &metrics),
        Orientation::Horizontal => render_svg_horizontal_inner(data, &metrics),
    }
}

fn render_svg_vertical_inner(data: &DiagramData, m: &DiagramMetrics) -> String {
    // Bind every metric to a local so the SVG format strings can
    // inline-capture them by name (`{cell_w}` etc.). With
    // `DiagramMetrics::regular()` these reproduce the historical literals
    // exactly — guarded by `render_svg_default_byte_identical_across_chord_shapes`.
    let DiagramMetrics {
        cell_w,
        cell_h,
        top_margin,
        left_margin,
        bottom_pad_vertical,
        dot_radius,
        open_radius,
        position_dot_radius,
        nut_margin_glyph_offset,
        title_font,
        title_baseline,
        label_font,
        finger_font,
        text_v_center,
        nut_stroke,
        line_stroke,
        class_extra,
        show_fret_numbers,
        ..
    } = *m;

    let num_strings = data.strings;
    let num_frets = data.frets_shown;
    let grid_w = (num_strings - 1) as f32 * cell_w;
    let grid_h = num_frets as f32 * cell_h;
    let total_w = grid_w + left_margin * 2.0;
    let total_h = grid_h + top_margin + bottom_pad_vertical;

    let mut svg = format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"{total_w}\" height=\"{total_h}\" \
         viewBox=\"0 0 {total_w} {total_h}\" class=\"chord-diagram{class_extra}\">\n"
    );

    // Chord name (uses display override if present)
    let name_x = left_margin + grid_w / 2.0;
    svg.push_str(&format!(
        "<text x=\"{name_x}\" y=\"{title_baseline}\" text-anchor=\"middle\" \
         font-family=\"sans-serif\" font-size=\"{title_font}\" font-weight=\"bold\">{}</text>\n",
        crate::escape::escape_xml(data.title())
    ));

    // Nut (open position) or, for the compact size only, a single bare
    // base-fret label (no "fr" suffix). The regular size labels the base
    // fret as part of the full fret-number axis drawn below, so it needs no
    // standalone label here; the position-marker dots already imply "this is
    // fret N on a real fretboard".
    let nut_y = top_margin;
    if data.base_fret == 1 {
        svg.push_str(&format!(
            "<line x1=\"{left_margin}\" y1=\"{nut_y}\" x2=\"{}\" y2=\"{nut_y}\" \
             stroke=\"black\" stroke-width=\"{nut_stroke}\"/>\n",
            left_margin + grid_w
        ));
    } else if !show_fret_numbers {
        // Compact size keeps the legacy single base-fret label. The regular
        // size draws the full fret-number axis below, which already labels
        // the first visible fret, so the standalone label would duplicate it.
        svg.push_str(&format!(
            "<text x=\"{}\" y=\"{}\" text-anchor=\"end\" \
             font-family=\"sans-serif\" font-size=\"{label_font}\">{}</text>\n",
            left_margin - 4.0,
            nut_y + cell_h / 2.0 + text_v_center,
            data.base_fret
        ));
    }

    // Fret-number axis: label every fret line in the visible window with its
    // absolute fret number (`base_fret - 1 + j`), so fret line 0 is the
    // nut/open position (labelled 0 when the diagram starts at the nut). The
    // labels sit left of the grid; `text-anchor="end"` fixes their right edge
    // at `left_margin - 4`, so 1- and 2-digit numbers align without any
    // width math (unlike the PDF renderer, whose left-anchored text engine
    // has to subtract an estimated glyph width). They stay inside the
    // existing left margin, so the diagram's bounding box is unchanged. A
    // `fret-number` class is emitted so consumers can restyle or hide the
    // axis via CSS.
    if show_fret_numbers {
        for j in 0..=num_frets {
            let fret_number = data.base_fret as i32 - 1 + j as i32;
            let y = nut_y + j as f32 * cell_h + text_v_center;
            svg.push_str(&format!(
                "<text x=\"{}\" y=\"{y}\" text-anchor=\"end\" \
                 font-family=\"sans-serif\" font-size=\"{label_font}\" \
                 class=\"fret-number\">{fret_number}</text>\n",
                left_margin - 4.0,
            ));
        }
    }

    // Fretboard position-marker inlays (faint dots between the
    // strings, at the conventional fingerboard inlay frets).
    // Drawn BEFORE the strings + finger dots so the inlays sit
    // behind the visible chord diagram. The chosen frets follow
    // standard western guitar / ukulele inlay layouts (3, 5, 7,
    // 9, 12, 15, 17, 19, 21 for guitar; 3, 5, 7, 10, 12, 15 for
    // ukulele). The octave fret (12) gets a double dot on both
    // instruments to match real fretboard markers.
    let position_frets = position_marker_frets(num_strings);
    let center_x = left_margin + grid_w / 2.0;
    for &marker_fret in position_frets {
        // `marker_fret` is the absolute fret number on the real
        // fretboard. Convert to a row within the diagram by
        // subtracting `base_fret` (the topmost visible fret) and
        // adding 1 — so an Am chord at fret 1 shows the dot at
        // visible row 3 / 5 / 7 etc., while a barre chord with
        // base_fret = 5 shows the same absolute fret 7 inlay at
        // visible row 3.
        if (marker_fret as i32) < data.base_fret as i32 {
            continue;
        }
        let row = (marker_fret as i32) - (data.base_fret as i32) + 1;
        if row < 1 || row > num_frets as i32 {
            continue;
        }
        let y = nut_y + (row as f32 - 0.5) * cell_h;
        if marker_fret == 12 {
            // Octave: double dot. Place on either side of the
            // diagram's horizontal centre.
            svg.push_str(&format!(
                "<circle cx=\"{cx1}\" cy=\"{y}\" r=\"{position_dot_radius}\" \
                 fill=\"#D4D1D6\" class=\"position-marker\"/>\n\
                 <circle cx=\"{cx2}\" cy=\"{y}\" r=\"{position_dot_radius}\" \
                 fill=\"#D4D1D6\" class=\"position-marker\"/>\n",
                cx1 = center_x - cell_w * OCTAVE_DOUBLE_DOT_OFFSET,
                cx2 = center_x + cell_w * OCTAVE_DOUBLE_DOT_OFFSET,
            ));
        } else {
            svg.push_str(&format!(
                "<circle cx=\"{center_x}\" cy=\"{y}\" r=\"{position_dot_radius}\" \
                 fill=\"#D4D1D6\" class=\"position-marker\"/>\n"
            ));
        }
    }

    for i in 0..num_strings {
        let x = left_margin + i as f32 * cell_w;
        svg.push_str(&format!(
            "<line x1=\"{x}\" y1=\"{nut_y}\" x2=\"{x}\" y2=\"{}\" \
             stroke=\"black\" stroke-width=\"{line_stroke}\"/>\n",
            nut_y + grid_h
        ));
    }

    for j in 0..=num_frets {
        let y = nut_y + j as f32 * cell_h;
        svg.push_str(&format!(
            "<line x1=\"{left_margin}\" y1=\"{y}\" x2=\"{}\" y2=\"{y}\" \
             stroke=\"black\" stroke-width=\"{line_stroke}\"/>\n",
            left_margin + grid_w
        ));
    }

    // Finger positions, open, and muted markers
    for (i, &fret) in data.frets.iter().enumerate() {
        if i >= num_strings {
            break;
        }
        let x = left_margin + i as f32 * cell_w;
        if fret == -1 {
            // Muted (X)
            let y = nut_y - nut_margin_glyph_offset;
            svg.push_str(&format!(
                "<text x=\"{x}\" y=\"{y}\" text-anchor=\"middle\" \
                 font-family=\"sans-serif\" font-size=\"{label_font}\">X</text>\n"
            ));
        } else if fret == 0 {
            // Open (O)
            let y = nut_y - nut_margin_glyph_offset;
            svg.push_str(&format!(
                "<circle cx=\"{x}\" cy=\"{y}\" r=\"{open_radius}\" \
                 fill=\"none\" stroke=\"black\" stroke-width=\"{line_stroke}\"/>\n"
            ));
        } else {
            // Fretted dot
            let y = nut_y + (fret as f32 - 0.5) * cell_h;
            svg.push_str(&format!(
                "<circle cx=\"{x}\" cy=\"{y}\" r=\"{dot_radius}\" fill=\"black\"/>\n"
            ));
            // Finger number inside the dot (if available and non-zero)
            if let Some(&finger) = data.fingers.get(i) {
                if finger > 0 {
                    svg.push_str(&format!(
                        "<text x=\"{x}\" y=\"{}\" text-anchor=\"middle\" \
                         font-family=\"sans-serif\" font-size=\"{finger_font}\" \
                         fill=\"white\">{finger}</text>\n",
                        y + text_v_center
                    ));
                }
            }
        }
    }

    svg.push_str("</svg>");
    svg
}

/// Horizontal counterpart to [`render_svg_vertical_inner`]: nut on the left,
/// fretboard running rightward, high pitch (1st string) on top. Reader-view
/// only — see [`Orientation`] and ADR-0026 for why the player-view
/// alternative is not exposed.
///
/// The geometric layout mirrors the vertical renderer so behaviour stays in
/// lockstep — anything that changes in one (open/muted placement, 12-fret
/// double-dot, base-fret label, finger numbers) must change in the other.
fn render_svg_horizontal_inner(data: &DiagramData, m: &DiagramMetrics) -> String {
    // See `render_svg_vertical_inner` for why every metric is bound to a
    // local. `regular()` reproduces the historical literals byte-for-byte.
    let DiagramMetrics {
        cell_w,
        cell_h,
        top_margin,
        left_margin,
        bottom_pad_horizontal,
        dot_radius,
        open_radius,
        position_dot_radius,
        nut_margin_glyph_offset,
        title_font,
        title_baseline,
        label_font,
        finger_font,
        text_v_center,
        nut_stroke,
        line_stroke,
        class_extra,
        show_fret_numbers,
        ..
    } = *m;

    let num_strings = data.strings;
    let num_frets = data.frets_shown;
    // Semantic aliases — the horizontal layout's fret axis is the SVG
    // x-axis, so use `cell_h` (the vertical layout's fret pitch, the
    // larger of the two cell values) along that axis. Likewise the
    // string axis is the SVG y-axis, so use `cell_w` (the vertical
    // layout's string-to-string spacing, the smaller value). Using the
    // same metrics with swapped meanings preserves the
    // wider-than-tall fretboard aspect ratio that the vertical
    // renderer already encodes — the diagram looks like a real
    // fretboard rotated 90°, not a vertical diagram with the labels
    // shuffled.
    let fret_pitch = cell_h;
    let string_pitch = cell_w;
    let grid_w = num_frets as f32 * fret_pitch;
    let grid_h = (num_strings - 1) as f32 * string_pitch;
    let total_w = grid_w + left_margin * 2.0;
    let total_h = grid_h + top_margin + bottom_pad_horizontal;

    let mut svg = format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"{total_w}\" height=\"{total_h}\" \
         viewBox=\"0 0 {total_w} {total_h}\" \
         class=\"chord-diagram chord-diagram-horizontal{class_extra}\">\n"
    );

    // Chord name (uses display override if present). Centred above the
    // fretboard so the visual weight matches the vertical layout's title.
    let name_x = left_margin + grid_w / 2.0;
    svg.push_str(&format!(
        "<text x=\"{name_x}\" y=\"{title_baseline}\" text-anchor=\"middle\" \
         font-family=\"sans-serif\" font-size=\"{title_font}\" font-weight=\"bold\">{}</text>\n",
        crate::escape::escape_xml(data.title())
    ));

    // Nut (vertical line on the left at the open position) or, for the
    // compact size only, a single base-fret label above the leftmost fret
    // cell. The regular size labels the base fret as part of the full
    // fret-number axis drawn below the grid, so it needs no standalone label
    // here.
    let nut_x = left_margin;
    if data.base_fret == 1 {
        svg.push_str(&format!(
            "<line x1=\"{nut_x}\" y1=\"{top_margin}\" x2=\"{nut_x}\" y2=\"{}\" \
             stroke=\"black\" stroke-width=\"{nut_stroke}\"/>\n",
            top_margin + grid_h
        ));
    } else if !show_fret_numbers {
        // Compact size keeps the legacy single base-fret label above the
        // first fret column. The regular size draws the full fret-number axis
        // below the grid, which already labels the first visible fret.
        svg.push_str(&format!(
            "<text x=\"{}\" y=\"{}\" text-anchor=\"middle\" \
             font-family=\"sans-serif\" font-size=\"{label_font}\">{}</text>\n",
            nut_x + fret_pitch / 2.0,
            top_margin - 4.0,
            data.base_fret
        ));
    }

    // Fret-number axis: label every fret line in the visible window with its
    // absolute fret number (`base_fret - 1 + j`) below the grid, matching the
    // conventional `0 1 2 3` strip beneath a horizontal fretboard. The labels
    // sit inside the existing bottom padding so the diagram's bounding box is
    // unchanged; the `fret-number` class lets consumers restyle/hide them.
    if show_fret_numbers {
        let label_y = top_margin + grid_h + label_font;
        for j in 0..=num_frets {
            let fret_number = data.base_fret as i32 - 1 + j as i32;
            let x = nut_x + j as f32 * fret_pitch;
            svg.push_str(&format!(
                "<text x=\"{x}\" y=\"{label_y}\" text-anchor=\"middle\" \
                 font-family=\"sans-serif\" font-size=\"{label_font}\" \
                 class=\"fret-number\">{fret_number}</text>\n"
            ));
        }
    }

    // Fretboard position-marker inlays — at the horizontal centre row. The
    // 12-fret marker becomes a double dot split along the **vertical**
    // axis at `cy ± string_pitch * OCTAVE_DOUBLE_DOT_OFFSET`, the geometric
    // mirror of the vertical layout's left/right split at
    // `cx ± cell_w * OCTAVE_DOUBLE_DOT_OFFSET` (in vertical mode cell_w is the string pitch).
    let position_frets = position_marker_frets(num_strings);
    let center_y = top_margin + grid_h / 2.0;
    for &marker_fret in position_frets {
        if (marker_fret as i32) < data.base_fret as i32 {
            continue;
        }
        let col = (marker_fret as i32) - (data.base_fret as i32) + 1;
        if col < 1 || col > num_frets as i32 {
            continue;
        }
        let x = nut_x + (col as f32 - 0.5) * fret_pitch;
        if marker_fret == 12 {
            svg.push_str(&format!(
                "<circle cx=\"{x}\" cy=\"{cy1}\" r=\"{position_dot_radius}\" \
                 fill=\"#D4D1D6\" class=\"position-marker\"/>\n\
                 <circle cx=\"{x}\" cy=\"{cy2}\" r=\"{position_dot_radius}\" \
                 fill=\"#D4D1D6\" class=\"position-marker\"/>\n",
                cy1 = center_y - string_pitch * OCTAVE_DOUBLE_DOT_OFFSET,
                cy2 = center_y + string_pitch * OCTAVE_DOUBLE_DOT_OFFSET,
            ));
        } else {
            svg.push_str(&format!(
                "<circle cx=\"{x}\" cy=\"{center_y}\" r=\"{position_dot_radius}\" \
                 fill=\"#D4D1D6\" class=\"position-marker\"/>\n"
            ));
        }
    }

    // The string lines themselves are symmetric; what matters is that
    // the per-string marker placement below maps each physical string
    // index (`i`) to the matching visual row via `row = num_strings -
    // 1 - i`, so the high-pitch string lands on the top row
    // (reader-view, ADR-0026).
    for i in 0..num_strings {
        let y = top_margin + i as f32 * string_pitch;
        svg.push_str(&format!(
            "<line x1=\"{nut_x}\" y1=\"{y}\" x2=\"{}\" y2=\"{y}\" \
             stroke=\"black\" stroke-width=\"{line_stroke}\"/>\n",
            nut_x + grid_w
        ));
    }

    for j in 0..=num_frets {
        let x = nut_x + j as f32 * fret_pitch;
        svg.push_str(&format!(
            "<line x1=\"{x}\" y1=\"{top_margin}\" x2=\"{x}\" y2=\"{}\" \
             stroke=\"black\" stroke-width=\"{line_stroke}\"/>\n",
            top_margin + grid_h
        ));
    }

    // Finger positions, open, and muted markers. ChordPro convention orders
    // `data.frets` from low pitch (index 0) to high pitch — i.e. 6th string
    // (low E) first for guitar. Reader-view places the high pitch on top so
    // the i-th string maps to row `num_strings - 1 - i`.
    for (i, &fret) in data.frets.iter().enumerate() {
        if i >= num_strings {
            break;
        }
        let row = num_strings - 1 - i;
        let y = top_margin + row as f32 * string_pitch;
        if fret == -1 {
            // Muted (X) — to the left of the nut, one per string row.
            // `y + text_v_center` is the same baseline-centring offset the
            // vertical renderer uses for finger-number text.
            let x = nut_x - nut_margin_glyph_offset;
            svg.push_str(&format!(
                "<text x=\"{x}\" y=\"{}\" text-anchor=\"middle\" \
                 font-family=\"sans-serif\" font-size=\"{label_font}\">X</text>\n",
                y + text_v_center
            ));
        } else if fret == 0 {
            // Open (O) — to the left of the nut, one per string row.
            let x = nut_x - nut_margin_glyph_offset;
            svg.push_str(&format!(
                "<circle cx=\"{x}\" cy=\"{y}\" r=\"{open_radius}\" \
                 fill=\"none\" stroke=\"black\" stroke-width=\"{line_stroke}\"/>\n"
            ));
        } else {
            // Fretted dot — placed at the centre of its fret cell along the
            // string row.
            let x = nut_x + (fret as f32 - 0.5) * fret_pitch;
            svg.push_str(&format!(
                "<circle cx=\"{x}\" cy=\"{y}\" r=\"{dot_radius}\" fill=\"black\"/>\n"
            ));
            if let Some(&finger) = data.fingers.get(i) {
                if finger > 0 {
                    svg.push_str(&format!(
                        "<text x=\"{x}\" y=\"{}\" text-anchor=\"middle\" \
                         font-family=\"sans-serif\" font-size=\"{finger_font}\" \
                         fill=\"white\">{finger}</text>\n",
                        y + text_v_center
                    ));
                }
            }
        }
    }

    svg.push_str("</svg>");
    svg
}

/// Render a chord diagram as compact ASCII text.
///
/// Produces a multi-line string showing:
/// - The chord name (display name if set).
/// - Muted (`x`), open (`o`), and fretted (`1`–`N`) positions for each string.
/// - A base-fret marker when the diagram doesn't start at the nut.
///
/// # Format
///
/// ```text
/// Am
/// x o 2 2 1 o
/// ```
///
/// When `base_fret > 1`:
///
/// ```text
/// Bm
/// x 2 4 4 3 2   (fr. 2)
/// ```
///
/// Open strings are shown as `o`, muted strings as `x`, and fretted strings
/// as an integer representing the **absolute** fret number
/// (`base_fret + relative_fret - 1`).
///
/// [`Orientation`] has no effect on this output — the ASCII format is a
/// single line and carries no rotated/flipped variant.
#[must_use]
pub fn render_ascii(data: &DiagramData) -> String {
    let title = data.title();
    let mut positions: Vec<String> = Vec::with_capacity(data.frets.len());
    for &f in &data.frets {
        match f {
            -1 => positions.push("x".to_string()),
            0 => positions.push("o".to_string()),
            n => {
                // Convert relative fret to absolute fret number.
                let abs_fret = data.base_fret as i32 + n - 1;
                positions.push(abs_fret.to_string());
            }
        }
    }
    let frets_str = positions.join(" ");
    if data.base_fret > 1 {
        format!("{title}\n{frets_str}   (fr. {base})", base = data.base_fret)
    } else {
        format!("{title}\n{frets_str}")
    }
}

/// Data needed to render a keyboard (piano) chord diagram.
///
/// MIDI note numbers (0–127) identify which keys to highlight. Values in
/// the range 0–11 are treated as pitch-class offsets (C=0 … B=11) and
/// automatically mapped to octave 4 (MIDI 60–71) for display.
///
/// # Examples
///
/// ```
/// use chordsketch_chordpro::chord_diagram::{KeyboardVoicing, render_keyboard_svg};
///
/// let v = KeyboardVoicing {
///     name: "Cmaj7".to_string(),
///     display_name: None,
///     keys: vec![60, 64, 67, 71],
///     root_key: 60,
/// };
/// let svg = render_keyboard_svg(&v);
/// assert!(svg.contains("<svg"));
/// assert!(svg.contains("Cmaj7"));
/// ```
#[derive(Debug, Clone)]
pub struct KeyboardVoicing {
    /// Chord name (identifier used for matching).
    pub name: String,
    /// Display name override from `{define}` `display` attribute.
    ///
    /// When present, diagram titles show this instead of `name`.
    pub display_name: Option<String>,
    /// MIDI note numbers (0–127) for the chord tones to highlight.
    ///
    /// When all values are in the range 0–11 they are treated as
    /// pitch-class offsets (C=0 … B=11) and displayed in octave 4
    /// (MIDI 60–71).
    pub keys: Vec<u8>,
    /// MIDI note number of the root key.
    ///
    /// Displayed with extra visual emphasis (darker fill). When `keys` are
    /// normalised from pitch classes, `root_key` is normalised accordingly.
    pub root_key: u8,
}

impl KeyboardVoicing {
    /// Returns the title to display above the diagram.
    ///
    /// Uses the `display_name` override if present, otherwise falls back to `name`.
    #[must_use]
    pub fn title(&self) -> &str {
        self.display_name.as_deref().unwrap_or(&self.name)
    }
}

// ---------------------------------------------------------------------------
// Keyboard SVG layout constants
// ---------------------------------------------------------------------------

/// White key width in pixels for keyboard diagrams.
const KBD_WHITE_W: f32 = 15.0;
/// White key height in pixels.
const KBD_WHITE_H: f32 = 60.0;
/// Black key width in pixels.
const KBD_BLACK_W: f32 = 9.0;
/// Black key height in pixels.
const KBD_BLACK_H: f32 = 36.0;
/// Vertical space above keyboard for the chord name.
const KBD_TOP_PAD: f32 = 30.0;
/// Horizontal margin on each side.
const KBD_SIDE_PAD: f32 = 8.0;

/// White key semitone offsets within an octave and their left-edge x-offsets
/// (in pixels, relative to the octave's starting C key).
const WHITE_KEY_POSITIONS: [(u8, f32); 7] = [
    (0, 0.0 * KBD_WHITE_W),  // C
    (2, 1.0 * KBD_WHITE_W),  // D
    (4, 2.0 * KBD_WHITE_W),  // E
    (5, 3.0 * KBD_WHITE_W),  // F
    (7, 4.0 * KBD_WHITE_W),  // G
    (9, 5.0 * KBD_WHITE_W),  // A
    (11, 6.0 * KBD_WHITE_W), // B
];

/// Black key semitone offsets within an octave and their left-edge x-offsets
/// (in pixels, relative to the octave's starting C key).
///
/// Each black key is centred at the boundary between its two adjacent white
/// keys: `left_edge = (right_edge_of_left_white) - BLACK_W / 2`.
const BLACK_KEY_POSITIONS: [(u8, f32); 5] = [
    (1, 10.0),  // C# (between C and D: 15 − 4.5 ≈ 10)
    (3, 25.0),  // D# (between D and E: 30 − 4.5 ≈ 25)
    (6, 55.0),  // F# (between F and G: 60 − 4.5 ≈ 55)
    (8, 70.0),  // G# (between G and A: 75 − 4.5 ≈ 70)
    (10, 85.0), // A# (between A and B: 90 − 4.5 ≈ 85)
];

/// White-key boundary multiples (in white-key widths) at which each black
/// key is centred: C# at 1, D# at 2, F# at 4, G# at 5, A# at 6. Used to
/// derive the compact black-key x-offsets from the compact white-key
/// width — the regular [`BLACK_KEY_POSITIONS`] is kept as hand-rounded
/// literals for byte-for-byte backward compatibility, so the two are NOT
/// computed from a shared formula.
const BLACK_KEY_BOUNDARY_MULTIPLES: [(u8, f32); 5] =
    [(1, 1.0), (3, 2.0), (6, 4.0), (8, 5.0), (10, 6.0)];

/// All size-dependent measurements for one keyboard-diagram render pass.
///
/// Like [`DiagramMetrics`] for fretted diagrams, this lets the keyboard
/// renderer support [`DiagramSize::Compact`] without forking into a
/// duplicate function. [`regular`](Self::regular) reproduces the
/// historical literals (and reuses the existing position arrays) so the
/// regular keyboard SVG is unchanged.
#[derive(Debug, Clone)]
struct KeyboardMetrics {
    white_w: f32,
    white_h: f32,
    black_w: f32,
    black_h: f32,
    top_pad: f32,
    side_pad: f32,
    bottom_pad: f32,
    title_font: f32,
    title_baseline: f32,
    white_positions: [(u8, f32); 7],
    black_positions: [(u8, f32); 5],
    class_extra: &'static str,
}

impl KeyboardMetrics {
    /// Full-size keyboard metrics — the historical layout.
    fn regular() -> Self {
        Self {
            white_w: KBD_WHITE_W,
            white_h: KBD_WHITE_H,
            black_w: KBD_BLACK_W,
            black_h: KBD_BLACK_H,
            top_pad: KBD_TOP_PAD,
            side_pad: KBD_SIDE_PAD,
            bottom_pad: 8.0,
            title_font: 14.0,
            title_baseline: 15.0,
            white_positions: WHITE_KEY_POSITIONS,
            black_positions: BLACK_KEY_POSITIONS,
            class_extra: "",
        }
    }

    /// Compact keyboard metrics for diagrams shown above a lyric line.
    ///
    /// Key geometry shrinks; the title font holds at 11 (the same
    /// legibility floor the fretted compact layout uses). Black-key
    /// offsets are recomputed from the compact white-key width via
    /// [`BLACK_KEY_BOUNDARY_MULTIPLES`] — scaling the regular absolute
    /// px offsets would misalign the black keys.
    fn compact() -> Self {
        let white_w = 9.0;
        let black_w = 5.5;
        let white_positions = [
            (0u8, 0.0 * white_w),
            (2, 1.0 * white_w),
            (4, 2.0 * white_w),
            (5, 3.0 * white_w),
            (7, 4.0 * white_w),
            (9, 5.0 * white_w),
            (11, 6.0 * white_w),
        ];
        let mut black_positions = [(0u8, 0.0f32); 5];
        let mut i = 0;
        while i < BLACK_KEY_BOUNDARY_MULTIPLES.len() {
            let (semitone, mult) = BLACK_KEY_BOUNDARY_MULTIPLES[i];
            // Centre the black key on the white-key boundary.
            black_positions[i] = (semitone, mult * white_w - black_w / 2.0);
            i += 1;
        }
        Self {
            white_w,
            white_h: 34.0,
            black_w,
            black_h: 20.0,
            top_pad: 18.0,
            side_pad: 5.0,
            bottom_pad: 6.0,
            title_font: 11.0,
            title_baseline: 9.0,
            white_positions,
            black_positions,
            class_extra: " keyboard-diagram-compact",
        }
    }

    fn for_size(size: DiagramSize) -> Self {
        match size {
            DiagramSize::Regular => Self::regular(),
            DiagramSize::Compact => Self::compact(),
        }
    }
}

/// Normalise `keys` and `root_key` for display.
///
/// When all keys are in 0–11 (pitch classes), shifts them to octave 4
/// (adds 60). Otherwise returns them unchanged.
///
/// # Convention
///
/// When keys contain pitch classes, `root_key` is expected to also be a pitch
/// class (0–11). If `root_key >= 12` while the chord tones are all pitch
/// classes, it is left unchanged (no normalisation applied to the root).
/// Callers should ensure both `keys` and `root_key` use the same
/// representation.
///
/// # Empty-slice behaviour
///
/// When `keys` is empty, `all(|k| k < 12)` is vacuously true, so
/// `root_key` is still shifted to octave 4 if it is less than 12. Both
/// current callers guard against empty keys before calling this function,
/// but future callers should be aware of this edge case.
#[must_use]
pub fn normalise_keyboard_keys(keys: &[u8], root_key: u8) -> (Vec<u8>, u8) {
    if keys.iter().all(|&k| k < 12) {
        let normalised: Vec<u8> = keys.iter().map(|&k| k.saturating_add(60)).collect();
        let root = if root_key < 12 {
            root_key.saturating_add(60)
        } else {
            root_key
        };
        (normalised, root)
    } else {
        (keys.to_vec(), root_key)
    }
}

/// Render a keyboard chord diagram as an inline SVG string.
///
/// Shows the piano octave(s) containing the chord tones, with highlighted
/// keys for each chord tone and extra emphasis on the root key.
///
/// Returns an empty string when `voicing.keys` is empty.
///
/// # Examples
///
/// ```
/// use chordsketch_chordpro::chord_diagram::{KeyboardVoicing, render_keyboard_svg};
///
/// let v = KeyboardVoicing {
///     name: "Am".to_string(),
///     display_name: None,
///     keys: vec![69, 72, 76],
///     root_key: 69,
/// };
/// let svg = render_keyboard_svg(&v);
/// assert!(svg.contains("<svg"));
/// assert!(svg.contains("Am"));
/// assert!(svg.contains("class=\"keyboard-diagram\""));
/// ```
#[must_use]
pub fn render_keyboard_svg(voicing: &KeyboardVoicing) -> String {
    render_keyboard_svg_with_size(voicing, DiagramSize::Regular)
}

/// Render a keyboard chord diagram with an explicit [size](DiagramSize).
///
/// [`render_keyboard_svg`] is a thin wrapper that calls this with
/// [`DiagramSize::Regular`]; pass [`DiagramSize::Compact`] for the smaller
/// above-a-lyric layout used by the `{diagrams: inline}` / `{diagrams:
/// hover}` modes. The compact SVG carries an extra
/// `keyboard-diagram-compact` class on its root element.
///
/// Returns an empty string when `voicing.keys` is empty.
///
/// # Examples
///
/// ```
/// use chordsketch_chordpro::chord_diagram::{
///     DiagramSize, KeyboardVoicing, render_keyboard_svg_with_size,
/// };
///
/// let v = KeyboardVoicing {
///     name: "Am".to_string(),
///     display_name: None,
///     keys: vec![69, 72, 76],
///     root_key: 69,
/// };
/// let svg = render_keyboard_svg_with_size(&v, DiagramSize::Compact);
/// assert!(svg.contains("keyboard-diagram-compact"));
/// ```
#[must_use]
pub fn render_keyboard_svg_with_size(voicing: &KeyboardVoicing, size: DiagramSize) -> String {
    if voicing.keys.is_empty() {
        return String::new();
    }

    let m = KeyboardMetrics::for_size(size);

    let (keys, root) = normalise_keyboard_keys(&voicing.keys, voicing.root_key);

    let min_key = *keys.iter().min().unwrap_or(&60);
    let max_key = *keys.iter().max().unwrap_or(&71);

    // Start from C of the octave containing the lowest key.
    let start_octave = u32::from(min_key / 12);
    let end_octave = u32::from(max_key / 12);
    // Show at least 2 octaves, cap at 3 for readability.
    let num_octaves = ((end_octave - start_octave) + 1).clamp(2, 3) as usize;
    let start_midi = (start_octave * 12) as u8;

    let octave_w = 7.0 * m.white_w;
    let kbd_w = num_octaves as f32 * octave_w;
    let total_w = kbd_w + m.side_pad * 2.0;
    let total_h = m.top_pad + m.white_h + m.bottom_pad;

    let class_extra = m.class_extra;
    let mut svg = format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"{total_w}\" height=\"{total_h}\" \
         viewBox=\"0 0 {total_w} {total_h}\" class=\"keyboard-diagram{class_extra}\">\n"
    );

    // Chord name label
    let name_x = total_w / 2.0;
    let title_font = m.title_font;
    let title_baseline = m.title_baseline;
    svg.push_str(&format!(
        "<text x=\"{name_x}\" y=\"{title_baseline}\" text-anchor=\"middle\" \
         font-family=\"sans-serif\" font-size=\"{title_font}\" font-weight=\"bold\">{}</text>\n",
        crate::escape::escape_xml(voicing.title())
    ));

    let top_pad = m.top_pad;
    let white_w = m.white_w;
    let white_h = m.white_h;
    let black_w = m.black_w;
    let black_h = m.black_h;

    // --- Draw white keys first (black keys are drawn on top) ---
    for oct in 0..num_octaves {
        let oct_midi = start_midi.saturating_add((oct * 12) as u8);
        let oct_x = m.side_pad + oct as f32 * octave_w;
        for (semitone, x_off) in m.white_positions {
            let midi = oct_midi.saturating_add(semitone);
            let x = oct_x + x_off;
            let highlighted = keys.contains(&midi);
            let is_root = highlighted && midi == root;
            let fill = if is_root {
                "#1a5fb4" // root key: dark blue
            } else if highlighted {
                "#4a90e2" // chord tone: medium blue
            } else {
                "white"
            };
            svg.push_str(&format!(
                "<rect x=\"{x}\" y=\"{top_pad}\" width=\"{white_w}\" \
                 height=\"{white_h}\" fill=\"{fill}\" stroke=\"black\" \
                 stroke-width=\"0.5\"/>\n"
            ));
        }
    }

    // --- Draw black keys on top ---
    for oct in 0..num_octaves {
        let oct_midi = start_midi.saturating_add((oct * 12) as u8);
        let oct_x = m.side_pad + oct as f32 * octave_w;
        for (semitone, x_off) in m.black_positions {
            let midi = oct_midi.saturating_add(semitone);
            let x = oct_x + x_off;
            let highlighted = keys.contains(&midi);
            let is_root = highlighted && midi == root;
            let fill = if is_root {
                "#1a5fb4" // root: dark blue
            } else if highlighted {
                "#4a90e2" // chord tone: medium blue (contrasts with default dark key)
            } else {
                "#222" // normal black key
            };
            svg.push_str(&format!(
                "<rect x=\"{x}\" y=\"{top_pad}\" width=\"{black_w}\" \
                 height=\"{black_h}\" fill=\"{fill}\" stroke=\"black\" \
                 stroke-width=\"0.5\"/>\n"
            ));
        }
    }

    svg.push_str("</svg>");
    svg
}

/// Resolves the active instrument for a `{diagrams}` directive value.
///
/// Returns `None` when diagrams are disabled (`value` is `"off"`,
/// case-insensitive).  Returns `Some(instrument_name)` otherwise, normalising
/// known aliases (`"uke"` → `"ukulele"`, `"keyboard"` / `"keys"` → `"piano"`)
/// and falling back to `default_instrument` for unrecognised values.
///
/// This helper is shared by all renderer crates so the instrument-matching
/// logic stays in one place.
///
/// # Examples
///
/// ```
/// use chordsketch_chordpro::chord_diagram::resolve_diagrams_instrument;
///
/// assert_eq!(resolve_diagrams_instrument(None, "guitar"), Some("guitar".to_string()));
/// assert_eq!(resolve_diagrams_instrument(Some("off"), "guitar"), None);
/// assert_eq!(resolve_diagrams_instrument(Some("uke"), "guitar"), Some("ukulele".to_string()));
/// assert_eq!(resolve_diagrams_instrument(Some("piano"), "guitar"), Some("piano".to_string()));
/// assert_eq!(resolve_diagrams_instrument(Some("keys"), "guitar"), Some("piano".to_string()));
/// assert_eq!(resolve_diagrams_instrument(Some("keyboard"), "guitar"), Some("piano".to_string()));
/// assert_eq!(resolve_diagrams_instrument(Some("unknown"), "guitar"), Some("guitar".to_string()));
/// ```
#[must_use]
pub fn resolve_diagrams_instrument(
    value: Option<&str>,
    default_instrument: &str,
) -> Option<String> {
    let val = value.unwrap_or("on");
    if val.eq_ignore_ascii_case("off") {
        return None;
    }
    let instr = match val.to_ascii_lowercase().as_str() {
        "ukulele" | "uke" => "ukulele",
        "guitar" => "guitar",
        "piano" | "keyboard" | "keys" => "piano",
        _ => default_instrument,
    };
    Some(instr.to_string())
}

/// Resolves the active [`Orientation`] from the `diagrams.orientation`
/// config value.
///
/// Accepted (case-insensitive): `"vertical"` → [`Orientation::Vertical`],
/// `"horizontal"` → [`Orientation::Horizontal`]. `None`, empty, or any
/// unrecognised string falls back to [`Orientation::Vertical`].
/// Inputs longer than [`MAX_RESOLVER_INPUT_LEN`] are rejected (returns
/// the default) to bound the `to_ascii_lowercase` allocation on hostile
/// binding input.
///
/// Use [`try_parse_orientation_value`] when the caller wants to surface
/// a warning for typo'd values instead of silently falling back.
///
/// Shared by every renderer + binding so parsing stays in one place — a
/// future orientation value (e.g. `"horizontal-lefty"`) lands here and
/// propagates to every downstream surface automatically.
///
/// # Examples
///
/// ```
/// use chordsketch_chordpro::chord_diagram::{Orientation, resolve_orientation};
///
/// assert_eq!(resolve_orientation(None), Orientation::Vertical);
/// assert_eq!(resolve_orientation(Some("vertical")), Orientation::Vertical);
/// assert_eq!(resolve_orientation(Some("horizontal")), Orientation::Horizontal);
/// assert_eq!(resolve_orientation(Some("HORIZONTAL")), Orientation::Horizontal);
/// assert_eq!(resolve_orientation(Some("garbage")), Orientation::Vertical);
/// ```
#[must_use]
pub fn resolve_orientation(orientation: Option<&str>) -> Orientation {
    match try_parse_orientation_value(orientation) {
        Some(OrientationKind::Horizontal) => Orientation::Horizontal,
        // Vertical and any unrecognised / oversized / missing input — fall
        // back to the documented default.
        _ => Orientation::Vertical,
    }
}

/// Largest accepted byte length for an orientation string before the
/// resolver gives up and uses the default.
///
/// `to_ascii_lowercase` on an `&str` allocates a new buffer of the same
/// byte length, so a GB-scale hostile input from a binding consumer
/// would otherwise cost a GB-scale allocation. 64 bytes is generous for
/// every valid value (`"horizontal"` is 10, `"vertical"` is 8) and any
/// future variant slug.
pub const MAX_RESOLVER_INPUT_LEN: usize = 64;

/// Discriminant for [`try_parse_orientation_value`]. Mirrors the variants
/// of [`Orientation`] verbatim today.
///
/// Public so renderer call sites can build a warning when the raw config
/// string was non-empty but unparseable.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum OrientationKind {
    /// Matches `Orientation::Vertical`.
    Vertical,
    /// Matches `Orientation::Horizontal`.
    Horizontal,
}

/// Strict parser for the `diagrams.orientation` value. Returns `None` for
/// missing / empty / unrecognised / oversized input so callers can emit a
/// warning before falling back via [`resolve_orientation`].
#[must_use]
pub fn try_parse_orientation_value(value: Option<&str>) -> Option<OrientationKind> {
    let raw = value?.trim();
    if raw.is_empty() || raw.len() > MAX_RESOLVER_INPUT_LEN {
        return None;
    }
    match raw.to_ascii_lowercase().as_str() {
        "vertical" => Some(OrientationKind::Vertical),
        "horizontal" => Some(OrientationKind::Horizontal),
        _ => None,
    }
}

/// How chord diagrams are surfaced for a song — a chordsketch extension to
/// the `{diagrams}` directive.
///
/// `{diagrams: inline}` / `{diagrams: hover}` are NOT part of the ChordPro
/// spec (which only defines on/off + instrument + position); they are a
/// chordsketch-only facet that controls *where* diagrams appear relative
/// to the chords above the lyrics, orthogonal to the instrument and
/// position facets a value may also carry.
///
/// - [`Section`](Self::Section) (default) — the existing end-of-song
///   diagram grid. Unchanged behaviour.
/// - [`Inline`](Self::Inline) — each chord name above a lyric is replaced
///   by its compact diagram (the diagram still shows the chord name).
/// - [`Hover`](Self::Hover) — the chord name stays as text and the compact
///   diagram is revealed on hover / keyboard focus.
///
/// `#[non_exhaustive]` so a future surfacing mode can be added without an
/// API break, mirroring [`Orientation`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
#[non_exhaustive]
pub enum DiagramsMode {
    /// End-of-song diagram grid (the spec-standard placement). Default.
    #[default]
    Section,
    /// Compact diagram replaces the chord name above each lyric.
    Inline,
    /// Compact diagram revealed on hover / focus over the chord name.
    Hover,
}

/// Discriminant returned by [`try_parse_diagrams_mode`]. Mirrors the
/// variants of [`DiagramsMode`] verbatim today.
///
/// Public so renderer call sites can distinguish "value was a recognised
/// mode keyword" from "value was something else (instrument / position /
/// typo)" — only the mode keywords (`inline` / `hover` / `section`) yield
/// `Some`, so a `{diagrams: guitar}` line correctly returns `None` here
/// and is handled by the instrument facet instead.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum DiagramsModeKind {
    /// Matches `DiagramsMode::Section`.
    Section,
    /// Matches `DiagramsMode::Inline`.
    Inline,
    /// Matches `DiagramsMode::Hover`.
    Hover,
}

/// Strict parser for the chordsketch `{diagrams}` *mode* facet. Returns
/// `None` for missing / empty / oversized input **and** for any value that
/// is not one of the mode keywords (`section` / `inline` / `hover`) — so a
/// `{diagrams: guitar}` (instrument) or `{diagrams: top}` (position) value
/// returns `None` and is left for the instrument / position facets to
/// interpret.
///
/// Bounds the `to_ascii_lowercase` allocation at [`MAX_RESOLVER_INPUT_LEN`]
/// for the same reason [`try_parse_orientation_value`] does.
///
/// # Examples
///
/// ```
/// use chordsketch_chordpro::chord_diagram::{DiagramsModeKind, try_parse_diagrams_mode};
///
/// assert_eq!(try_parse_diagrams_mode(Some("inline")), Some(DiagramsModeKind::Inline));
/// assert_eq!(try_parse_diagrams_mode(Some("HOVER")), Some(DiagramsModeKind::Hover));
/// assert_eq!(try_parse_diagrams_mode(Some("section")), Some(DiagramsModeKind::Section));
/// assert_eq!(try_parse_diagrams_mode(Some("guitar")), None);
/// assert_eq!(try_parse_diagrams_mode(None), None);
/// ```
#[must_use]
pub fn try_parse_diagrams_mode(value: Option<&str>) -> Option<DiagramsModeKind> {
    let raw = value?.trim();
    if raw.is_empty() || raw.len() > MAX_RESOLVER_INPUT_LEN {
        return None;
    }
    match raw.to_ascii_lowercase().as_str() {
        "section" => Some(DiagramsModeKind::Section),
        "inline" => Some(DiagramsModeKind::Inline),
        "hover" => Some(DiagramsModeKind::Hover),
        _ => None,
    }
}

/// Resolves the chordsketch `{diagrams}` mode facet, falling back to
/// [`DiagramsMode::Section`] for missing / empty / unrecognised input.
///
/// Use [`try_parse_diagrams_mode`] when the caller needs to distinguish a
/// recognised mode keyword from a non-mode value (instrument / position).
///
/// Shared by every renderer + binding so the mode parsing stays in one
/// place — a future mode keyword lands here and propagates to every
/// downstream surface automatically.
///
/// # Examples
///
/// ```
/// use chordsketch_chordpro::chord_diagram::{DiagramsMode, resolve_diagrams_mode};
///
/// assert_eq!(resolve_diagrams_mode(None), DiagramsMode::Section);
/// assert_eq!(resolve_diagrams_mode(Some("inline")), DiagramsMode::Inline);
/// assert_eq!(resolve_diagrams_mode(Some("hover")), DiagramsMode::Hover);
/// assert_eq!(resolve_diagrams_mode(Some("guitar")), DiagramsMode::Section);
/// ```
#[must_use]
pub fn resolve_diagrams_mode(value: Option<&str>) -> DiagramsMode {
    match try_parse_diagrams_mode(value) {
        Some(DiagramsModeKind::Inline) => DiagramsMode::Inline,
        Some(DiagramsModeKind::Hover) => DiagramsMode::Hover,
        // Section, and any unrecognised / oversized / missing input — fall
        // back to the documented default.
        _ => DiagramsMode::Section,
    }
}

/// Returns the canonical (sharp-spelling) form of a chord name.
///
/// Enharmonic flat roots (`Bb`, `Db`, `Eb`, `Gb`, `Ab`) are converted to
/// their sharp equivalents; all other names are returned unchanged.
///
/// Use this when comparing chord names for equality across different spellings
/// (e.g., determining whether a `{define: Bb …}` entry covers `[A#]` in lyrics).
///
/// # Examples
///
/// ```
/// use chordsketch_chordpro::chord_diagram::canonical_chord_name;
///
/// assert_eq!(canonical_chord_name("Bb"), "A#");
/// assert_eq!(canonical_chord_name("Bbm7"), "A#m7");
/// assert_eq!(canonical_chord_name("Am"), "Am");
/// assert_eq!(canonical_chord_name("G"), "G");
/// ```
#[must_use]
pub fn canonical_chord_name(name: &str) -> String {
    crate::voicings::flat_to_sharp(name).unwrap_or_else(|| name.to_string())
}

// ===========================================================================
// Tests
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_render_svg_basic() {
        let data = DiagramData {
            name: "Am".to_string(),
            display_name: None,
            strings: 6,
            frets_shown: 5,
            base_fret: 1,
            frets: vec![-1, 0, 2, 2, 1, 0],
            fingers: vec![],
        };
        let svg = render_svg(&data);
        assert!(svg.contains("<svg"));
        assert!(svg.contains("</svg>"));
        assert!(svg.contains("Am"));
        // Should have circles for fretted positions
        assert!(svg.contains("<circle"));
        // Should have X for muted string
        assert!(svg.contains(">X<"));
    }

    #[test]
    fn test_render_svg_barre_chord() {
        let data = DiagramData {
            name: "F".to_string(),
            display_name: None,
            strings: 6,
            frets_shown: 5,
            base_fret: 1,
            frets: vec![1, 1, 2, 3, 3, 1],
            fingers: vec![],
        };
        let svg = render_svg(&data);
        assert!(svg.contains(">F<"));
    }

    #[test]
    fn test_render_svg_high_position() {
        let data = DiagramData {
            name: "Bm".to_string(),
            display_name: None,
            strings: 6,
            frets_shown: 5,
            base_fret: 7,
            frets: vec![-1, 1, 3, 3, 2, 1],
            fingers: vec![],
        };
        let svg = render_svg(&data);
        // Bare fret-number label (no `fr` suffix) for diagrams
        // that start above fret 1.
        assert!(svg.contains(">7</text>"));
        assert!(!svg.contains("7fr"));
    }

    #[test]
    fn position_marker_frets_table_lookup() {
        // Guitar (6 strings) — standard western inlay layout.
        assert_eq!(position_marker_frets(6), &[3, 5, 7, 9, 12, 15, 17, 19, 21]);
        // Ukulele (4 strings) — simpler inlay set.
        assert_eq!(position_marker_frets(4), &[3, 5, 7, 10, 12, 15]);
        // Non-standard string counts get no inlays.
        assert!(position_marker_frets(5).is_empty());
        assert!(position_marker_frets(7).is_empty());
        assert!(position_marker_frets(12).is_empty());
        assert!(position_marker_frets(0).is_empty());
    }

    #[test]
    fn test_render_svg_guitar_has_position_markers_for_visible_inlay_frets() {
        // A standard nut-position chord (base_fret=1, 5 visible
        // frets) shows the fret-3 and fret-5 inlay dots.
        let data = DiagramData {
            name: "C".to_string(),
            display_name: None,
            strings: 6,
            frets_shown: 5,
            base_fret: 1,
            frets: vec![-1, 3, 2, 0, 1, 0],
            fingers: vec![],
        };
        let svg = render_svg(&data);
        assert!(
            svg.contains("class=\"position-marker\""),
            "expected at least one position-marker dot; got: {svg}"
        );
        // No double dot at the nut-position window (fret 12 is
        // out of range).
        let count = svg.matches("class=\"position-marker\"").count();
        // Inlay frets in [1..=5] = 3 and 5 → 2 markers.
        assert_eq!(count, 2);
    }

    #[test]
    fn test_render_svg_guitar_position_markers_offset_by_base_fret() {
        // A barre chord at fret 7 with 5 visible frets sees frets
        // 7, 8, 9, 10, 11 — inlays at 7 and 9.
        let data = DiagramData {
            name: "Bm".to_string(),
            display_name: None,
            strings: 6,
            frets_shown: 5,
            base_fret: 7,
            frets: vec![1, 1, 1, 1, 1, 1],
            fingers: vec![],
        };
        let svg = render_svg(&data);
        let count = svg.matches("class=\"position-marker\"").count();
        assert_eq!(
            count, 2,
            "expected fret-7 and fret-9 inlays; got svg: {svg}"
        );
    }

    #[test]
    fn test_render_svg_guitar_double_dot_at_octave_fret_12() {
        // A diagram that includes fret 12 should show TWO
        // position-marker dots on that row (double inlay).
        let data = DiagramData {
            name: "C".to_string(),
            display_name: None,
            strings: 6,
            frets_shown: 5,
            base_fret: 9, // visible frets 9..=13 include 12
            frets: vec![-1, -1, -1, -1, -1, -1],
            fingers: vec![],
        };
        let svg = render_svg(&data);
        let count = svg.matches("class=\"position-marker\"").count();
        // Inlay frets 9 and 12 are visible. 9 = single dot,
        // 12 = double dot → total 3 dots.
        assert_eq!(
            count, 3,
            "expected 1 single + 2 (double at 12); got svg: {svg}"
        );
    }

    #[test]
    fn test_render_svg_ukulele_position_markers() {
        // Ukulele uses 4 strings — inlay frets are 3, 5, 7, 10,
        // 12, 15. Different from guitar.
        let data = DiagramData {
            name: "C".to_string(),
            display_name: None,
            strings: 4,
            frets_shown: 5,
            base_fret: 1,
            frets: vec![0, 0, 0, 3],
            fingers: vec![],
        };
        let svg = render_svg(&data);
        let count = svg.matches("class=\"position-marker\"").count();
        // Inlay frets in [1..=5] for ukulele = 3 and 5 → 2 markers.
        assert_eq!(count, 2);
    }

    #[test]
    fn test_from_raw_basic() {
        let data = DiagramData::from_raw("Am", "base-fret 1 frets x 0 2 2 1 0", 6).unwrap();
        assert_eq!(data.name, "Am");
        assert_eq!(data.base_fret, 1);
        assert_eq!(data.frets, vec![-1, 0, 2, 2, 1, 0]);
    }

    #[test]
    fn test_from_raw_with_fingers() {
        let data =
            DiagramData::from_raw("C", "base-fret 1 frets x 3 2 0 1 0 fingers 0 3 2 0 1 0", 6)
                .unwrap();
        assert_eq!(data.frets, vec![-1, 3, 2, 0, 1, 0]);
        assert_eq!(data.fingers, vec![0, 3, 2, 0, 1, 0]);
    }

    #[test]
    fn test_from_raw_no_frets() {
        assert!(DiagramData::from_raw("X", "base-fret 1", 6).is_none());
    }

    #[test]
    fn test_from_raw_ukulele() {
        let data = DiagramData::from_raw("C", "frets 0 0 0 3", 4).unwrap();
        assert_eq!(data.strings, 4);
        assert_eq!(data.frets, vec![0, 0, 0, 3]);
    }

    #[test]
    fn test_from_raw_infer_guitar() {
        let data = DiagramData::from_raw_infer("Am", "base-fret 1 frets x 0 2 2 1 0").unwrap();
        assert_eq!(data.strings, 6);
        assert_eq!(data.frets, vec![-1, 0, 2, 2, 1, 0]);
    }

    #[test]
    fn test_from_raw_infer_ukulele() {
        let data = DiagramData::from_raw_infer("C", "frets 0 0 0 3").unwrap();
        assert_eq!(data.strings, 4);
        assert_eq!(data.frets, vec![0, 0, 0, 3]);
    }

    #[test]
    fn test_from_raw_infer_banjo() {
        let data = DiagramData::from_raw_infer("G", "frets 0 0 0 0 0").unwrap();
        assert_eq!(data.strings, 5);
        assert_eq!(data.frets, vec![0, 0, 0, 0, 0]);
    }

    #[test]
    fn test_title_returns_display_name_when_set() {
        let data = DiagramData {
            name: "Am".to_string(),
            display_name: Some("A minor".to_string()),
            strings: 6,
            frets_shown: 5,
            base_fret: 1,
            frets: vec![-1, 0, 2, 2, 1, 0],
            fingers: vec![],
        };
        assert_eq!(data.title(), "A minor");
    }

    #[test]
    fn test_title_falls_back_to_name() {
        let data = DiagramData {
            name: "Am".to_string(),
            display_name: None,
            strings: 6,
            frets_shown: 5,
            base_fret: 1,
            frets: vec![-1, 0, 2, 2, 1, 0],
            fingers: vec![],
        };
        assert_eq!(data.title(), "Am");
    }

    #[test]
    fn test_render_svg_with_display_name() {
        let data = DiagramData {
            name: "Am".to_string(),
            display_name: Some("A minor".to_string()),
            strings: 6,
            frets_shown: 5,
            base_fret: 1,
            frets: vec![-1, 0, 2, 2, 1, 0],
            fingers: vec![],
        };
        let svg = render_svg(&data);
        assert!(svg.contains("A minor"));
        assert!(!svg.contains(">Am<"));
    }

    #[test]
    fn test_from_raw_display_name_is_none() {
        let data = DiagramData::from_raw_infer("Am", "base-fret 1 frets x 0 2 2 1 0").unwrap();
        assert!(data.display_name.is_none());
    }

    // --- Finger number rendering (#473) ---

    #[test]
    fn test_render_svg_with_finger_numbers() {
        let data = DiagramData {
            name: "C".to_string(),
            display_name: None,
            strings: 6,
            frets_shown: 5,
            base_fret: 1,
            frets: vec![-1, 3, 2, 0, 1, 0],
            fingers: vec![0, 3, 2, 0, 1, 0],
        };
        let svg = render_svg(&data);
        // Fingers 3, 2, 1 should appear as white text inside dots
        assert!(svg.contains("fill=\"white\">3</text>"));
        assert!(svg.contains("fill=\"white\">2</text>"));
        assert!(svg.contains("fill=\"white\">1</text>"));
    }

    #[test]
    fn test_render_svg_zero_finger_not_shown() {
        let data = DiagramData {
            name: "Am".to_string(),
            display_name: None,
            strings: 6,
            frets_shown: 5,
            base_fret: 1,
            frets: vec![-1, 0, 2, 2, 1, 0],
            fingers: vec![0, 0, 2, 3, 1, 0],
        };
        let svg = render_svg(&data);
        // Finger 0 should NOT appear
        assert!(!svg.contains("fill=\"white\">0</text>"));
        // Non-zero fingers should appear
        assert!(svg.contains("fill=\"white\">2</text>"));
        assert!(svg.contains("fill=\"white\">3</text>"));
        assert!(svg.contains("fill=\"white\">1</text>"));
    }

    #[test]
    fn test_render_svg_no_fingers_no_crash() {
        let data = DiagramData {
            name: "G".to_string(),
            display_name: None,
            strings: 6,
            frets_shown: 5,
            base_fret: 1,
            frets: vec![3, 2, 0, 0, 0, 3],
            fingers: vec![],
        };
        let svg = render_svg(&data);
        assert!(svg.contains("<svg"));
        assert!(!svg.contains("fill=\"white\""));
    }

    #[test]
    fn test_render_svg_fewer_fingers_than_frets() {
        let data = DiagramData {
            name: "Am".to_string(),
            display_name: None,
            strings: 6,
            frets_shown: 5,
            base_fret: 1,
            frets: vec![-1, 0, 2, 2, 1, 0],
            fingers: vec![0, 0, 2],
        };
        let svg = render_svg(&data);
        // Should only render finger 2, no crash for missing fingers
        assert!(svg.contains("fill=\"white\">2</text>"));
        assert!(svg.contains("<svg"));
    }

    // --- num_strings validation (#467) ---

    #[test]
    fn test_from_raw_zero_strings_rejected() {
        // Single fret value -> 1 string, below MIN_STRINGS
        assert!(DiagramData::from_raw("X", "frets 0", 0).is_none());
    }

    #[test]
    fn test_from_raw_one_string_rejected() {
        assert!(DiagramData::from_raw("X", "frets 0", 1).is_none());
    }

    #[test]
    fn test_from_raw_two_strings_accepted() {
        let data = DiagramData::from_raw("X", "frets 0 0", 0).unwrap();
        assert_eq!(data.strings, 2);
    }

    #[test]
    fn test_from_raw_twelve_strings_accepted() {
        let data = DiagramData::from_raw("X", "frets 0 0 0 0 0 0 0 0 0 0 0 0", 0).unwrap();
        assert_eq!(data.strings, 12);
    }

    #[test]
    fn test_from_raw_thirteen_strings_rejected() {
        assert!(DiagramData::from_raw("X", "frets 0 0 0 0 0 0 0 0 0 0 0 0 0", 0,).is_none());
    }

    #[test]
    fn test_from_raw_num_strings_forces_too_many() {
        // 6 frets but num_strings=13 -> rejected
        assert!(DiagramData::from_raw("X", "frets 0 0 0 0 0 0", 13).is_none());
    }

    // --- Fret value clamping (#469) ---

    #[test]
    fn test_fret_exceeding_range_clamped() {
        let data = DiagramData::from_raw("X", "base-fret 1 frets 0 12 0 0 0 0", 6).unwrap();
        // Fret 12 should be clamped to frets_shown (5)
        assert_eq!(data.frets[1], 5);
    }

    #[test]
    fn test_fret_at_boundary_not_clamped() {
        let data = DiagramData::from_raw("X", "base-fret 1 frets 0 5 0 0 0 0", 6).unwrap();
        assert_eq!(data.frets[1], 5);
    }

    #[test]
    fn test_fret_within_range_unchanged() {
        let data = DiagramData::from_raw("X", "base-fret 1 frets 0 3 0 0 0 0", 6).unwrap();
        assert_eq!(data.frets[1], 3);
    }

    #[test]
    fn test_muted_and_open_not_clamped() {
        let data = DiagramData::from_raw("X", "frets x 0 1 2 3 4", 6).unwrap();
        assert_eq!(data.frets[0], -1); // muted
        assert_eq!(data.frets[1], 0); // open
    }

    #[test]
    fn test_extreme_fret_value_clamped() {
        let data = DiagramData::from_raw("X", "frets 1000 0 0 0 0 0", 6).unwrap();
        assert_eq!(data.frets[0], 5);
    }

    // --- Edge case tests (#472) ---

    #[test]
    fn test_seven_string_instrument() {
        let data = DiagramData::from_raw("X", "frets 0 0 0 0 0 0 0", 7).unwrap();
        assert_eq!(data.strings, 7);
        let svg = render_svg(&data);
        assert!(svg.contains("<svg"));
    }

    #[test]
    fn test_eight_string_instrument() {
        let data = DiagramData::from_raw("X", "frets 0 0 0 0 0 0 0 0", 8).unwrap();
        assert_eq!(data.strings, 8);
        let svg = render_svg(&data);
        assert!(svg.contains("<svg"));
    }

    #[test]
    fn test_twelve_string_renders_without_panic() {
        let data = DiagramData::from_raw("G12", "frets 0 0 0 0 0 0 0 0 0 0 0 0", 12).unwrap();
        let svg = render_svg(&data);
        assert!(svg.contains("G12"));
    }

    #[test]
    fn test_fewer_fingers_than_frets() {
        let data = DiagramData::from_raw("Am", "frets x 0 2 2 1 0 fingers 0 0 2", 6).unwrap();
        assert_eq!(data.frets.len(), 6);
        assert_eq!(data.fingers.len(), 3);
        // Should render without panic
        let svg = render_svg(&data);
        assert!(svg.contains("<svg"));
    }

    #[test]
    fn test_empty_frets_rejected() {
        assert!(DiagramData::from_raw("X", "base-fret 1", 6).is_none());
    }

    #[test]
    fn test_non_numeric_fret_treated_as_muted() {
        let data = DiagramData::from_raw("X", "frets abc 0 0 0 0 0", 6).unwrap();
        // Non-numeric values parsed as -1 (same as 'x')
        assert_eq!(data.frets[0], -1);
    }

    #[test]
    fn test_extreme_base_fret() {
        // base_fret is clamped to 1..=24
        let data = DiagramData::from_raw("X", "base-fret 1000 frets 1 2 3 4 5 6", 6).unwrap();
        assert_eq!(data.base_fret, 24);
        let svg = render_svg(&data);
        // The base-fret label dropped the `fr` suffix — bare
        // integer only.
        assert!(svg.contains(">24</text>"));
        assert!(!svg.contains("24fr"));
    }

    #[test]
    fn test_all_muted_strings() {
        let data = DiagramData::from_raw("X", "frets x x x x x x", 6).unwrap();
        assert!(data.frets.iter().all(|&f| f == -1));
        let svg = render_svg(&data);
        assert!(svg.contains("<svg"));
    }

    #[test]
    fn test_all_open_strings() {
        let data = DiagramData::from_raw("Open", "frets 0 0 0 0 0 0", 6).unwrap();
        assert!(data.frets.iter().all(|&f| f == 0));
        let svg = render_svg(&data);
        assert!(svg.contains("<svg"));
    }

    #[test]
    fn test_format_stops_fret_parsing() {
        // "format" as a standalone token should act as a stop-word,
        // preventing it from being misinterpreted as a fret value.
        let data = DiagramData::from_raw("Am", "base-fret 1 frets x 0 2 2 1 0 format", 6).unwrap();
        assert_eq!(data.frets, vec![-1, 0, 2, 2, 1, 0]);
    }

    // --- base-fret stop-word and clamping (#603, #604) ---

    #[test]
    fn test_base_fret_after_frets_is_stop_word() {
        // "base-fret" appearing after "frets" should stop fret parsing,
        // not be treated as a fret value.
        let data = DiagramData::from_raw("Am", "frets x 0 2 2 1 0 base-fret 3", 6).unwrap();
        assert_eq!(data.frets, vec![-1, 0, 2, 2, 1, 0]);
        assert_eq!(data.base_fret, 3);
    }

    #[test]
    fn test_base_fret_after_fingers_is_stop_word() {
        // "base-fret" should also stop finger parsing.
        let data =
            DiagramData::from_raw("C", "frets x 3 2 0 1 0 fingers 0 3 2 0 1 0 base-fret 2", 6)
                .unwrap();
        assert_eq!(data.fingers, vec![0, 3, 2, 0, 1, 0]);
        assert_eq!(data.base_fret, 2);
    }

    #[test]
    fn test_format_stops_finger_parsing() {
        // "format" should stop finger parsing.
        let data =
            DiagramData::from_raw("C", "frets x 3 2 0 1 0 fingers 0 3 2 0 1 0 format", 6).unwrap();
        assert_eq!(data.fingers, vec![0, 3, 2, 0, 1, 0]);
    }

    #[test]
    fn test_base_fret_zero_clamped_to_one() {
        let data = DiagramData::from_raw("Am", "base-fret 0 frets x 0 2 2 1 0", 6).unwrap();
        assert_eq!(data.base_fret, 1);
    }

    #[test]
    fn test_base_fret_negative_defaults_to_one() {
        // Negative value fails u32 parse, falls back to unwrap_or(1).
        let data = DiagramData::from_raw("Am", "base-fret -1 frets x 0 2 2 1 0", 6).unwrap();
        assert_eq!(data.base_fret, 1);
    }

    #[test]
    fn test_base_fret_large_value_clamped() {
        let data = DiagramData::from_raw("Am", "base-fret 100 frets x 0 2 2 1 0", 6).unwrap();
        assert_eq!(data.base_fret, 24);
    }

    // --- render_svg input guard (#606) ---

    #[test]
    fn test_render_svg_zero_strings_returns_empty() {
        let data = DiagramData {
            name: "X".to_string(),
            display_name: None,
            strings: 0,
            frets_shown: 5,
            base_fret: 1,
            frets: vec![],
            fingers: vec![],
        };
        assert!(render_svg(&data).is_empty());
    }

    #[test]
    fn test_render_svg_one_string_returns_empty() {
        let data = DiagramData {
            name: "X".to_string(),
            display_name: None,
            strings: 1,
            frets_shown: 5,
            base_fret: 1,
            frets: vec![0],
            fingers: vec![],
        };
        assert!(render_svg(&data).is_empty());
    }

    // --- "frets" stop-word in fingers parser (#616) ---

    #[test]
    fn test_frets_stops_finger_parsing() {
        // "frets" after "fingers" should stop finger parsing. The outer
        // loop then re-enters the "frets" arm for the second batch, so
        // both batches of fret values are accumulated.
        let data =
            DiagramData::from_raw("Am", "frets x 0 2 2 1 0 fingers 0 0 2 frets x 0 2 2 1 0", 6)
                .unwrap();
        // Only 3 finger values before the second "frets" token.
        assert_eq!(data.fingers, vec![0, 0, 2]);
        // Both frets batches (6 + 6) are accumulated by the outer loop.
        assert_eq!(data.frets.len(), 12);
        // strings is max(num_strings, frets.len()) = max(6, 12) = 12.
        assert_eq!(data.strings, 12);
    }

    #[test]
    fn test_repeated_frets_keyword_not_consumed_as_value() {
        // The "frets" keyword should not be consumed as a fret value.
        // Without the stop-word, "frets" would parse as -1 via unwrap_or.
        let data = DiagramData::from_raw("Am", "frets 1 2 3 frets 4 5 6", 0).unwrap();
        // The outer loop processes both "frets" arms; 3 + 3 = 6 values.
        assert_eq!(data.frets.len(), 6);
        // No -1 value from "frets" being misinterpreted as a fret.
        assert!(!data.frets.contains(&-1));
    }

    // --- from_raw_frets / from_raw_infer_frets tests (#623) ---

    #[test]
    fn test_from_raw_frets_custom_frets_shown() {
        let data =
            DiagramData::from_raw_frets("Am", "base-fret 1 frets x 0 2 2 1 0", 6, 4).unwrap();
        assert_eq!(data.frets_shown, 4);
    }

    #[test]
    fn test_from_raw_infer_frets_custom_frets_shown() {
        let data =
            DiagramData::from_raw_infer_frets("Am", "base-fret 1 frets x 0 2 2 1 0", 3).unwrap();
        assert_eq!(data.frets_shown, 3);
    }

    #[test]
    fn test_from_raw_frets_clamps_fret_values() {
        // With frets_shown=3, fret value 5 should be clamped to 3.
        let data =
            DiagramData::from_raw_frets("Am", "base-fret 1 frets 0 5 0 0 0 0", 6, 3).unwrap();
        assert_eq!(data.frets[1], 3);
    }

    // --- render_svg frets_shown guard (#625) ---

    #[test]
    fn test_render_svg_zero_frets_shown_returns_empty() {
        let data = DiagramData {
            name: "X".to_string(),
            display_name: None,
            strings: 6,
            frets_shown: 0,
            base_fret: 1,
            frets: vec![0, 0, 0, 0, 0, 0],
            fingers: vec![],
        };
        assert!(render_svg(&data).is_empty());
    }

    // --- render_svg MAX_STRINGS guard (#658) ---

    #[test]
    fn test_render_svg_exceeding_max_strings_returns_empty() {
        let data = DiagramData {
            name: "X".to_string(),
            display_name: None,
            strings: 13,
            frets_shown: 5,
            base_fret: 1,
            frets: vec![0; 13],
            fingers: vec![],
        };
        assert!(render_svg(&data).is_empty());
    }

    #[test]
    fn test_render_svg_at_max_strings_ok() {
        let data = DiagramData {
            name: "X".to_string(),
            display_name: None,
            strings: MAX_STRINGS,
            frets_shown: 5,
            base_fret: 1,
            frets: vec![0; MAX_STRINGS],
            fingers: vec![],
        };
        assert!(!render_svg(&data).is_empty());
    }

    // --- render_svg MAX_FRETS_SHOWN guard (#675) ---

    #[test]
    fn test_render_svg_exceeding_max_frets_shown_returns_empty() {
        let data = DiagramData {
            name: "X".to_string(),
            display_name: None,
            strings: 6,
            frets_shown: MAX_FRETS_SHOWN + 1,
            base_fret: 1,
            frets: vec![0; 6],
            fingers: vec![],
        };
        assert!(render_svg(&data).is_empty());
    }

    #[test]
    fn test_render_svg_at_max_frets_shown_ok() {
        let data = DiagramData {
            name: "X".to_string(),
            display_name: None,
            strings: 6,
            frets_shown: MAX_FRETS_SHOWN,
            base_fret: 1,
            frets: vec![0; 6],
            fingers: vec![],
        };
        assert!(!render_svg(&data).is_empty());
    }

    // --- from_raw_frets clamps frets_shown (#691) ---

    #[test]
    fn test_from_raw_frets_clamps_excessive_frets_shown() {
        // frets_shown > MAX_FRETS_SHOWN should be clamped, not rejected.
        let data = DiagramData::from_raw_frets("Am", "frets x 0 2 2 1 0", 6, 100).unwrap();
        assert_eq!(data.frets_shown, MAX_FRETS_SHOWN);
    }

    #[test]
    fn test_from_raw_frets_clamps_zero_frets_shown() {
        // frets_shown = 0 should be clamped to MIN_FRETS_SHOWN, not rejected.
        let data = DiagramData::from_raw_frets("Am", "frets x 0 2 2 1 0", 6, 0).unwrap();
        assert_eq!(data.frets_shown, MIN_FRETS_SHOWN);
    }

    // --- "fingers" self-referencing stop-word (#647) ---

    #[test]
    fn test_duplicate_fingers_keyword_is_stop_word() {
        // Duplicate "fingers" keyword should stop finger parsing, not be
        // parsed as a finger value.
        let data = DiagramData::from_raw("Am", "frets x 0 2 2 1 0 fingers 0 0 2 fingers 0 0 2", 6)
            .unwrap();
        // First "fingers" arm collects [0, 0, 2], stops at second "fingers";
        // outer loop re-enters the arm and collects [0, 0, 2] → total 6.
        assert_eq!(data.fingers.len(), 6);
        // No spurious 0 from parsing the keyword.
        assert_eq!(data.fingers, vec![0, 0, 2, 0, 0, 2]);
    }

    #[test]
    fn test_finger_overflow_beyond_u8_max_stops_parsing() {
        // A finger token that does not parse as `u8` (e.g. `256`) stops the
        // `fingers` section instead of silently being mapped to `0`
        // (the "no finger" sentinel). Everything from the invalid token
        // onwards is dropped, so the diagram is returned with an empty
        // `fingers` list — which the renderer treats as "no finger
        // annotations", not "no-finger-on-string" per slot.
        //
        // Regression guard for the silent-fallback behaviour previously
        // captured by `test_finger_overflow_beyond_u8_max_becomes_zero`;
        // see code-style.md §Silent Fallback.
        let data =
            DiagramData::from_raw("Am", "frets x 0 2 2 1 0 fingers 256 1 2 3 1 0", 6).unwrap();
        assert!(
            data.fingers.is_empty(),
            "invalid finger token must stop parsing, not silently become 0: {:?}",
            data.fingers
        );
    }

    #[test]
    fn test_finger_garbage_token_stops_parsing() {
        // A non-numeric finger token also stops the `fingers` section
        // rather than silently becoming `0`.
        let data =
            DiagramData::from_raw("Am", "frets x 0 2 2 1 0 fingers abc 1 2 3 1 0", 6).unwrap();
        assert!(
            data.fingers.is_empty(),
            "garbage finger token must stop parsing: {:?}",
            data.fingers
        );
    }

    #[test]
    fn test_valid_fingers_before_invalid_are_kept() {
        // Valid finger numbers before an invalid token are preserved; the
        // parser simply stops at the first parse failure.
        let data =
            DiagramData::from_raw("Am", "frets x 0 2 2 1 0 fingers 0 3 2 abc 1 0", 6).unwrap();
        assert_eq!(data.fingers, vec![0, 3, 2]);
    }

    // --- Negative fret clamping (#648) ---

    #[test]
    fn test_negative_fret_below_minus_one_clamped() {
        let data = DiagramData::from_raw("X", "frets -5 0 2 2 1 0", 6).unwrap();
        // -5 should be treated as -1 (muted)
        assert_eq!(data.frets[0], -1);
    }

    #[test]
    fn test_minus_one_fret_unchanged() {
        let data = DiagramData::from_raw("X", "frets -1 0 2 2 1 0", 6).unwrap();
        assert_eq!(data.frets[0], -1);
    }

    #[test]
    fn test_large_negative_fret_clamped() {
        let data = DiagramData::from_raw("X", "frets -100 0 0 0 0 0", 6).unwrap();
        assert_eq!(data.frets[0], -1);
    }

    // --- Case-insensitive keyword matching (#651) ---

    #[test]
    fn test_mixed_case_keywords() {
        let data =
            DiagramData::from_raw("Am", "Base-Fret 3 Frets x 0 2 2 1 0 Fingers 0 0 2 3 1 0", 6)
                .unwrap();
        assert_eq!(data.base_fret, 3);
        assert_eq!(data.frets, vec![-1, 0, 2, 2, 1, 0]);
        assert_eq!(data.fingers, vec![0, 0, 2, 3, 1, 0]);
    }

    #[test]
    fn test_uppercase_keywords() {
        let data =
            DiagramData::from_raw("Am", "BASE-FRET 2 FRETS X 0 2 2 1 0 FINGERS 0 0 2 3 1 0", 6)
                .unwrap();
        assert_eq!(data.base_fret, 2);
        assert_eq!(data.frets, vec![-1, 0, 2, 2, 1, 0]);
        assert_eq!(data.fingers, vec![0, 0, 2, 3, 1, 0]);
    }

    #[test]
    fn test_mixed_case_display_stop_word() {
        let data = DiagramData::from_raw("Am", "frets x 0 2 2 1 0 Display", 6).unwrap();
        // "Display" should stop fret parsing (case-insensitive)
        assert_eq!(data.frets, vec![-1, 0, 2, 2, 1, 0]);
    }

    #[test]
    fn test_mixed_case_format_stop_word() {
        let data = DiagramData::from_raw("Am", "frets x 0 2 2 1 0 Format", 6).unwrap();
        assert_eq!(data.frets, vec![-1, 0, 2, 2, 1, 0]);
    }

    // --- Fewer fret values than string count (#660) ---

    #[test]
    fn test_fewer_fret_values_than_num_strings() {
        // 3 fret values but num_strings=6 -> strings=6, only 3 have markers
        let data = DiagramData::from_raw("X", "frets 1 2 3", 6).unwrap();
        assert_eq!(data.strings, 6);
        assert_eq!(data.frets.len(), 3);
        // Should render without panic; remaining strings have no markers
        let svg = render_svg(&data);
        assert!(svg.contains("<svg"));
    }

    #[test]
    fn test_fewer_fret_values_inferred() {
        // With from_raw_infer, strings = frets.len()
        let data = DiagramData::from_raw_infer("X", "frets 1 2 3").unwrap();
        assert_eq!(data.strings, 3);
        assert_eq!(data.frets.len(), 3);
    }

    // ---------------------------------------------------------------------------
    // KeyboardVoicing and render_keyboard_svg tests
    // ---------------------------------------------------------------------------

    #[test]
    fn test_render_keyboard_svg_absolute_midi() {
        let v = KeyboardVoicing {
            name: "Cmaj7".to_string(),
            display_name: None,
            keys: vec![60, 64, 67, 71],
            root_key: 60,
        };
        let svg = render_keyboard_svg(&v);
        assert!(svg.contains("<svg"));
        assert!(svg.contains("</svg>"));
        assert!(svg.contains("Cmaj7"));
        assert!(svg.contains("class=\"keyboard-diagram\""));
        // Highlighted keys use blue fill
        assert!(svg.contains("#4a90e2") || svg.contains("#1a5fb4"));
    }

    #[test]
    fn test_render_keyboard_svg_pitch_classes_normalised_to_octave4() {
        // keys 0 3 7 (pitch classes) should be shown in octave 4
        let v = KeyboardVoicing {
            name: "Am".to_string(),
            display_name: None,
            keys: vec![0, 3, 7],
            root_key: 0,
        };
        let svg = render_keyboard_svg(&v);
        assert!(svg.contains("<svg"));
        assert!(svg.contains("Am"));
    }

    #[test]
    fn test_render_keyboard_svg_empty_keys_returns_empty() {
        let v = KeyboardVoicing {
            name: "X".to_string(),
            display_name: None,
            keys: vec![],
            root_key: 60,
        };
        assert_eq!(render_keyboard_svg(&v), "");
    }

    #[test]
    fn test_render_keyboard_svg_display_name_override() {
        let v = KeyboardVoicing {
            name: "Am".to_string(),
            display_name: Some("A minor".to_string()),
            keys: vec![69, 72, 76],
            root_key: 69,
        };
        let svg = render_keyboard_svg(&v);
        assert!(svg.contains("A minor"));
        assert!(!svg.contains(">Am<"));
    }

    #[test]
    fn test_keyboard_voicing_title() {
        let v = KeyboardVoicing {
            name: "G".to_string(),
            display_name: Some("G major".to_string()),
            keys: vec![67, 71, 74],
            root_key: 67,
        };
        assert_eq!(v.title(), "G major");
        let v2 = KeyboardVoicing {
            name: "G".to_string(),
            display_name: None,
            keys: vec![67, 71, 74],
            root_key: 67,
        };
        assert_eq!(v2.title(), "G");
    }

    #[test]
    fn test_resolve_diagrams_instrument_piano() {
        assert_eq!(
            resolve_diagrams_instrument(Some("piano"), "guitar"),
            Some("piano".to_string())
        );
        assert_eq!(
            resolve_diagrams_instrument(Some("keys"), "guitar"),
            Some("piano".to_string())
        );
        assert_eq!(
            resolve_diagrams_instrument(Some("keyboard"), "guitar"),
            Some("piano".to_string())
        );
    }

    // ---------------------------------------------------------------------------
    // normalise_keyboard_keys — public API contract
    // ---------------------------------------------------------------------------

    #[test]
    fn normalise_keyboard_keys_empty_slice_shifts_pitch_class_root() {
        // When keys is empty, all() is vacuously true, so a pitch-class root_key
        // is still shifted to octave 4.  Both current callers guard against
        // empty keys before calling this function, but the contract is
        // machine-checked here so regressions are caught.
        let (keys_out, root_out) = normalise_keyboard_keys(&[], 0);
        assert!(keys_out.is_empty());
        assert_eq!(
            root_out, 60,
            "pitch-class root 0 should be shifted to C4 (60)"
        );

        let (keys_out2, root_out2) = normalise_keyboard_keys(&[], 9);
        assert!(keys_out2.is_empty());
        assert_eq!(
            root_out2, 69,
            "pitch-class root 9 should be shifted to A4 (69)"
        );
    }

    #[test]
    fn normalise_keyboard_keys_empty_slice_absolute_root_unchanged() {
        // A root_key >= 12 is not shifted, even when keys is empty.
        let (keys_out, root_out) = normalise_keyboard_keys(&[], 60);
        assert!(keys_out.is_empty());
        assert_eq!(root_out, 60, "absolute root_key must not be shifted");
    }

    // -----------------------------------------------------------------------
    // Horizontal orientation (#2572)
    // -----------------------------------------------------------------------

    /// Returns the SVG output for an Am open-position chord rendered in
    /// horizontal mode (reader-view — high pitch on top, the only horizontal
    /// layout the project ships per ADR-0026).
    fn horizontal_am_svg() -> String {
        let data = DiagramData {
            name: "Am".to_string(),
            display_name: None,
            strings: 6,
            frets_shown: 5,
            base_fret: 1,
            frets: vec![-1, 0, 2, 2, 1, 0],
            fingers: vec![],
        };
        render_svg_with_orientation(&data, Orientation::Horizontal)
    }

    #[test]
    fn render_svg_vertical_default_matches_render_svg() {
        // The render_svg() wrapper must produce byte-identical output to an
        // explicit Vertical + default-string-order call. Any drift here means
        // some existing caller would see a behaviour change.
        let data = DiagramData {
            name: "C".to_string(),
            display_name: None,
            strings: 6,
            frets_shown: 5,
            base_fret: 1,
            frets: vec![-1, 3, 2, 0, 1, 0],
            fingers: vec![0, 3, 2, 0, 1, 0],
        };
        let via_wrapper = render_svg(&data);
        let explicit = render_svg_with_orientation(&data, Orientation::Vertical);
        assert_eq!(via_wrapper, explicit);
    }

    #[test]
    fn horizontal_emits_horizontal_class_marker() {
        let svg = horizontal_am_svg();
        assert!(
            svg.contains("class=\"chord-diagram chord-diagram-horizontal\""),
            "expected horizontal-mode class marker; got: {svg}"
        );
    }

    #[test]
    fn horizontal_open_position_has_nut_as_vertical_line() {
        // base_fret == 1 ⇒ nut is the leftmost vertical line, thick stroke.
        // The vertical-renderer test asserts a horizontal nut line at
        // `y1=TOP_MARGIN y2=TOP_MARGIN` with `stroke-width=\"3\"`; the
        // horizontal-mode analogue is a vertical line at
        // `x1=LEFT_MARGIN x2=LEFT_MARGIN`.
        let svg = horizontal_am_svg();
        assert!(
            svg.contains("x1=\"20\" y1=\"30\" x2=\"20\""),
            "expected vertical nut line anchored at LEFT_MARGIN/TOP_MARGIN; got: {svg}"
        );
        assert!(svg.contains("stroke-width=\"3\""));
    }

    #[test]
    fn horizontal_base_fret_label_above_first_fret_when_high_position() {
        // base_fret > 1 ⇒ no nut line, instead a fret-number label above the
        // leftmost fret cell. Mirrors the vertical-mode bare-integer label at
        // the left of the first fret row.
        let data = DiagramData {
            name: "Bm".to_string(),
            display_name: None,
            strings: 6,
            frets_shown: 5,
            base_fret: 7,
            frets: vec![-1, 1, 3, 3, 2, 1],
            fingers: vec![],
        };
        let svg = render_svg_with_orientation(&data, Orientation::Horizontal);
        assert!(
            svg.contains(">7</text>"),
            "expected bare base-fret label 7; got: {svg}"
        );
        // No thick nut line when starting above fret 1.
        assert!(!svg.contains("stroke-width=\"3\""));
    }

    #[test]
    fn horizontal_open_and_muted_markers_sit_left_of_nut() {
        // Open / muted markers are placed at x = LEFT_MARGIN - 10 = 10 in
        // horizontal mode (the analogue of the vertical mode's y = nut_y - 10
        // placement above the nut).
        let svg = horizontal_am_svg();
        // "X" mute glyph at x=10 for the muted 6th string.
        assert!(
            svg.contains("<text x=\"10\""),
            "expected muted-X glyph anchored at x=10; got: {svg}"
        );
        // Open-string circle at cx=10.
        assert!(
            svg.contains("<circle cx=\"10\""),
            "expected open-string circle at cx=10; got: {svg}"
        );
    }

    #[test]
    fn horizontal_reader_view_places_high_string_on_top() {
        // Reader-view (the only horizontal layout): in ChordPro's low-to-high
        // `frets` ordering, index 5 (high E for guitar) sits on row 0 (top).
        // For Am the open 1st string (i=5, fret=0) produces an open-circle on
        // the top row at y = TOP_MARGIN = 30.
        let svg = horizontal_am_svg();
        assert!(
            svg.contains("<circle cx=\"10\" cy=\"30\""),
            "expected open marker for high E on top row (cy=30); got: {svg}"
        );
    }

    #[test]
    fn horizontal_position_marker_at_centre_row_when_visible() {
        // A C chord at the nut (base_fret = 1, 5 visible frets) shows the
        // fret-3 and fret-5 inlay dots — same as the vertical renderer. The
        // horizontal-mode dots sit at the **centre row** (cy = center_y).
        let data = DiagramData {
            name: "C".to_string(),
            display_name: None,
            strings: 6,
            frets_shown: 5,
            base_fret: 1,
            frets: vec![-1, 3, 2, 0, 1, 0],
            fingers: vec![],
        };
        let svg = render_svg_with_orientation(&data, Orientation::Horizontal);
        let count = svg.matches("class=\"position-marker\"").count();
        // Inlay frets in [1..=5] for guitar = 3 and 5 → 2 markers (same as
        // the vertical-mode count; just placed along the horizontal axis).
        assert_eq!(count, 2);
    }

    #[test]
    fn horizontal_twelfth_fret_double_dot_splits_vertically() {
        // The 12-fret octave inlay must render as TWO dots split along the
        // **vertical** axis in horizontal mode (the geometric mirror of the
        // vertical renderer's horizontal split via cx ± CELL_W * 0.55).
        let data = DiagramData {
            name: "C".to_string(),
            display_name: None,
            strings: 6,
            frets_shown: 5,
            base_fret: 9, // visible frets 9..=13 include 12
            frets: vec![-1; 6],
            fingers: vec![],
        };
        let svg = render_svg_with_orientation(&data, Orientation::Horizontal);
        let count = svg.matches("class=\"position-marker\"").count();
        // Visible inlay frets: 9 (single) + 12 (double) = 3 dots.
        assert_eq!(
            count, 3,
            "expected 1 single + 2 (double at 12); got svg: {svg}"
        );
        // The two octave dots must share an x-coordinate (vertical split)
        // and differ only in y. Look for two dots with the same cx and the
        // characteristic ± string_pitch * 0.55 offset from the centre row.
        // For 6-string guitar in horizontal mode the string axis uses
        // string_pitch = CELL_W = 16:
        //   grid_h = (6 - 1) * 16 = 80; center_y = TOP_MARGIN + 40 = 70;
        //   16 * 0.55 = 8.8; so cy1 = 61.2, cy2 = 78.8.
        assert!(
            svg.contains("cy=\"61.2\"") && svg.contains("cy=\"78.8\""),
            "expected 12-fret double dot at cy=61.2 / cy=78.8; got: {svg}"
        );
    }

    #[test]
    fn horizontal_render_ascii_unchanged_across_orientations() {
        // render_ascii has no orientation knob — assert the rustdoc claim
        // ("Orientation has no effect on this output") with byte identity.
        let data = DiagramData {
            name: "Am".to_string(),
            display_name: None,
            strings: 6,
            frets_shown: 5,
            base_fret: 1,
            frets: vec![-1, 0, 2, 2, 1, 0],
            fingers: vec![],
        };
        let ascii = render_ascii(&data);
        assert_eq!(ascii, "Am\nx o 2 2 1 o");
    }

    #[test]
    fn horizontal_invalid_strings_returns_empty_like_vertical() {
        // The bounds-check at the top of render_svg_with_orientation must
        // fire for both orientations equally; horizontal mode does not bypass
        // it.
        let data = DiagramData {
            name: "X".to_string(),
            display_name: None,
            strings: 1, // below MIN_STRINGS
            frets_shown: 5,
            base_fret: 1,
            frets: vec![0],
            fingers: vec![],
        };
        assert!(render_svg_with_orientation(&data, Orientation::Horizontal).is_empty());
    }

    #[test]
    fn orientation_default_is_vertical() {
        // The Default for Orientation must stay Vertical so legacy call
        // sites that pass `Orientation::default()` keep their existing
        // behaviour.
        assert_eq!(Orientation::default(), Orientation::Vertical);
    }

    #[test]
    fn horizontal_renderer_honours_display_name_override() {
        // Sister test to `test_render_svg_with_display_name` (vertical).
        // Catches a future refactor that hardcodes `data.name` instead
        // of `data.title()` in the horizontal path.
        let data = DiagramData {
            name: "Am".to_string(),
            display_name: Some("A minor".to_string()),
            strings: 6,
            frets_shown: 5,
            base_fret: 1,
            frets: vec![-1, 0, 2, 2, 1, 0],
            fingers: vec![],
        };
        let svg = render_svg_with_orientation(&data, Orientation::Horizontal);
        assert!(svg.contains("A minor"));
        assert!(!svg.contains(">Am<"));
    }

    #[test]
    fn horizontal_ukulele_twelfth_fret_double_dot() {
        // Sister to `horizontal_twelfth_fret_double_dot_splits_vertically`
        // for ukulele (4 strings; inlay frets are 3, 5, 7, 10, 12, 15 per
        // `position_marker_frets`). Catches future regressions where the
        // 4-string horizontal path silently loses the double-dot.
        let data = DiagramData {
            name: "C".to_string(),
            display_name: None,
            strings: 4,
            frets_shown: 5,
            base_fret: 9, // visible frets 9..=13 include 10 and 12
            frets: vec![-1, -1, -1, -1],
            fingers: vec![],
        };
        let svg = render_svg_with_orientation(&data, Orientation::Horizontal);
        let count = svg.matches("class=\"position-marker\"").count();
        // Visible inlay frets: 10 (single) + 12 (double) = 3 dots.
        assert_eq!(
            count, 3,
            "expected 1 single + 2 (double at 12); got svg: {svg}"
        );
        // For 4-string ukulele in horizontal mode: string_pitch = CELL_W = 16,
        //   grid_h = (4 - 1) * 16 = 48; center_y = TOP_MARGIN + 24 = 54;
        //   16 * 0.55 = 8.8; so cy1 = 45.2, cy2 = 62.8.
        assert!(
            svg.contains("cy=\"45.2\"") && svg.contains("cy=\"62.8\""),
            "expected 12-fret double dot at cy=45.2 / cy=62.8; got: {svg}",
        );
    }

    #[test]
    fn render_svg_default_byte_identical_across_chord_shapes() {
        // Stronger backward-compat than the single-chord
        // `render_svg_vertical_default_matches_render_svg` — exercises
        // the muted-X, open-O, and base_fret > 1 label code paths so a
        // future refactor of `render_svg_vertical_inner` cannot silently
        // change any of them without failing.
        let shapes = [
            // Open-position C with fingers.
            DiagramData {
                name: "C".to_string(),
                display_name: None,
                strings: 6,
                frets_shown: 5,
                base_fret: 1,
                frets: vec![-1, 3, 2, 0, 1, 0],
                fingers: vec![0, 3, 2, 0, 1, 0],
            },
            // All-muted (exercises only the X-glyph path).
            DiagramData {
                name: "X".to_string(),
                display_name: None,
                strings: 6,
                frets_shown: 5,
                base_fret: 1,
                frets: vec![-1; 6],
                fingers: vec![],
            },
            // All-open (exercises only the open-circle path).
            DiagramData {
                name: "Open".to_string(),
                display_name: None,
                strings: 6,
                frets_shown: 5,
                base_fret: 1,
                frets: vec![0; 6],
                fingers: vec![],
            },
            // Barre at base_fret > 1 (exercises the bare-fret label path).
            DiagramData {
                name: "Bm".to_string(),
                display_name: None,
                strings: 6,
                frets_shown: 5,
                base_fret: 7,
                frets: vec![-1, 1, 3, 3, 2, 1],
                fingers: vec![],
            },
            // Ukulele (exercises the 4-string branch).
            DiagramData {
                name: "C".to_string(),
                display_name: None,
                strings: 4,
                frets_shown: 5,
                base_fret: 1,
                frets: vec![0, 0, 0, 3],
                fingers: vec![],
            },
        ];
        for data in &shapes {
            let via_wrapper = render_svg(data);
            let explicit = render_svg_with_orientation(data, Orientation::Vertical);
            assert_eq!(
                via_wrapper, explicit,
                "render_svg() drifted from explicit Vertical for shape {:?}",
                data.name,
            );
        }
    }

    #[test]
    fn horizontal_aspect_is_wider_than_tall_vertical_is_taller_than_wide() {
        // The horizontal renderer must use the SVG's wider dimension for
        // the fret axis (otherwise the fretboard reads as a vertical
        // diagram with its labels rearranged rather than a genuinely
        // horizontal layout). Conversely, vertical must stay tall. The
        // explicit `width` / `height` attributes pin the contract — a
        // future change to the pitch constants that breaks the
        // proportion will fail this test before any visual check.
        let data = DiagramData {
            name: "Am".to_string(),
            display_name: None,
            strings: 6,
            frets_shown: 5,
            base_fret: 1,
            frets: vec![-1, 0, 2, 2, 1, 0],
            fingers: vec![],
        };
        let extract = |svg: &str, attr: &str| -> f32 {
            let needle = format!("{attr}=\"");
            let i = svg.find(&needle).unwrap() + needle.len();
            let j = svg[i..].find('"').unwrap();
            svg[i..i + j].parse().unwrap()
        };

        let vertical = render_svg_with_orientation(&data, Orientation::Vertical);
        let v_w = extract(&vertical, "width");
        let v_h = extract(&vertical, "height");
        assert!(
            v_h > v_w,
            "vertical SVG must be taller than wide (got width={v_w}, height={v_h})",
        );

        let horizontal = render_svg_with_orientation(&data, Orientation::Horizontal);
        let h_w = extract(&horizontal, "width");
        let h_h = extract(&horizontal, "height");
        assert!(
            h_w > h_h,
            "horizontal SVG must be wider than tall (got width={h_w}, height={h_h})",
        );
    }

    // -----------------------------------------------------------------------
    // Resolver-edge cases (#2572) — bound the to_ascii_lowercase
    // allocation and reject empty strings.
    // -----------------------------------------------------------------------

    #[test]
    fn resolve_orientation_rejects_oversized_input() {
        // A multi-kilobyte string must not pay the to_ascii_lowercase
        // cost; the resolver falls back to vertical without allocating
        // the full buffer.
        let big = "a".repeat(MAX_RESOLVER_INPUT_LEN + 1);
        assert_eq!(resolve_orientation(Some(&big)), Orientation::Vertical);
        assert_eq!(try_parse_orientation_value(Some(&big)), None);
    }

    #[test]
    fn resolve_orientation_accepts_input_at_length_cap() {
        // Boundary check: exactly MAX_RESOLVER_INPUT_LEN bytes is allowed.
        let at_cap = "a".repeat(MAX_RESOLVER_INPUT_LEN);
        assert_eq!(try_parse_orientation_value(Some(&at_cap)), None);
        // "horizontal" (10 bytes) is well under the cap and still parses.
        assert_eq!(
            try_parse_orientation_value(Some("horizontal")),
            Some(OrientationKind::Horizontal),
        );
    }

    #[test]
    fn resolve_orientation_empty_string_is_default() {
        assert_eq!(resolve_orientation(Some("")), Orientation::Vertical);
        assert_eq!(try_parse_orientation_value(Some("")), None);
    }

    // -----------------------------------------------------------------------
    // DiagramsMode resolver edge cases (finding #5a)
    // -----------------------------------------------------------------------

    #[test]
    fn resolve_diagrams_mode_rejects_oversized_input() {
        let big = "a".repeat(MAX_RESOLVER_INPUT_LEN + 1);
        assert_eq!(try_parse_diagrams_mode(Some(&big)), None);
        assert_eq!(resolve_diagrams_mode(Some(&big)), DiagramsMode::Section);
    }

    #[test]
    fn resolve_diagrams_mode_empty_string_falls_back_to_section() {
        assert_eq!(try_parse_diagrams_mode(Some("")), None);
        assert_eq!(resolve_diagrams_mode(Some("")), DiagramsMode::Section);
    }

    // -----------------------------------------------------------------------
    // Compact diagram class coverage in the CORE crate (finding #5b)
    // -----------------------------------------------------------------------

    #[test]
    fn compact_vertical_guitar_carries_compact_class_not_horizontal() {
        let data = DiagramData {
            name: "Am".to_string(),
            display_name: None,
            strings: 6,
            frets_shown: 5,
            base_fret: 1,
            frets: vec![-1, 0, 2, 2, 1, 0],
            fingers: vec![],
        };
        let svg = render_svg_with_options(&data, Orientation::Vertical, DiagramSize::Compact);
        assert!(
            svg.contains("chord-diagram-compact"),
            "compact vertical guitar must carry chord-diagram-compact class; got: {svg}"
        );
        assert!(
            !svg.contains("chord-diagram-horizontal"),
            "compact vertical must not carry horizontal class; got: {svg}"
        );
    }

    #[test]
    fn compact_ukulele_carries_compact_class() {
        let data = DiagramData {
            name: "C".to_string(),
            display_name: None,
            strings: 4,
            frets_shown: 5,
            base_fret: 1,
            frets: vec![0, 0, 0, 3],
            fingers: vec![],
        };
        let svg = render_svg_with_options(&data, Orientation::Vertical, DiagramSize::Compact);
        assert!(
            svg.contains("chord-diagram-compact"),
            "compact ukulele (4-string) must carry chord-diagram-compact class; got: {svg}"
        );
    }

    #[test]
    fn compact_keyboard_carries_compact_class() {
        let v = KeyboardVoicing {
            name: "C".to_string(),
            display_name: None,
            keys: vec![60, 64, 67],
            root_key: 60,
        };
        let svg = render_keyboard_svg_with_size(&v, DiagramSize::Compact);
        assert!(
            svg.contains("keyboard-diagram-compact"),
            "compact keyboard must carry keyboard-diagram-compact class; got: {svg}"
        );
    }

    #[test]
    fn render_svg_with_options_regular_vertical_byte_identical_to_with_orientation() {
        // Back-compat pin: render_svg_with_options(data, Vertical, Regular)
        // must be byte-identical to render_svg_with_orientation(data, Vertical).
        let data = DiagramData {
            name: "Am".to_string(),
            display_name: None,
            strings: 6,
            frets_shown: 5,
            base_fret: 1,
            frets: vec![-1, 0, 2, 2, 1, 0],
            fingers: vec![],
        };
        let via_with_orientation = render_svg_with_orientation(&data, Orientation::Vertical);
        let via_with_options =
            render_svg_with_options(&data, Orientation::Vertical, DiagramSize::Regular);
        assert_eq!(
            via_with_orientation, via_with_options,
            "render_svg_with_options(Vertical, Regular) must be byte-identical to \
             render_svg_with_orientation(Vertical)"
        );
    }

    // -----------------------------------------------------------------------
    // Fret-number axis (#2602) — every fret line in the visible window is
    // labelled with its absolute fret number across both orientations.
    // -----------------------------------------------------------------------

    fn open_c() -> DiagramData {
        DiagramData {
            name: "C".to_string(),
            display_name: None,
            strings: 6,
            frets_shown: 5,
            base_fret: 1,
            frets: vec![-1, 3, 2, 0, 1, 0],
            fingers: vec![],
        }
    }

    #[test]
    fn fret_number_axis_vertical_open_position_labels_zero_through_frets_shown() {
        // base_fret == 1 with 5 visible frets → fret lines 0..=5 are each
        // labelled with their absolute fret number, the nut being 0.
        let svg = render_svg_with_orientation(&open_c(), Orientation::Vertical);
        let count = svg.matches("class=\"fret-number\"").count();
        assert_eq!(count, 6, "expected 6 fret-line labels (0..=5); got: {svg}");
        for n in 0..=5 {
            assert!(
                svg.contains(&format!("class=\"fret-number\">{n}</text>")),
                "expected fret-number label {n}; got: {svg}"
            );
        }
    }

    #[test]
    fn fret_number_axis_horizontal_open_position_sits_below_grid() {
        // Horizontal axis runs along the bottom of the grid (the `0 1 2 3`
        // strip under a horizontal fretboard). Labels are centred on each
        // fret line and middle-anchored.
        let svg = render_svg_with_orientation(&open_c(), Orientation::Horizontal);
        let count = svg.matches("class=\"fret-number\"").count();
        assert_eq!(count, 6, "expected 6 fret-line labels (0..=5); got: {svg}");
        // The leftmost label (0) is centred on the nut column at x = LEFT_MARGIN.
        assert!(
            svg.contains(
                "<text x=\"20\" y=\"120\" text-anchor=\"middle\" \
                 font-family=\"sans-serif\" font-size=\"10\" class=\"fret-number\">0</text>"
            ),
            "expected nut-column label 0 at x=20 y=120; got: {svg}"
        );
    }

    #[test]
    fn fret_number_axis_offset_by_base_fret() {
        // A barre window starting at base_fret 7 labels the fret WIRES it
        // spans: line 0 is the wire behind the window (6), and the visible
        // frets 7..=11 follow. The single legacy base-fret label is gone —
        // the axis subsumes it — so `7` appears exactly once.
        let data = DiagramData {
            name: "Bm".to_string(),
            display_name: None,
            strings: 6,
            frets_shown: 5,
            base_fret: 7,
            frets: vec![-1, 1, 3, 3, 2, 1],
            fingers: vec![],
        };
        for orientation in [Orientation::Vertical, Orientation::Horizontal] {
            let svg = render_svg_with_orientation(&data, orientation);
            for n in 6..=11 {
                assert!(
                    svg.contains(&format!("class=\"fret-number\">{n}</text>")),
                    "expected fret-number label {n} for {orientation:?}; got: {svg}"
                );
            }
            assert_eq!(
                svg.matches("class=\"fret-number\">7</text>").count(),
                1,
                "base-fret 7 must be labelled exactly once for {orientation:?}; got: {svg}"
            );
        }
    }

    #[test]
    fn fret_number_axis_omitted_in_compact_but_base_label_kept() {
        // Compact diagrams (above-a-lyric) suppress the full axis to stay
        // uncluttered, but must keep the legacy single base-fret label so a
        // high-position compact diagram still shows where it sits.
        let data = DiagramData {
            name: "Bm".to_string(),
            display_name: None,
            strings: 6,
            frets_shown: 5,
            base_fret: 7,
            frets: vec![-1, 1, 3, 3, 2, 1],
            fingers: vec![],
        };
        for orientation in [Orientation::Vertical, Orientation::Horizontal] {
            let svg = render_svg_with_options(&data, orientation, DiagramSize::Compact);
            assert!(
                !svg.contains("class=\"fret-number\""),
                "compact must not draw the full fret-number axis for {orientation:?}; got: {svg}"
            );
            assert!(
                svg.contains(">7</text>"),
                "compact must keep the single base-fret label 7 for {orientation:?}; got: {svg}"
            );
        }
    }

    #[test]
    fn fret_number_axis_does_not_grow_the_bounding_box() {
        // The axis is laid out inside the existing margins / bottom padding,
        // so adding it must not change either SVG's width or height. These
        // are the historical dimensions for a 6-string, 5-fret diagram.
        let extract = |svg: &str, attr: &str| -> f32 {
            let needle = format!("{attr}=\"");
            let i = svg.find(&needle).unwrap() + needle.len();
            let j = svg[i..].find('"').unwrap();
            svg[i..i + j].parse().unwrap()
        };
        // Every fret-number label's baseline y must fall inside the declared
        // height, so a future margin/font tweak that pushes a label past the
        // frame fails here rather than only being caught by eye.
        let label_ys = |svg: &str| -> Vec<f32> {
            svg.lines()
                .filter(|l| l.contains("class=\"fret-number\""))
                .map(|l| {
                    let needle = "y=\"";
                    let i = l.find(needle).unwrap() + needle.len();
                    let j = l[i..].find('"').unwrap();
                    l[i..i + j].parse().unwrap()
                })
                .collect()
        };
        let data = open_c();
        let v = render_svg_with_orientation(&data, Orientation::Vertical);
        assert_eq!(extract(&v, "width"), 120.0);
        assert_eq!(extract(&v, "height"), 160.0);
        let v_ys = label_ys(&v);
        assert!(
            v_ys.iter().all(|&y| y <= 160.0),
            "vertical fret-number labels overflow the frame: {v_ys:?}"
        );
        let h = render_svg_with_orientation(&data, Orientation::Horizontal);
        assert_eq!(extract(&h, "width"), 140.0);
        assert_eq!(extract(&h, "height"), 130.0);
        let h_ys = label_ys(&h);
        assert!(
            h_ys.iter().all(|&y| y <= 130.0),
            "horizontal fret-number labels overflow the frame: {h_ys:?}"
        );
    }

    #[test]
    fn render_rejects_out_of_range_base_fret() {
        // `base_fret` is a public field, so a direct caller can supply a
        // value the parser would have clamped. `base_fret == 0` would make
        // the axis emit a `-1` label; an over-MAX value an absurd one. Both
        // must be rejected (empty string) like out-of-range strings /
        // frets_shown, in both orientations and both sizes.
        for bad in [0, MAX_BASE_FRET + 1] {
            let data = DiagramData {
                name: "X".to_string(),
                display_name: None,
                strings: 6,
                frets_shown: 5,
                base_fret: bad,
                frets: vec![-1, 0, 2, 2, 1, 0],
                fingers: vec![],
            };
            for orientation in [Orientation::Vertical, Orientation::Horizontal] {
                for size in [DiagramSize::Regular, DiagramSize::Compact] {
                    assert!(
                        render_svg_with_options(&data, orientation, size).is_empty(),
                        "base_fret={bad} must render empty for {orientation:?}/{size:?}"
                    );
                }
            }
        }
    }
}
