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

/// Diagnostic result of a key-signature lookup. Distinguishes the
/// two failure modes so callers can emit a warning when a
/// well-formed key-name parsed but missed the lookup table — a
/// signal that the table has a gap and the glyph is silently
/// blank.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeySignatureLookup {
    /// The input parsed and the lookup table resolved to an
    /// accidental count and direction.
    Resolved(usize, KeySigType),
    /// The input parsed as a key name (root in `A..=G`, optional
    /// `b`/`#` accidental, optional minor suffix) but no lookup
    /// table entry exists for the parsed `(root, accidental,
    /// is_minor)` triple. The glyph caller should still render
    /// an empty staff but SHOULD emit a warning so the table gap
    /// is observable — the silent empty-staff render gave screen
    /// readers and sighted users contradictory information (#2526).
    ParsedButMissing,
    /// The input did not parse as a key name at all (empty,
    /// non-letter root, or unsupported suffix such as
    /// `{key: C dorian}`). Callers fall back to the staff-only
    /// glyph without a warning — modal `{key}` values are valid
    /// ChordPro and not a table-gap signal.
    Unparseable,
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
/// `{key}` value. Accepts the strict key grammar
/// (`chordsketch_chordpro::parse_key`): major (`G`, `Bb`, `F#`) and
/// minor (`Em`, `F#m`, `Cmin`) tonal keys; unicode ♯ / ♭ are
/// normalised to ASCII first. Modal keys (`C dorian`) and malformed
/// values (`E minor`, `e min`) have no key signature here. Returns
/// `None` for an unparseable input OR for a parseable key whose
/// lookup table has no entry, so callers can render the marker
/// without an icon. Callers that need to distinguish the two None
/// cases (e.g. to emit a warning on a parseable-but-missing-from-table
/// input) should use [`key_signature_for_with_diagnostics`].
#[must_use]
pub fn key_signature_for(key: &str) -> Option<(usize, KeySigType)> {
    match key_signature_for_with_diagnostics(key) {
        KeySignatureLookup::Resolved(count, kind) => Some((count, kind)),
        KeySignatureLookup::ParsedButMissing | KeySignatureLookup::Unparseable => None,
    }
}

/// Variant of [`key_signature_for`] that distinguishes a
/// parseable-but-missing input from an unparseable one. Used by
/// the HTML renderer to emit a warning when a key string that
/// parses as a chord nonetheless has no lookup entry — a signal
/// that the table has a silent gap rather than that the caller
/// passed a modal `{key}` value (#2526).
#[must_use]
pub fn key_signature_for_with_diagnostics(key: &str) -> KeySignatureLookup {
    // Delegate the grammar — and the Unicode ♯ / ♭ + exotic-space normalisation
    // — to the single strict key parser (`chordsketch_chordpro::parse_key`) so
    // the glyph agrees with the displayed key, the transpose re-spelling, and
    // the audition on what a key is, rather than carrying its own copy of the
    // grammar (which used to accept `C minor` / `C m` as minor while the chord
    // parser read them as major, issue #2665) or its own accidental folding.
    // A modal key (`C dorian`) has no conventional single key signature here,
    // so it falls back to the staff-only glyph.
    let Some(parsed) = chordsketch_chordpro::parse_key(key) else {
        return KeySignatureLookup::Unparseable;
    };
    let is_minor = match parsed.mode {
        chordsketch_chordpro::KeyMode::Major => false,
        chordsketch_chordpro::KeyMode::Minor => true,
        chordsketch_chordpro::KeyMode::Mode(_) => return KeySignatureLookup::Unparseable,
    };
    // The slash-bass (if any) does not affect a key signature; look up by the
    // tonic only.
    let mut note = parsed.root.to_string();
    if let Some(acc) = parsed.accidental {
        note.push_str(&acc.to_string());
    }

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
    // Minor table includes Dbm / Gbm / Cbm as enharmonic
    // aliases of C#m / F#m / Bm respectively — these spellings
    // arise from `transposed_key_prefers_flat`-driven transpose
    // landings (e.g. `{key: Am}` +4 with prefer-flat → `Dbm`,
    // #2526). Conventional notation uses the sharp-side
    // key signature for these (D-flat minor has no real signature;
    // by convention the 4-sharp C-sharp minor signature is
    // borrowed), so the staff glyph shows sharps even when chord
    // lines spell flats.
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
        ("Cb", (2, KeySigType::Sharp)),
        ("Gb", (3, KeySigType::Sharp)),
        ("Db", (4, KeySigType::Sharp)),
    ];
    let table = if is_minor { minor } else { major };
    match table.iter().find(|(n, _)| *n == note).map(|(_, v)| *v) {
        Some((count, kind)) => KeySignatureLookup::Resolved(count, kind),
        None => KeySignatureLookup::ParsedButMissing,
    }
}

/// Emit an inline SVG mini key-signature glyph for the given
/// `{key}` value (e.g. `"G"` → 1 sharp on the top line, treble
/// clef silhouette over a 5-line staff). Returns a fully-formed
/// `<svg …>…</svg>` string ready to be embedded in HTML.
#[must_use]
pub fn key_signature_svg(key: &str) -> String {
    let sig = key_signature_for(key);
    let accidental_count = sig.map(|(c, _)| c).unwrap_or(0);
    // Compact layout (sister-site to
    // `packages/react/src/music-glyphs.tsx`): the clef occupies
    // x=1..12, accidentals start at x=14 with 4-unit spacing plus
    // a 3-unit tail. The previous 5-unit spacing + base-width 28
    // left ~19 user units of empty staff on the right of a
    // 1-sharp key, which made the chip strip horizontally
    // bloated.
    let accidental_start: f32 = 14.0;
    let accidental_spacing: f32 = 4.0;
    let tail_right: f32 = 3.0;
    let w: f32 = if accidental_count > 0 {
        let calc =
            accidental_start + ((accidental_count as f32 - 1.0) * accidental_spacing) + tail_right;
        if calc < 18.0 { 18.0 } else { calc }
    } else {
        18.0
    };
    // Visual content (sharps above the staff at y≈1.4, clef tail
    // at y≈20.9) is centered around y≈11. Trim the viewBox to
    // span y=1..21 so `align-items: center` on the `.meta-inline`
    // chip lines the staff up visually with the text rather than
    // with the SVG's empty viewBox padding.
    let vb_top: f32 = 1.0;
    let h: f32 = 20.0;
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
        "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 {vb_top} {w} {h}\" \
         width=\"{w}\" height=\"{h}\" class=\"music-glyph music-glyph--key\" \
         role=\"img\" aria-label=\"{aria}\">",
        vb_top = vb_top,
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
                let cx = accidental_start + (i as f32) * accidental_spacing;
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
/// the stylesheet's `@keyframes cs-metronome-swing` and
/// `@keyframes cs-metronome-beat` rules (in the embedded
/// `<style>` block) read it without runtime JS.
///
/// Geometry: the rod is modelled as an INVERTED pendulum mounted
/// on a pivot at `(9, 19)` near the base of the triangular body,
/// with the weight bead near the top of the rod — a real
/// mechanical Wittner metronome, not a hanging-clock pendulum.
/// The pivot point is fixed; the rod sweeps wiper-style.
///
/// A static beat dot sits in the top-left corner *inside* the
/// existing viewBox (so the icon height is unchanged) and blinks
/// crisply on/off once per beat (no fade). Its blink shares the
/// same `--cs-metronome-period` as the swing, and a `-period/2`
/// `animation-delay` phase-shifts the flash so the dot switches on
/// when the rod passes through the center (vertical), not at the
/// extremes. The dot is a sibling of the pendulum group, so it
/// does NOT swing — only its opacity animates.
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

    // Use the validated numeric BPM in the accessible name —
    // not the raw `bpm_raw` string — so a `{tempo: <script>}`
    // payload doesn't reach screen readers AND so a future
    // refactor that moves the string into a non-escaping
    // context can't inherit a sanitiser bypass. The
    // surrounding `escape_xml` already neutralises XSS today;
    // this is defense-in-depth. Falls back to "unknown" when
    // the source value can't be parsed.
    let aria = if bpm.is_finite() && bpm > 0.0 {
        // Format as an integer when the BPM is whole (the
        // common case); otherwise preserve one decimal so
        // unusual values like `90.5` still read accurately.
        if (bpm - bpm.round()).abs() < f32::EPSILON {
            format!("Metronome at {} BPM", bpm as i32)
        } else {
            format!("Metronome at {bpm} BPM")
        }
    } else {
        "Metronome (BPM unknown)".to_string()
    };
    let mut s = String::with_capacity(512);
    let _ = write!(
        s,
        "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 4 18 18\" \
         width=\"18\" height=\"18\" class=\"music-glyph music-glyph--metronome\" \
         style=\"--cs-metronome-period:{:.3}s\" role=\"img\" aria-label=\"{}\">\
         <circle class=\"music-glyph--metronome__beat\" cx=\"2.4\" cy=\"6.2\" \
         r=\"1.5\" fill=\"currentColor\"/>\
         <path d=\"M 3 21 L 15 21 L 12.5 5 L 5.5 5 Z\" fill=\"none\" \
         stroke=\"currentColor\" stroke-width=\"0.9\" stroke-linejoin=\"round\"/>\
         <circle cx=\"9\" cy=\"19\" r=\"0.7\" fill=\"currentColor\"/>\
         <g class=\"music-glyph--metronome__pendulum\">\
         <line x1=\"9\" y1=\"19\" x2=\"9\" y2=\"7\" stroke=\"currentColor\" \
         stroke-width=\"0.9\" stroke-linecap=\"round\"/>\
         <circle cx=\"9\" cy=\"9\" r=\"1.1\" fill=\"currentColor\"/>\
         </g></svg>",
        period,
        chordsketch_chordpro::escape::escape_xml(&aria),
    );
    s
}

/// Emit a stacked numerator / fraction-bar / denominator
/// `<span>` group for a `{time}` directive value. The
/// conductor-pattern animation that used to live on this glyph
/// was retired per playground feedback — the digits read
/// cleanly on their own, and the moving dot competed with the
/// surrounding meta-strip typography.
#[must_use]
pub fn time_signature_html(value: &str) -> String {
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
    format!(
        "<span class=\"music-glyph music-glyph--time\" \
         role=\"img\" aria-label=\"{aria}\">\
         <span class=\"music-glyph--time__num\" aria-hidden=\"true\">{num}</span>\
         <span class=\"music-glyph--time__bar\" aria-hidden=\"true\"></span>\
         <span class=\"music-glyph--time__den\" aria-hidden=\"true\">{den}</span>\
         </span>",
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
    fn key_signature_enharmonic_flat_side_minor_returns_sharp_side_count() {
        // Dbm / Gbm / Cbm arise from `transposed_key_prefers_flat`
        // landings (e.g. `{key: Am}` +4 → `Dbm`). They have no
        // standalone key signature — by convention the staff
        // glyph borrows the sharp-side enharmonic's signature
        // (Dbm ↔ C#m = 4 sharps, Gbm ↔ F#m = 3 sharps,
        // Cbm ↔ Bm = 2 sharps). Without these entries the glyph
        // emitted an empty staff that contradicted the
        // `aria-label="Key Dbm"` (#2526).
        assert_eq!(key_signature_for("Dbm"), Some((4, KeySigType::Sharp)));
        assert_eq!(key_signature_for("Gbm"), Some((3, KeySigType::Sharp)));
        assert_eq!(key_signature_for("Cbm"), Some((2, KeySigType::Sharp)));
        // Unicode ♭ variant routes through the same normalisation
        // and lands on the same entry.
        assert_eq!(key_signature_for("D♭m"), Some((4, KeySigType::Sharp)));
    }

    #[test]
    fn key_signature_svg_enharmonic_minor_emits_sharp_accidentals() {
        // Dbm uses the C#m signature (4 sharps) so the rendered
        // SVG carries 4 `<g>` accidental groups, not an empty
        // staff. Before #2526 the glyph for Dbm had zero `<g>`
        // groups while still carrying `aria-label="Key Dbm"`,
        // mismatching screen readers and sighted users.
        let svg = key_signature_svg("Dbm");
        assert_eq!(svg.matches("<g ").count(), 4);
        assert!(svg.contains("Key Dbm"));
        assert!(svg.contains("4 sharps"));
    }

    #[test]
    fn key_signature_diagnostics_distinguishes_unparseable_from_table_gap() {
        // Sanity: in-table entries report Resolved.
        assert_eq!(
            key_signature_for_with_diagnostics("A"),
            KeySignatureLookup::Resolved(3, KeySigType::Sharp)
        );
        // Modal / non-key suffix => Unparseable (no warning).
        assert_eq!(
            key_signature_for_with_diagnostics("C dorian"),
            KeySignatureLookup::Unparseable
        );
        assert_eq!(
            key_signature_for_with_diagnostics(""),
            KeySignatureLookup::Unparseable
        );
        assert_eq!(
            key_signature_for_with_diagnostics("H"),
            KeySignatureLookup::Unparseable
        );
        // Fbm parses as a key (root F, flat accidental, minor
        // suffix) but no table entry exists — Fbm = 8 flats is
        // outside the standard 0..=7 range and `transposed_key`
        // canonicalises it to Em instead, so #2526's backfill
        // intentionally does not include it. The diagnostics
        // variant surfaces the table gap so the renderer can
        // emit a warning instead of a silent empty-staff glyph.
        assert_eq!(
            key_signature_for_with_diagnostics("Fbm"),
            KeySignatureLookup::ParsedButMissing
        );
    }

    #[test]
    fn key_signature_unicode_and_strict_minor_markers() {
        // Unicode ♯ / ♭ are normalised to ASCII.
        assert_eq!(key_signature_for("F♯"), Some((6, KeySigType::Sharp)));
        assert_eq!(key_signature_for("B♭"), Some((2, KeySigType::Flat)));
        // Strict minor markers (`m`, `min`) resolve to the minor signature.
        assert_eq!(key_signature_for("Em"), Some((1, KeySigType::Sharp)));
        assert_eq!(key_signature_for("Emin"), Some((1, KeySigType::Sharp)));
        // Malformed spellings — a spelled-out word, a space before the marker,
        // a lowercase root — are not valid keys and carry no signature
        // (issue #2665); the strict key grammar rejects them.
        assert_eq!(key_signature_for("E minor"), None);
        assert_eq!(key_signature_for("e min"), None);
        assert_eq!(key_signature_for("E m"), None);
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

    // `tempo_marking_table` moved to
    // `chordsketch_chordpro::typography::tests` together with
    // the helper itself.

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
            svg.contains("<line x1=\"9\" y1=\"19\" x2=\"9\" y2=\"7\""),
            "rod must extend upward from base pivot; got: {svg}"
        );
    }

    #[test]
    fn metronome_svg_emits_beat_dot() {
        let svg = metronome_svg("120");
        // The beat dot is present, sits in the top-left corner, and
        // carries the `__beat` class the stylesheet animates.
        assert!(
            svg.contains(
                "<circle class=\"music-glyph--metronome__beat\" cx=\"2.4\" cy=\"6.2\" r=\"1.5\""
            ),
            "expected top-left beat dot circle; got: {svg}"
        );
        // The beat dot must be a SIBLING of the pendulum group, not
        // inside it — otherwise it would swing with the rod instead
        // of staying put. Assert the dot appears before the
        // pendulum group's opening tag.
        let beat = svg
            .find("music-glyph--metronome__beat")
            .expect("beat dot present");
        let pendulum = svg
            .find("music-glyph--metronome__pendulum")
            .expect("pendulum group present");
        assert!(
            beat < pendulum,
            "beat dot must be emitted outside (before) the pendulum group; got: {svg}"
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
        let html = time_signature_html("4/4");
        assert!(html.contains("music-glyph--time__num\" aria-hidden=\"true\">4</span>"));
        assert!(html.contains("music-glyph--time__bar\""));
        assert!(html.contains("music-glyph--time__den\" aria-hidden=\"true\">4</span>"));
        assert!(html.contains("aria-label=\"Time signature 4 over 4\""));
    }

    #[test]
    fn time_signature_html_falls_back_for_non_fraction() {
        let html = time_signature_html("C");
        assert!(html.contains("music-glyph--time\">C</span>"));
        assert!(!html.contains("music-glyph--time__num"));
    }

    #[test]
    fn time_signature_html_carries_no_conductor_markup() {
        // The conductor-pattern animation was retired — the time-
        // signature glyph is now just the stacked digits + bar.
        let html = time_signature_html("4/4");
        assert!(!html.contains("music-glyph--time--conduct-"));
        assert!(!html.contains("--cs-time-period"));
    }
}
