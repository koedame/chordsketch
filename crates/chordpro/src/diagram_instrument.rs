//! The instruments the standalone chord-diagram entry points accept.
//!
//! Every surface that draws or auditions a single chord on request — the
//! WebAssembly, Node.js and FFI bindings and the MCP server — takes an
//! instrument name as a string and has to decide three things the same way:
//! which names are accepted, how a diagram is looked up and drawn for each,
//! and what an unknown name is reported as. This module is that decision, so
//! changing the accepted set is one edit here instead of one per entry point.
//! (The `{diagrams: <instrument>}` directive resolves names separately, in
//! [`resolve_diagrams_instrument`](crate::chord_diagram::resolve_diagrams_instrument),
//! and the voicing lookup in [`crate::voicings`] has its own dispatch.)
//!
//! `{define}` overrides reach the fretted instruments only: the keyboard
//! voicing lookup takes its defines in a different shape and is called with
//! none here, so a keyboard diagram is always the built-in or synthesised
//! voicing.

use std::fmt;

use crate::chord_diagram::{
    DEFAULT_FRETS_SHOWN, DiagramSize, render_keyboard_svg_with_size, render_svg_with_options,
    resolve_orientation,
};
use crate::voicings::{lookup_diagram, lookup_keyboard_voicing};

/// What family of diagram an instrument name selects.
enum Family {
    Fretted,
    Keyboard,
}

/// Classify a case-insensitive instrument name, or `None` when the entry
/// points do not accept it.
fn family(instrument: &str) -> Option<Family> {
    match instrument.to_ascii_lowercase().as_str() {
        "guitar" | "ukulele" | "uke" | "charango" => Some(Family::Fretted),
        "piano" | "keyboard" | "keys" => Some(Family::Keyboard),
        _ => None,
    }
}

/// The instrument name is not one the entry points accept.
///
/// Its [`Display`](fmt::Display) form is the caller-facing message.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UnknownInstrument {
    name: String,
}

impl fmt::Display for UnknownInstrument {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "unknown instrument {:?}; expected one of \"guitar\", \"ukulele\", \"charango\", \"piano\"",
            self.name
        )
    }
}

impl std::error::Error for UnknownInstrument {}

/// Render the diagram of `chord` on `instrument` as an SVG fragment.
///
/// Fretted diagrams show [`DEFAULT_FRETS_SHOWN`] frets — what the HTML
/// renderer draws when no `{chordfrets}` directive is set — so a diagram
/// drawn here matches the one on a rendered sheet. `orientation` is resolved
/// like [`resolve_orientation`] (`None` and unrecognised strings give the
/// default); keyboard diagrams ignore it.
///
/// Returns `Ok(None)` when the instrument is known but no voicing can be
/// drawn for `chord`.
///
/// # Errors
///
/// [`UnknownInstrument`] when `instrument` is not accepted.
#[must_use = "the caller must distinguish an unknown instrument from an undrawable chord"]
pub fn render_svg(
    chord: &str,
    instrument: &str,
    defines: &[(String, String)],
    orientation: Option<&str>,
    size: DiagramSize,
) -> Result<Option<String>, UnknownInstrument> {
    match family(instrument) {
        Some(Family::Keyboard) => Ok(
            lookup_keyboard_voicing(chord, &[]).map(|v| render_keyboard_svg_with_size(&v, size))
        ),
        Some(Family::Fretted) => {
            Ok(
                lookup_diagram(chord, defines, instrument, DEFAULT_FRETS_SHOWN)
                    .map(|d| render_svg_with_options(&d, resolve_orientation(orientation), size)),
            )
        }
        None => Err(UnknownInstrument {
            name: instrument.to_ascii_lowercase(),
        }),
    }
}

/// The MIDI notes the diagram [`render_svg`] draws for `chord` on
/// `instrument` sounds, so a diagram can be auditioned as exactly the shape
/// it depicts.
///
/// Returns `None` for an instrument [`render_svg`] would reject — the audio
/// surface never sounds an instrument that has no drawable diagram — and when
/// no voicing exists for `chord`.
#[must_use]
pub fn pitches(chord: &str, instrument: &str, defines: &[(String, String)]) -> Option<Vec<u8>> {
    family(instrument)?;
    crate::voicings::diagram_pitches(chord, defines, instrument, DEFAULT_FRETS_SHOWN)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn render_svg_accepts_every_alias_case_insensitively() {
        for name in [
            "guitar", "Guitar", "ukulele", "UKULELE", "uke", "charango", "Charango", "piano",
            "Keyboard", "keys",
        ] {
            assert!(
                render_svg("C", name, &[], None, DiagramSize::Regular).is_ok(),
                "{name}"
            );
        }
        for name in ["theremin", "", "gui tar"] {
            assert!(
                render_svg("C", name, &[], None, DiagramSize::Regular).is_err(),
                "{name}"
            );
        }
    }

    #[test]
    fn render_svg_draws_a_fretted_and_a_keyboard_diagram() {
        let guitar = render_svg("C", "guitar", &[], None, DiagramSize::Regular)
            .unwrap()
            .expect("C has a guitar voicing");
        assert!(guitar.starts_with("<svg"), "{guitar}");
        let uke = render_svg("C", "uke", &[], None, DiagramSize::Regular)
            .unwrap()
            .expect("C has a ukulele voicing");
        assert_ne!(uke, guitar, "ukulele is not drawn as a guitar");
        let charango = render_svg("C", "Charango", &[], None, DiagramSize::Regular)
            .unwrap()
            .expect("C has a charango voicing");
        assert_ne!(charango, uke, "charango is not drawn as a ukulele");
        assert!(charango.starts_with("<svg"), "{charango}");
        let piano = render_svg("C", "Keys", &[], None, DiagramSize::Regular)
            .unwrap()
            .expect("C has a keyboard voicing");
        assert!(piano.contains("keyboard"), "{piano}");
    }

    #[test]
    fn render_svg_is_none_when_the_chord_has_no_voicing() {
        for instrument in ["guitar", "piano"] {
            assert_eq!(
                render_svg(
                    "XYZ-not-a-chord",
                    instrument,
                    &[],
                    None,
                    DiagramSize::Regular
                ),
                Ok(None),
                "{instrument}"
            );
        }
    }

    #[test]
    fn render_svg_reports_an_unknown_instrument_by_its_lowercase_name() {
        let err = render_svg("C", "Harmonica", &[], None, DiagramSize::Regular).unwrap_err();
        assert_eq!(
            err.to_string(),
            "unknown instrument \"harmonica\"; expected one of \"guitar\", \"ukulele\", \"charango\", \"piano\""
        );
    }

    #[test]
    fn render_svg_honours_orientation_size_and_song_defines_for_fretted_diagrams() {
        let regular = render_svg("Am", "guitar", &[], None, DiagramSize::Regular)
            .unwrap()
            .unwrap();
        let horizontal = render_svg(
            "Am",
            "guitar",
            &[],
            Some("horizontal"),
            DiagramSize::Regular,
        )
        .unwrap()
        .unwrap();
        assert_ne!(regular, horizontal);
        let compact = render_svg("Am", "guitar", &[], None, DiagramSize::Compact)
            .unwrap()
            .unwrap();
        assert!(compact.contains("chord-diagram-compact"), "{compact}");
        let defined = render_svg(
            "Am",
            "guitar",
            &[(
                "Am".to_string(),
                "base-fret 1 frets 0 0 0 0 0 0".to_string(),
            )],
            None,
            DiagramSize::Regular,
        )
        .unwrap()
        .unwrap();
        assert_ne!(
            defined, regular,
            "a song {{define}} replaces the built-in voicing"
        );
    }

    #[test]
    fn pitches_sound_the_drawn_shape_and_reject_what_render_svg_rejects() {
        assert!(pitches("C", "guitar", &[]).is_some());
        let charango = pitches("C", "charango", &[]).expect("C has a charango voicing");
        assert!(!charango.is_empty());
        assert_eq!(
            Some(charango),
            crate::voicings::diagram_pitches("C", &[], "charango", DEFAULT_FRETS_SHOWN),
            "the audio is the core's own charango voicing"
        );
        assert_eq!(pitches("C", "piano", &[]), Some(vec![60, 64, 67]));
        assert_eq!(pitches("XYZ-not-a-chord", "guitar", &[]), None);
        assert_eq!(pitches("C", "theremin", &[]), None);
    }
}
