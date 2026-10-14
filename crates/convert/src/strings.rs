//! Whole-pipeline conversions between strings.
//!
//! The WebAssembly, Node.js and FFI bindings all expose the same two calls —
//! ChordPro source to an `irealb://` URL and an `irealb://` URL to rendered
//! ChordPro text — and each used to spell out the pipeline and the warning
//! format by hand. This module is that pipeline, so the three present one
//! behaviour: the same steps, the same `"<kind>: <message>"` warning strings
//! and the same failure reasons.

use chordsketch_chordpro::config::Config;

use crate::{ConversionWarning, WarningKind, chordpro_to_ireal, ireal_to_chordpro};

impl WarningKind {
    /// The stable tag a warning is shown under (`"lossy-drop"`,
    /// `"approximated"`, `"unsupported"`).
    ///
    /// The match is exhaustive on purpose: a new kind does not compile until
    /// it has a tag, so no entry point can show it under a generic label.
    #[must_use]
    pub fn tag(self) -> &'static str {
        match self {
            Self::LossyDrop => "lossy-drop",
            Self::Approximated => "approximated",
            Self::Unsupported => "unsupported",
        }
    }
}

impl ConversionWarning {
    /// The warning as one `"<kind>: <message>"` string, the form every
    /// string-based entry point reports.
    #[must_use]
    pub fn tagged(&self) -> String {
        format!("{}: {}", self.kind.tag(), self.message)
    }
}

/// A converted string and the warnings raised on the way.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConvertedText {
    /// The converted output.
    pub output: String,
    /// Warnings, each a `"<kind>: <message>"` string; for the iReal →
    /// ChordPro text direction the text renderer's own warnings follow.
    pub warnings: Vec<String>,
}

/// Convert ChordPro source into an `irealb://` URL.
///
/// Pipeline: `parse_multi_lenient` → the first song →
/// [`chordpro_to_ireal`] → [`chordsketch_ireal::irealb_serialize`]. The
/// conversion is lossy (lyrics, fonts, colours and capo have no iReal
/// surface); every drop is a warning.
///
/// # Errors
///
/// The converter's message when the song cannot be represented in iReal.
#[must_use = "a failed conversion must be reported to the caller"]
pub fn chordpro_text_to_irealb(input: &str) -> Result<ConvertedText, String> {
    // `split_at_new_song` unconditionally pushes the trailing segment, so
    // `parse_multi_lenient` always returns at least one result.
    let song = chordsketch_chordpro::parse_multi_lenient(input)
        .results
        .into_iter()
        .next()
        .map(|r| r.song)
        .expect("parse_multi_lenient always returns at least one result");
    let converted = chordpro_to_ireal(&song).map_err(|e| e.to_string())?;
    Ok(ConvertedText {
        output: chordsketch_ireal::irealb_serialize(&converted.output),
        warnings: converted
            .warnings
            .iter()
            .map(ConversionWarning::tagged)
            .collect(),
    })
}

/// Convert an `irealb://` URL into rendered ChordPro text.
///
/// Pipeline: [`chordsketch_ireal::parse`] → [`ireal_to_chordpro`] → the text
/// renderer with the default configuration. The output is the rendered text
/// of the converted song, not ChordPro source.
///
/// # Errors
///
/// The parser's or converter's message when `input` is not a valid
/// `irealb://` payload.
#[must_use = "a failed conversion must be reported to the caller"]
pub fn irealb_to_chordpro_text(input: &str) -> Result<ConvertedText, String> {
    let ireal = chordsketch_ireal::parse(input).map_err(|e| e.to_string())?;
    let converted = ireal_to_chordpro(&ireal).map_err(|e| e.to_string())?;
    let rendered = chordsketch_render_text::render_song_with_warnings(
        &converted.output,
        0,
        &Config::defaults(),
    );
    let mut warnings: Vec<String> = converted
        .warnings
        .iter()
        .map(ConversionWarning::tagged)
        .collect();
    warnings.extend(rendered.warnings);
    Ok(ConvertedText {
        output: rendered.output,
        warnings,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tag_names_every_warning_kind() {
        assert_eq!(WarningKind::LossyDrop.tag(), "lossy-drop");
        assert_eq!(WarningKind::Approximated.tag(), "approximated");
        assert_eq!(WarningKind::Unsupported.tag(), "unsupported");
    }

    #[test]
    fn tagged_joins_the_kind_tag_and_the_message() {
        let w = ConversionWarning::new(WarningKind::LossyDrop, "lyrics dropped");
        assert_eq!(w.tagged(), "lossy-drop: lyrics dropped");
    }

    #[test]
    fn chordpro_text_to_irealb_gives_a_url_and_a_warning_per_dropped_feature() {
        let r = chordpro_text_to_irealb("{title: T}\n{capo: 2}\n[C]Hello [G]world").unwrap();
        assert!(r.output.starts_with("irealb://"), "{}", r.output);
        assert!(
            r.warnings.iter().any(|w| w.starts_with("lossy-drop: ")),
            "lyrics and capo are dropped: {:?}",
            r.warnings
        );
    }

    #[test]
    fn chordpro_text_to_irealb_accepts_empty_input() {
        let r = chordpro_text_to_irealb("").unwrap();
        assert!(r.output.starts_with("irealb://"), "{}", r.output);
    }

    #[test]
    fn irealb_to_chordpro_text_round_trips_the_bar_lines() {
        let url = chordpro_text_to_irealb("{title: T}\n[C]a [G]b")
            .unwrap()
            .output;
        let r = irealb_to_chordpro_text(&url).unwrap();
        assert!(
            r.output.contains('|'),
            "bar boundaries survive: {}",
            r.output
        );
    }

    #[test]
    fn irealb_to_chordpro_text_reports_a_non_ireal_input() {
        let err = irealb_to_chordpro_text("not an irealb url").unwrap_err();
        assert!(!err.is_empty());
    }
}
