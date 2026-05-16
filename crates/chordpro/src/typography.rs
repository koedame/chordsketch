//! Music-typography helpers shared by every renderer
//! (`chordsketch-render-text`, `chordsketch-render-html`,
//! `chordsketch-render-pdf`, plus the React JSX walker sister-
//! site in `@chordsketch/react`).
//!
//! These functions deal with how chord / key / tempo text is
//! *displayed*, not how it is parsed — they are intentionally
//! kept separate from the AST and parser so renderer-parity
//! changes (e.g. switching `b` → `♭` typesetting on by default)
//! can land once and propagate to every output surface.

/// Replace ASCII accidentals (`b` / `#`) on note letters with
/// the proper Unicode musical symbols (`♭` U+266D / `♯` U+266F).
///
/// Applied to chord names and key values before they're rendered
/// so the typography reads as engraved music rather than
/// typewriter text. Two cases are converted:
///
/// 1. **Root accidentals.** `[A-G]b` → `[A-G]♭`,
///    `[A-G]#` → `[A-G]♯`. Handles flat-side and sharp-side
///    keys like `Bb`, `Eb`, `F#`.
/// 2. **Extension accidentals.** `b<digit>` → `♭<digit>`,
///    `#<digit>` → `♯<digit>`. Handles chord-quality
///    alterations like `b9`, `#11`, `b13` inside parens or
///    immediately after a degree marker (e.g. `Gb7(b9)`,
///    `Cmaj7#11`, `D7b13`).
///
/// Chord-quality letters (`m`, `dim`, `sus`, etc.) survive
/// unchanged because they don't match either pattern.
///
/// Sister-site to `unicodeAccidentals` in
/// `packages/react/src/chordpro-jsx.tsx`. The two functions
/// MUST produce byte-for-byte identical output for every input;
/// the React JSX walker and every Rust renderer pick up the
/// same typography this way.
#[must_use]
pub fn unicode_accidentals(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i];
        // Root accidental: `[A-G]b` or `[A-G]#`. Fires on ASCII
        // uppercase note letters followed by the ASCII `b` or
        // `#`.
        if c.is_ascii_uppercase() && (b'A'..=b'G').contains(&c) && i + 1 < bytes.len() {
            let next = bytes[i + 1];
            if next == b'b' {
                out.push(c as char);
                out.push('\u{266D}');
                i += 2;
                continue;
            }
            if next == b'#' {
                out.push(c as char);
                out.push('\u{266F}');
                i += 2;
                continue;
            }
        }
        // Extension accidental: `b<digit>` or `#<digit>` where
        // the `b`/`#` is NOT preceded by a note letter (those
        // were caught by the rule above). `b9`, `#11`, `b13`,
        // etc.
        if (c == b'b' || c == b'#') && i + 1 < bytes.len() && bytes[i + 1].is_ascii_digit() {
            let prev_is_note =
                i > 0 && (b'A'..=b'G').contains(&bytes[i - 1]) && bytes[i - 1].is_ascii_uppercase();
            if !prev_is_note {
                out.push(if c == b'b' { '\u{266D}' } else { '\u{266F}' });
                i += 1;
                continue;
            }
        }
        // Walk one full UTF-8 character to keep multi-byte
        // codepoints intact. We can index into `s` safely here
        // because `i` is always at a char boundary: the ASCII
        // branches above advance by 1 or 2 (all bytes ASCII)
        // or we fall through and advance by the UTF-8
        // lead-byte's declared length.
        let len = utf8_char_len(c);
        let end = (i + len).min(bytes.len());
        out.push_str(&s[i..end]);
        i = end;
    }
    out
}

/// Returns the byte length of the UTF-8 sequence starting with
/// `lead`. Invariants of `&str` guarantee `lead` is at a char
/// boundary, so this is sufficient to walk the next codepoint.
fn utf8_char_len(lead: u8) -> usize {
    if lead < 0x80 {
        1
    } else if lead < 0xC0 {
        // Continuation byte at a char boundary is impossible
        // for valid `&str`; treat as a single byte to make
        // forward progress instead of panicking.
        1
    } else if lead < 0xE0 {
        2
    } else if lead < 0xF0 {
        3
    } else {
        4
    }
}

/// Italian tempo-marking name for a BPM value.
///
/// Boundaries follow the conventional ranges (`Grave < 40`,
/// `Largo 40-59`, `Larghetto 60-65`, `Adagio 66-75`,
/// `Andante 76-107`, `Moderato 108-119`, `Allegro 120-167`,
/// `Vivace 168-176`, `Presto 177-199`, `Prestissimo ≥ 200`).
/// Returns `None` for non-finite / non-positive input.
///
/// Sister-site to `tempoMarkingFor` in
/// `packages/react/src/music-glyphs.tsx`.
#[must_use]
pub fn tempo_marking_for(bpm: f32) -> Option<&'static str> {
    if !bpm.is_finite() || bpm <= 0.0 {
        return None;
    }
    if bpm < 40.0 {
        return Some("Grave");
    }
    if bpm < 60.0 {
        return Some("Largo");
    }
    if bpm < 66.0 {
        return Some("Larghetto");
    }
    if bpm < 76.0 {
        return Some("Adagio");
    }
    if bpm < 108.0 {
        return Some("Andante");
    }
    if bpm < 120.0 {
        return Some("Moderato");
    }
    if bpm < 168.0 {
        return Some("Allegro");
    }
    if bpm < 177.0 {
        return Some("Vivace");
    }
    if bpm < 200.0 {
        return Some("Presto");
    }
    Some("Prestissimo")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unicode_accidentals_basic() {
        assert_eq!(unicode_accidentals("Bb"), "B\u{266D}");
        assert_eq!(unicode_accidentals("Eb7"), "E\u{266D}7");
        assert_eq!(unicode_accidentals("F#m"), "F\u{266F}m");
        // Slash chord — both halves convert.
        assert_eq!(unicode_accidentals("Bb/Eb"), "B\u{266D}/E\u{266D}");
        // Non-accidental letters survive untouched.
        assert_eq!(unicode_accidentals("Am"), "Am");
        assert_eq!(unicode_accidentals("Cdim"), "Cdim");
        assert_eq!(unicode_accidentals("Cmaj7"), "Cmaj7");
        // Quality letters that look like roots ("Bb" inside "Bbm7")
        // still convert because the leading letter is a root.
        assert_eq!(unicode_accidentals("Bbm7"), "B\u{266D}m7");
    }

    #[test]
    fn unicode_accidentals_leaves_non_root_letters_alone() {
        assert_eq!(unicode_accidentals("Verse"), "Verse");
        // Multi-byte UTF-8 (a Japanese comment) survives intact.
        assert_eq!(unicode_accidentals("中文"), "中文");
    }

    #[test]
    fn unicode_accidentals_extension_alterations() {
        // `b<digit>` / `#<digit>` inside chord quality strings
        // and parentheses turn into proper musical flats/sharps.
        assert_eq!(unicode_accidentals("Gb7(b9)"), "G\u{266D}7(\u{266D}9)");
        assert_eq!(unicode_accidentals("Cmaj7#11"), "Cmaj7\u{266F}11");
        assert_eq!(unicode_accidentals("D7b13"), "D7\u{266D}13");
        // Multi-digit extension.
        assert_eq!(unicode_accidentals("C7b13"), "C7\u{266D}13");
        // Stacked alterations inside parens.
        assert_eq!(
            unicode_accidentals("G7(b9,#11)"),
            "G7(\u{266D}9,\u{266F}11)",
        );
        // A `b`/`#` NOT followed by a digit stays as the
        // chord-quality letter (e.g. `m` after `b` of `Bbm7`
        // already converted at the root step).
        assert_eq!(unicode_accidentals("Cm7"), "Cm7");
        // A `b` followed by a letter (like the `m` in `Bbm7`)
        // does not match the extension rule.
        assert_eq!(unicode_accidentals("Bbm7"), "B\u{266D}m7");
    }

    #[test]
    fn tempo_marking_table() {
        assert_eq!(tempo_marking_for(30.0), Some("Grave"));
        assert_eq!(tempo_marking_for(50.0), Some("Largo"));
        assert_eq!(tempo_marking_for(62.0), Some("Larghetto"));
        assert_eq!(tempo_marking_for(70.0), Some("Adagio"));
        assert_eq!(tempo_marking_for(90.0), Some("Andante"));
        assert_eq!(tempo_marking_for(110.0), Some("Moderato"));
        assert_eq!(tempo_marking_for(120.0), Some("Allegro"));
        assert_eq!(tempo_marking_for(140.0), Some("Allegro"));
        assert_eq!(tempo_marking_for(170.0), Some("Vivace"));
        assert_eq!(tempo_marking_for(180.0), Some("Presto"));
        assert_eq!(tempo_marking_for(220.0), Some("Prestissimo"));
        assert_eq!(tempo_marking_for(0.0), None);
        assert_eq!(tempo_marking_for(-1.0), None);
        assert_eq!(tempo_marking_for(f32::NAN), None);
    }
}
