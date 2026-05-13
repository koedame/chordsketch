//! Music-notation glyphs (key signature, metronome, time
//! signature) used as inline icons inside the `.meta-inline`
//! markers emitted by `render_song_body_into` for positional
//! `{key}` / `{tempo}` / `{time}` directives.
//!
//! Sister-site to `packages/react/src/music-glyphs.tsx` — the
//! React JSX walker emits the same DOM shape (5-line staff +
//! treble clef + accidentals for key signatures; animated
//! pendulum for the metronome; stacked numerator / denominator
//! for the time signature). Keeping the two in sync is a
//! `.claude/rules/renderer-parity.md` §"Sanitizer Parity (React
//! JSX surface)" obligation.
//!
//! These are hand-written simplified SVG paths rather than real
//! SMuFL Bravura outlines — at 24–32 px tall the simplified
//! shapes read as "music notation" without needing the full
//! Bravura font pulled in (Bravura is ~500 KB woff2).

use std::fmt::Write;

/// What kind of accidentals a key signature carries.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeySigType {
    /// Sharps (`#`) — `G`, `D`, `A`, …
    Sharp,
    /// Flats (`b`) — `F`, `Bb`, `Eb`, …
    Flat,
    /// No accidentals — `C` major / `A` minor.
    Natural,
}

/// Order of sharps in a key signature, in their conventional
/// treble-clef staff positions (`y` = half-line steps from the
/// top staff line; 0 = top line, 1 = first space, …).
const SHARP_ORDER: &[(&str, f32)] = &[
    ("F", 0.0),  // top line — F#
    ("C", 1.5),  // 3rd space — C#
    ("G", -0.5), // space above top line — G#
    ("D", 1.0),  // 2nd line — D#
    ("A", 2.5),  // 3rd space below — A#
    ("E", 0.5),  // 1st space — E#
    ("B", 2.0),  // 3rd line — B#
];

/// Same as [`SHARP_ORDER`] for the order-of-flats.
const FLAT_ORDER: &[(&str, f32)] = &[
    ("B", 2.0),
    ("E", 0.5),
    ("A", 2.5),
    ("D", 1.0),
    ("G", 3.0),
    ("C", 1.5),
    ("F", 3.5),
];

/// Look up a key-signature size and direction for a ChordPro
/// `{key}` value. Accepts both major (`G`, `Bb`, `F#`) and minor
/// (`Em`, `E minor`, `f# min`) spellings; unicode ♯ / ♭ are
/// normalised to ASCII. Returns `None` for an unparseable input
/// so callers can render the marker without an icon.
#[must_use]
pub fn key_signature_for(key: &str) -> Option<(usize, KeySigType)> {
    let trimmed = key.trim();
    if trimmed.is_empty() {
        return None;
    }
    // Normalise unicode accidentals to ASCII so `F♯` and `F#`
    // hit the same table entry. NBSP / ideographic spaces fold
    // to plain ASCII spaces in the same pass.
    let mut ascii = String::with_capacity(trimmed.len());
    for ch in trimmed.chars() {
        match ch {
            '\u{266D}' => ascii.push('b'),
            '\u{266F}' => ascii.push('#'),
            '\u{00A0}' | '\u{3000}' => ascii.push(' '),
            other => ascii.push(other),
        }
    }
    let ascii = ascii.trim();

    // Parse `<root>[b|#]( m | min | minor)?` case-insensitively.
    let mut chars = ascii.chars();
    let root = chars.next()?.to_ascii_uppercase();
    if !('A'..='G').contains(&root) {
        return None;
    }
    let mut accidental = String::new();
    let rest: String = chars.collect();
    let mut rest_chars = rest.chars().peekable();
    if let Some(&c) = rest_chars.peek() {
        if c == 'b' || c == '#' {
            accidental.push(c);
            rest_chars.next();
        }
    }
    let suffix: String = rest_chars.collect();
    let suffix_trim = suffix.trim().to_ascii_lowercase();
    let is_minor = matches!(suffix_trim.as_str(), "m" | "min" | "minor");
    if !is_minor && !suffix_trim.is_empty() {
        return None;
    }

    let note = format!("{root}{accidental}");

    // Direct lookup tables (see TS sister-site for rationale).
    let major: &[(&str, (usize, KeySigType))] = &[
        ("C", (0, KeySigType::Natural)),
        ("G", (1, KeySigType::Sharp)),
        ("D", (2, KeySigType::Sharp)),
        ("A", (3, KeySigType::Sharp)),
        ("E", (4, KeySigType::Sharp)),
        ("B", (5, KeySigType::Sharp)),
        ("F#", (6, KeySigType::Sharp)),
        ("C#", (7, KeySigType::Sharp)),
        ("F", (1, KeySigType::Flat)),
        ("Bb", (2, KeySigType::Flat)),
        ("Eb", (3, KeySigType::Flat)),
        ("Ab", (4, KeySigType::Flat)),
        ("Db", (5, KeySigType::Flat)),
        ("Gb", (6, KeySigType::Flat)),
        ("Cb", (7, KeySigType::Flat)),
    ];
    let minor: &[(&str, (usize, KeySigType))] = &[
        ("A", (0, KeySigType::Natural)),
        ("E", (1, KeySigType::Sharp)),
        ("B", (2, KeySigType::Sharp)),
        ("F#", (3, KeySigType::Sharp)),
        ("C#", (4, KeySigType::Sharp)),
        ("G#", (5, KeySigType::Sharp)),
        ("D#", (6, KeySigType::Sharp)),
        ("A#", (7, KeySigType::Sharp)),
        ("D", (1, KeySigType::Flat)),
        ("G", (2, KeySigType::Flat)),
        ("C", (3, KeySigType::Flat)),
        ("F", (4, KeySigType::Flat)),
        ("Bb", (5, KeySigType::Flat)),
        ("Eb", (6, KeySigType::Flat)),
        ("Ab", (7, KeySigType::Flat)),
    ];
    let table = if is_minor { minor } else { major };
    table.iter().find(|(n, _)| *n == note).map(|(_, v)| *v)
}

/// Emit an inline SVG mini key-signature glyph for the given
/// `{key}` value (e.g. `"G"` → 1 sharp on the top line, treble
/// clef silhouette over a 5-line staff). Returns a fully-formed
/// `<svg …>…</svg>` string ready to be embedded in HTML.
#[must_use]
pub fn key_signature_svg(key: &str) -> String {
    let sig = key_signature_for(key);
    let accidental_count = sig.map(|(c, _)| c).unwrap_or(0);
    let base_w: f32 = 28.0;
    let w: f32 = base_w + (accidental_count as f32) * 5.0;
    let h: f32 = 24.0;
    let top: f32 = 4.0;
    let line_gap: f32 = 3.0;
    let aria = match sig {
        None => format!("Key {key}"),
        Some((_, KeySigType::Natural)) => format!("Key {key} (no accidentals)"),
        Some((n, KeySigType::Sharp)) => {
            format!("Key {key} ({n} sharp{})", if n == 1 { "" } else { "s" })
        }
        Some((n, KeySigType::Flat)) => {
            format!("Key {key} ({n} flat{})", if n == 1 { "" } else { "s" })
        }
    };

    let mut s = String::with_capacity(512);
    let _ = write!(
        s,
        "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 {w} {h}\" \
         width=\"{w}\" height=\"{h}\" class=\"music-glyph music-glyph--key\" \
         role=\"img\" aria-label=\"{aria}\">",
        w = w,
        h = h,
        aria = chordsketch_chordpro::escape::escape_xml(&aria),
    );
    // 5 staff lines.
    for i in 0..5 {
        let y = top + (i as f32) * line_gap;
        let _ = write!(
            s,
            "<line x1=\"1\" x2=\"{x2}\" y1=\"{y}\" y2=\"{y}\" \
             stroke=\"currentColor\" stroke-width=\"0.6\"/>",
            x2 = w - 1.0,
            y = y,
        );
    }
    // Treble clef silhouette (simplified).
    s.push_str(
        "<path d=\"M9 19 C 9 21, 5.5 21, 5.5 18.5 C 5.5 16, 9 16, 9 14 \
         C 9 11, 4.5 9, 4.5 7 C 4.5 4, 8.5 2.5, 9.5 5 \
         C 10.5 8, 6 9.5, 6 13 C 6 16, 10 16, 10 13.5\" \
         fill=\"none\" stroke=\"currentColor\" stroke-width=\"1\" stroke-linecap=\"round\"/>",
    );
    // Accidentals.
    if let Some((count, sig_type)) = sig {
        if sig_type != KeySigType::Natural {
            let order = if sig_type == KeySigType::Sharp {
                SHARP_ORDER
            } else {
                FLAT_ORDER
            };
            for (i, &(_, y_step)) in order.iter().take(count).enumerate() {
                let cx = 14.0 + (i as f32) * 5.0;
                let cy = top + y_step * line_gap;
                if sig_type == KeySigType::Sharp {
                    write_sharp(&mut s, cx, cy);
                } else {
                    write_flat(&mut s, cx, cy);
                }
            }
        }
    }
    s.push_str("</svg>");
    s
}

fn write_sharp(s: &mut String, cx: f32, cy: f32) {
    let w = 2.2;
    let h = 4.4;
    let _ = write!(
        s,
        "<g stroke=\"currentColor\" stroke-width=\"0.55\" stroke-linecap=\"round\">\
         <line x1=\"{x1}\" y1=\"{y1}\" x2=\"{x1}\" y2=\"{y2}\"/>\
         <line x1=\"{x2}\" y1=\"{y3}\" x2=\"{x2}\" y2=\"{y4}\"/>\
         <line x1=\"{a1}\" y1=\"{b1}\" x2=\"{a2}\" y2=\"{b2}\"/>\
         <line x1=\"{a1}\" y1=\"{b3}\" x2=\"{a2}\" y2=\"{b4}\"/>\
         </g>",
        x1 = cx - w / 2.0,
        x2 = cx + w / 2.0,
        y1 = cy - h / 2.0,
        y2 = cy + h / 2.0 + 0.4,
        y3 = cy - h / 2.0 - 0.4,
        y4 = cy + h / 2.0,
        a1 = cx - w / 2.0 - 0.3,
        a2 = cx + w / 2.0 + 0.3,
        b1 = cy - 0.8,
        b2 = cy - 1.4,
        b3 = cy + 1.4,
        b4 = cy + 0.8,
    );
}

fn write_flat(s: &mut String, cx: f32, cy: f32) {
    let _ = write!(
        s,
        "<g fill=\"none\" stroke=\"currentColor\" stroke-width=\"0.55\" stroke-linecap=\"round\">\
         <line x1=\"{x}\" y1=\"{y1}\" x2=\"{x}\" y2=\"{y2}\"/>\
         <path d=\"M {x} {p1} \
         C {p2x} {p2y}, {p3x} {p3y}, {x} {p4}\"/>\
         </g>",
        x = cx - 0.8,
        y1 = cy - 2.5,
        y2 = cy + 2.2,
        p1 = cy + 0.4,
        p2x = cx + 0.6,
        p2y = cy - 0.6,
        p3x = cx + 1.4,
        p3y = cy + 1.4,
        p4 = cy + 2.2,
    );
}

/// Emit an inline SVG mini metronome glyph with the pendulum
/// animation duration derived from `bpm`. The `--cs-metronome-
/// period` CSS custom property is set on the root `<svg>` so
/// the stylesheet's `@keyframes cs-metronome-swing` rule (in
/// the embedded `<style>` block) reads it without runtime JS.
///
/// Geometry: the rod is modelled as an INVERTED pendulum mounted
/// on a pivot at `(9, 19)` near the base of the triangular body,
/// with the weight bead near the top of the rod — a real
/// mechanical Wittner metronome, not a hanging-clock pendulum.
/// The pivot point is fixed; the rod sweeps wiper-style.
#[must_use]
pub fn metronome_svg(bpm_raw: &str) -> String {
    let bpm: f32 = bpm_raw.trim().parse::<f32>().unwrap_or(60.0);
    let safe_bpm = if bpm.is_finite() && bpm > 0.0 {
        bpm
    } else {
        60.0
    };
    // Half-cycle duration in seconds (extreme to extreme). With
    // `animation-direction: alternate`, this is the
    // `animation-duration`; a full back-and-forth is `2 * period`.
    // Two ticks per full cycle ⇒ one tick every `period` seconds
    // ⇒ exactly `bpm` ticks per minute, matching a real
    // metronome's audible rhythm.
    let period = (60.0 / safe_bpm).clamp(0.05, 5.0);

    let aria = format!("Metronome at {} BPM", bpm_raw.trim());
    let mut s = String::with_capacity(512);
    let _ = write!(
        s,
        "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 18 22\" \
         width=\"18\" height=\"22\" class=\"music-glyph music-glyph--metronome\" \
         style=\"--cs-metronome-period:{:.3}s\" role=\"img\" aria-label=\"{}\">\
         <path d=\"M 3 21 L 15 21 L 12.5 5 L 5.5 5 Z\" fill=\"none\" \
         stroke=\"currentColor\" stroke-width=\"0.9\" stroke-linejoin=\"round\"/>\
         <circle cx=\"9\" cy=\"19\" r=\"0.7\" fill=\"currentColor\"/>\
         <g class=\"music-glyph--metronome__pendulum\">\
         <line x1=\"9\" y1=\"19\" x2=\"9\" y2=\"2\" stroke=\"currentColor\" \
         stroke-width=\"0.9\" stroke-linecap=\"round\"/>\
         <circle cx=\"9\" cy=\"6\" r=\"1.1\" fill=\"currentColor\"/>\
         </g></svg>",
        period,
        chordsketch_chordpro::escape::escape_xml(&aria),
    );
    s
}

/// Emit a stacked numerator / fraction-bar / denominator
/// `<span>` group for a `{time}` directive value. When `bpm`
/// is provided AND the numerator is one of the supported
/// conductor patterns (2 / 3 / 4 / 6), the root span carries a
/// `music-glyph--time--conduct-N` modifier class plus a
/// `--cs-time-period` CSS custom property so the stylesheet's
/// `@keyframes cs-conductor-N` rule animates the glyph in time
/// with the active tempo. Falls back to plain text when the
/// input is not a recognisable `<num>/<den>` form (e.g. `"C"`,
/// `"common"`, blank).
#[must_use]
pub fn time_signature_html(value: &str, bpm: Option<f32>) -> String {
    let trimmed = value.trim();
    let parts: Vec<&str> = trimmed.split('/').collect();
    if parts.len() != 2 {
        return format!(
            "<span class=\"music-glyph music-glyph--time\">{}</span>",
            chordsketch_chordpro::escape::escape_xml(trimmed),
        );
    }
    let num = parts[0].trim();
    let den = parts[1].trim();
    if num.is_empty()
        || den.is_empty()
        || !num.chars().all(|c| c.is_ascii_digit())
        || !den.chars().all(|c| c.is_ascii_digit())
    {
        return format!(
            "<span class=\"music-glyph music-glyph--time\">{}</span>",
            chordsketch_chordpro::escape::escape_xml(trimmed),
        );
    }
    let aria = format!("Time signature {num} over {den}");
    let num_int: u32 = num.parse().unwrap_or(0);
    let (conduct_class, period_style) = match (matches!(num_int, 2 | 3 | 4 | 6), bpm) {
        (true, Some(bp)) if bp.is_finite() && bp > 0.0 => {
            let period = ((num_int as f32) * (60.0 / bp)).clamp(0.3, 30.0);
            (
                format!(" music-glyph--time--conduct-{num_int}"),
                format!(" style=\"--cs-time-period:{period:.3}s\""),
            )
        }
        _ => (String::new(), String::new()),
    };
    format!(
        "<span class=\"music-glyph music-glyph--time{conduct}\"{period} \
         role=\"img\" aria-label=\"{aria}\">\
         <span class=\"music-glyph--time__num\" aria-hidden=\"true\">{num}</span>\
         <span class=\"music-glyph--time__bar\" aria-hidden=\"true\"></span>\
         <span class=\"music-glyph--time__den\" aria-hidden=\"true\">{den}</span>\
         </span>",
        conduct = conduct_class,
        period = period_style,
        aria = chordsketch_chordpro::escape::escape_xml(&aria),
        num = chordsketch_chordpro::escape::escape_xml(num),
        den = chordsketch_chordpro::escape::escape_xml(den),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_signature_major_table() {
        assert_eq!(key_signature_for("C"), Some((0, KeySigType::Natural)));
        assert_eq!(key_signature_for("G"), Some((1, KeySigType::Sharp)));
        assert_eq!(key_signature_for("D"), Some((2, KeySigType::Sharp)));
        assert_eq!(key_signature_for("F#"), Some((6, KeySigType::Sharp)));
        assert_eq!(key_signature_for("Bb"), Some((2, KeySigType::Flat)));
        assert_eq!(key_signature_for("Cb"), Some((7, KeySigType::Flat)));
    }

    #[test]
    fn key_signature_minor_table() {
        assert_eq!(key_signature_for("Am"), Some((0, KeySigType::Natural)));
        assert_eq!(key_signature_for("Em"), Some((1, KeySigType::Sharp)));
        assert_eq!(key_signature_for("Dm"), Some((1, KeySigType::Flat)));
        assert_eq!(key_signature_for("Cm"), Some((3, KeySigType::Flat)));
        assert_eq!(key_signature_for("F#m"), Some((3, KeySigType::Sharp)));
    }

    #[test]
    fn key_signature_unicode_and_spaces() {
        // Unicode ♯ / ♭ are normalised to ASCII.
        assert_eq!(key_signature_for("F♯"), Some((6, KeySigType::Sharp)));
        assert_eq!(key_signature_for("B♭"), Some((2, KeySigType::Flat)));
        // Whitespace + verbose minor suffix.
        assert_eq!(key_signature_for("E minor"), Some((1, KeySigType::Sharp)));
        assert_eq!(key_signature_for("e MIN"), Some((1, KeySigType::Sharp)));
    }

    #[test]
    fn key_signature_unparseable_returns_none() {
        assert_eq!(key_signature_for(""), None);
        assert_eq!(key_signature_for("not a key"), None);
        assert_eq!(key_signature_for("H"), None);
    }

    #[test]
    fn key_signature_svg_has_clef_and_staff() {
        let svg = key_signature_svg("A");
        assert!(svg.starts_with("<svg "));
        assert!(svg.contains("music-glyph--key"));
        // 5 staff lines (line elements) — 5 + accidentals (sharps in
        // <g> groups). 3 sharps for A major.
        let line_count = svg.matches("<line").count();
        assert!(
            line_count >= 5,
            "expected at least 5 lines, got {line_count} in {svg}"
        );
        assert_eq!(svg.matches("<g ").count(), 3);
    }

    #[test]
    fn key_signature_svg_natural_emits_no_accidentals() {
        let svg = key_signature_svg("C");
        assert!(!svg.contains("<g "));
    }

    #[test]
    fn metronome_svg_writes_period_from_bpm() {
        let svg = metronome_svg("120");
        // 120 BPM → half-cycle = 60/120 = 0.500s; full cycle (with
        // `animation-direction: alternate`) = 1.0s = 2 beats.
        assert!(
            svg.contains("--cs-metronome-period:0.500s"),
            "expected 0.500s half-cycle at 120 BPM; got: {svg}"
        );
        assert!(svg.contains("music-glyph--metronome__pendulum"));
    }

    #[test]
    fn metronome_svg_period_at_60_bpm() {
        // 60 BPM → half-cycle = 1.000s ⇒ exactly one tick per second
        // (the canonical "Largo" rate).
        let svg = metronome_svg("60");
        assert!(svg.contains("--cs-metronome-period:1.000s"));
    }

    #[test]
    fn metronome_svg_clamps_extreme_bpm() {
        let svg = metronome_svg("99999");
        // Clamped to >= 0.05 s.
        assert!(svg.contains("--cs-metronome-period:0.050s"));
    }

    #[test]
    fn metronome_svg_inverted_pendulum_pivot() {
        // Pivot dot (static) sits at (9, 19); the swept rod's lower
        // endpoint coincides with the pivot. A regression that flips
        // back to top-pivot would emit `y1="3"` for the rod.
        let svg = metronome_svg("120");
        assert!(
            svg.contains("<circle cx=\"9\" cy=\"19\" r=\"0.7\""),
            "expected static pivot circle at (9, 19); got: {svg}"
        );
        assert!(
            svg.contains("<line x1=\"9\" y1=\"19\" x2=\"9\" y2=\"2\""),
            "rod must extend upward from base pivot; got: {svg}"
        );
    }

    #[test]
    fn metronome_svg_fallbacks_for_non_numeric() {
        let svg = metronome_svg("nonsense");
        // Falls back to 60 BPM → 1.000s half-cycle.
        assert!(svg.contains("--cs-metronome-period:1.000s"));
    }

    #[test]
    fn time_signature_html_stacks_digits() {
        let html = time_signature_html("4/4", None);
        assert!(html.contains("music-glyph--time__num\" aria-hidden=\"true\">4</span>"));
        assert!(html.contains("music-glyph--time__bar\""));
        assert!(html.contains("music-glyph--time__den\" aria-hidden=\"true\">4</span>"));
        assert!(html.contains("aria-label=\"Time signature 4 over 4\""));
    }

    #[test]
    fn time_signature_html_falls_back_for_non_fraction() {
        let html = time_signature_html("C", None);
        assert!(html.contains("music-glyph--time\">C</span>"));
        assert!(!html.contains("music-glyph--time__num"));
    }

    #[test]
    fn time_signature_html_no_bpm_means_static_glyph() {
        // Without a BPM context the glyph must NOT carry a
        // conductor class or animation period — it renders
        // statically until a `{tempo}` has set the active BPM.
        let html = time_signature_html("4/4", None);
        assert!(!html.contains("music-glyph--time--conduct-"));
        assert!(!html.contains("--cs-time-period"));
    }

    #[test]
    fn time_signature_html_with_bpm_emits_conductor_period() {
        let html = time_signature_html("4/4", Some(120.0));
        // 4 beats * (60/120) = 2.000s per measure.
        assert!(html.contains("music-glyph--time--conduct-4"));
        assert!(html.contains("--cs-time-period:2.000s"));
    }

    #[test]
    fn time_signature_html_picks_conductor_pattern_per_numerator() {
        let three = time_signature_html("3/4", Some(120.0));
        assert!(three.contains("music-glyph--time--conduct-3"));
        let six = time_signature_html("6/8", Some(120.0));
        assert!(six.contains("music-glyph--time--conduct-6"));
        // 5/4 is not in {2, 3, 4, 6} — static fallback.
        let five = time_signature_html("5/4", Some(120.0));
        assert!(!five.contains("music-glyph--time--conduct-"));
    }
}
