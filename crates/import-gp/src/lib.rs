//! Guitar Pro → ChordPro importer.
//!
//! [`import_gp5`] reads a Guitar Pro 5 file (`.gp5`, versions 5.00 and 5.10)
//! and builds a ChordSketch [`Song`] with:
//!
//! - chord names from the chord diagrams of one track, placed over the
//!   lyrics (or on chord-only lines where there are none);
//! - the lyrics, split into syllables the way Guitar Pro lays them over the
//!   notes, even when they belong to a different track (a vocal melody)
//!   than the chords (a rhythm guitar);
//! - section markers as `{start_of_verse}` / `{start_of_chorus}` /
//!   `{start_of_bridge}` with the marker's name as the label;
//! - `{title}`, `{subtitle}`, `{artist}`, `{album}`, `{composer}`,
//!   `{lyricist}`, `{copyright}`, `{key}`, `{time}`, `{tempo}` and
//!   `{capo}`, plus `{key}` / `{tempo}` directives where they change.
//!
//! Tablature, notation, playback and effects are not imported.
//!
//! # Capo
//!
//! Guitar Pro stores tablature and chord diagrams relative to the capo: on a
//! track with a capo on fret 2, a diagram named `Em` is an E-minor shape that
//! sounds as F♯m. ChordPro chords are written at sounding pitch with
//! `{capo}` saying which shapes to play, so the importer raises every chord
//! by the capo (`Em` → `F#m`) and writes `{capo: 2}`. A ChordSketch
//! renderer then shows the `Em` shape again.
//!
//! # Chords that are not chord names
//!
//! A diagram whose name does not read as a chord (or has no name) is spelled
//! from the root and chord type Guitar Pro stores alongside it, with a
//! [`WarningKind::Approximated`](chordsketch_convert::WarningKind::Approximated)
//! warning. When that is not possible either, the chord is omitted with a
//! [`WarningKind::LossyDrop`](chordsketch_convert::WarningKind::LossyDrop)
//! warning.
//!
//! # Example
//!
//! ```no_run
//! use chordsketch_chordpro::song_to_chordpro;
//! use chordsketch_import_gp::{ImportOptions, import_gp5};
//!
//! let bytes = std::fs::read("song.gp5").unwrap();
//! let result = import_gp5(&bytes, &ImportOptions::new()).unwrap();
//! for warning in &result.warnings {
//!     eprintln!("warning: {}", warning.message);
//! }
//! print!("{}", song_to_chordpro(&result.output));
//! ```

#![forbid(unsafe_code)]

mod chord_extractor;
mod chord_name;
mod error;
mod gp5;
mod lyrics;

use chordsketch_chordpro::ast::Song;
use chordsketch_convert::ConversionOutput;

pub use error::GpError;

/// Largest input [`import_gp5`] accepts, in bytes (16 MiB).
///
/// Guitar Pro 5 files are rarely larger than a few hundred kilobytes; the
/// limit exists so a hostile input cannot make the importer allocate without
/// bound. Parsing is linear in the input size: every count in the file is
/// checked against the bytes that remain before anything is allocated for
/// it.
pub const MAX_INPUT_BYTES: usize = 16 * 1024 * 1024;

/// Options for [`import_gp5`].
#[derive(Debug, Clone, Default, PartialEq, Eq)]
#[non_exhaustive]
pub struct ImportOptions {
    /// 1-based number of the track to take chords from. `None` picks the
    /// first track that has chord diagrams (or the first track when none
    /// has).
    pub track: Option<usize>,
}

impl ImportOptions {
    /// Default options: chords from the first track that has chord
    /// diagrams.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Takes chords from `track` (1-based) instead.
    #[must_use]
    pub fn with_track(mut self, track: usize) -> Self {
        self.track = Some(track);
        self
    }
}

/// Imports a Guitar Pro 5 file.
///
/// # Errors
///
/// - [`GpError::TooLarge`] when `bytes` is longer than [`MAX_INPUT_BYTES`];
/// - [`GpError::UnsupportedVersion`] when it is not a Guitar Pro 5 file
///   (Guitar Pro 3, 4, 6 and 7 files included);
/// - [`GpError::Truncated`] / [`GpError::InvalidData`] when the file is
///   damaged;
/// - [`GpError::TrackOutOfRange`] when `options.track` is 0 or larger than
///   the number of tracks.
///
/// Information that could not be carried over is reported in
/// [`ConversionOutput::warnings`] rather than as an error.
#[must_use = "the imported song and its warnings are in the result"]
pub fn import_gp5(
    bytes: &[u8],
    options: &ImportOptions,
) -> Result<ConversionOutput<Song>, GpError> {
    if bytes.len() > MAX_INPUT_BYTES {
        return Err(GpError::TooLarge { size: bytes.len() });
    }
    let parsed = gp5::parse(bytes)?;
    let (song, warnings) = chord_extractor::to_song(&parsed, options.track)?;
    Ok(ConversionOutput::with_warnings(song, warnings))
}
