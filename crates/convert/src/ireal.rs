//! ChordPro ↔ iReal Pro converter dispatch.
//!
//! Holds the marker types for the two directions and the
//! ergonomic free-function wrappers.
//!
//! - **iReal → ChordPro**
//!   ([#2053](https://github.com/koedame/chordsketch/issues/2053)):
//!   implemented; the [`IrealToChordPro`] marker delegates to
//!   [`crate::from_ireal::convert`]. Near-lossless; the documented
//!   drops live in `crates/convert/known-deviations.md`.
//! - **ChordPro → iReal**
//!   ([#2061](https://github.com/koedame/chordsketch/issues/2061)):
//!   implemented; [`ChordProToIreal`] delegates to
//!   [`crate::to_ireal::convert`]. Lossy (lyrics / fonts / colours /
//!   capo dropped); every drop surfaces as a [`crate::ConversionWarning`]
//!   with [`crate::WarningKind::LossyDrop`]. Full mapping table in
//!   `crates/convert/known-deviations.md`.

use chordsketch_chordpro::ast::Song;
use chordsketch_ireal::IrealSong;

use crate::{ConversionError, ConversionOutput, Converter};

/// Marker type implementing [`Converter<Song, IrealSong>`] for the
/// ChordPro→iReal direction. Stateless — the unit value is the
/// canonical instance.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct ChordProToIreal;

impl Converter<Song, IrealSong> for ChordProToIreal {
    fn convert(&self, source: &Song) -> Result<ConversionOutput<IrealSong>, ConversionError> {
        // The actual mapping logic lives in `crate::to_ireal` so
        // the marker struct stays a thin pass-through, mirroring
        // the iReal→ChordPro side that delegates to
        // `crate::from_ireal`.
        crate::to_ireal::convert(source)
    }
}

/// Marker type implementing [`Converter<IrealSong, Song>`] for the
/// iReal→ChordPro direction.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct IrealToChordPro;

impl Converter<IrealSong, Song> for IrealToChordPro {
    fn convert(&self, source: &IrealSong) -> Result<ConversionOutput<Song>, ConversionError> {
        // The actual mapping logic lives in `crate::from_ireal` so
        // the marker struct stays a thin pass-through. Keeping the
        // logic in its own module lets the unit tests sit next to
        // the implementation without polluting this file.
        crate::from_ireal::convert(source)
    }
}

/// Convenience wrapper around [`ChordProToIreal::convert`].
///
/// # Errors
///
/// The current mapping never returns `Err` — every well-formed
/// [`Song`] produces a (possibly warning-laden) [`IrealSong`].
/// The [`ConversionError`] return type is preserved so future
/// strictness-mode hooks can introduce
/// [`ConversionError::InvalidSource`] without a breaking change.
#[must_use = "ignoring a conversion result drops both warnings and errors"]
pub fn chordpro_to_ireal(song: &Song) -> Result<ConversionOutput<IrealSong>, ConversionError> {
    ChordProToIreal.convert(song)
}

/// Convenience wrapper around [`IrealToChordPro::convert`].
///
/// # Errors
///
/// The current implementation never returns an error — every
/// well-formed [`IrealSong`] produces a well-formed [`Song`].
/// The `Result` return type is preserved so future
/// strictness-mode hooks can introduce
/// [`ConversionError::InvalidSource`] without a breaking change.
/// Lossy but successful conversions return `Ok` with a non-empty
/// `warnings` list; see [`crate::from_ireal`] for the full
/// mapping.
#[must_use = "ignoring a conversion result drops both warnings and errors"]
pub fn ireal_to_chordpro(song: &IrealSong) -> Result<ConversionOutput<Song>, ConversionError> {
    IrealToChordPro.convert(song)
}
