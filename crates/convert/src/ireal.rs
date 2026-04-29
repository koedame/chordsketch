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
//!   not yet implemented; [`ChordProToIreal`] still returns
//!   [`ConversionError::NotImplemented`] pointing at the tracking
//!   issue. Lyrics will be dropped (iReal has no lyrics surface)
//!   — that drop will surface as a [`crate::ConversionWarning`]
//!   with [`crate::WarningKind::LossyDrop`] when the
//!   implementation lands.

use chordsketch_chordpro::ast::Song;
use chordsketch_ireal::IrealSong;

use crate::{ConversionError, ConversionOutput, Converter};

/// Marker type implementing [`Converter<Song, IrealSong>`] for the
/// ChordPro→iReal direction. Stateless — the unit value is the
/// canonical instance.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct ChordProToIreal;

impl Converter<Song, IrealSong> for ChordProToIreal {
    fn convert(&self, _source: &Song) -> Result<ConversionOutput<IrealSong>, ConversionError> {
        Err(ConversionError::NotImplemented(
            "https://github.com/koedame/chordsketch/issues/2061",
        ))
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
/// Currently always returns [`ConversionError::NotImplemented`].
/// See [`crate::ireal`] for the tracking issue.
#[must_use = "ignoring a conversion result drops both warnings and errors"]
pub fn chordpro_to_ireal(song: &Song) -> Result<ConversionOutput<IrealSong>, ConversionError> {
    ChordProToIreal.convert(song)
}

/// Convenience wrapper around [`IrealToChordPro::convert`].
///
/// # Errors
///
/// Returns [`ConversionError::InvalidSource`] if the source AST
/// cannot be represented in ChordPro at all (not expected for
/// well-formed ASTs produced by the iReal parser). Lossy but
/// successful conversions return `Ok` with a non-empty `warnings`
/// list. See [`crate::from_ireal`] for the full mapping.
#[must_use = "ignoring a conversion result drops both warnings and errors"]
pub fn ireal_to_chordpro(song: &IrealSong) -> Result<ConversionOutput<Song>, ConversionError> {
    IrealToChordPro.convert(song)
}
