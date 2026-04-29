//! ChordPro ↔ iReal Pro format-conversion bridge.
//!
//! This crate is the trait scaffold for the bidirectional converter
//! tracked under [#2050](https://github.com/koedame/chordsketch/issues/2050).
//! It deliberately ships only the public API shape — every conversion
//! function returns [`ConversionError::NotImplemented`] until the
//! direction-specific follow-up issues land. Locking the surface in
//! up front lets the bindings (#2067) and the CLI auto-detect path
//! (#2066) reference stable types from day one.
//!
//! # Layout
//!
//! - [`Converter`] is the generic trait every direction implements.
//!   Free functions [`chordpro_to_ireal`] and [`ireal_to_chordpro`]
//!   wrap the trait implementations for ergonomics. New formats
//!   (MusicXML, Guitar Pro, etc.) plug in as additional `Converter`
//!   implementations or as their own crates that depend on this one
//!   for the warning / error vocabulary.
//! - [`ConversionOutput`] pairs the converted value with a
//!   [`ConversionWarning`] list so callers can surface lossy
//!   transformations without parsing the error type.
//! - [`ConversionError`] enumerates the reasons a conversion can
//!   fail. The `NotImplemented` variant is the placeholder every
//!   pre-implementation function currently returns.
//!
//! # Why a separate crate from `chordsketch-convert-musicxml`
//!
//! `chordsketch-convert-musicxml` predates this crate and binds the
//! ChordPro AST to MusicXML directly via free functions. The new
//! `chordsketch-convert` crate is the conversion home for formats
//! that share a small intermediate concept set (warnings, lossy
//! drops, approximations) — namely the ChordPro ↔ iReal bridge and
//! its expected MusicXML / Guitar Pro siblings. Consolidating the
//! musicxml converter into this crate is tracked in a future
//! cleanup; it would be a breaking change that does not block
//! v0.3.0.
//!
//! # Stability
//!
//! Pre-1.0 — the trait surface is intentionally narrow so the
//! follow-up issues can fill in implementations without breaking
//! the bindings or CLI. [`ConversionError`] and [`WarningKind`]
//! are both `#[non_exhaustive]`, so adding a new variant is
//! non-breaking for downstream `match` expressions; renaming an
//! existing variant remains breaking.
//!
//! # Example
//!
//! ```
//! use chordsketch_chordpro::ast::Song;
//! use chordsketch_convert::{ConversionError, chordpro_to_ireal};
//!
//! let song = Song::new();
//! match chordpro_to_ireal(&song) {
//!     Ok(_output) => unreachable!("scaffold returns NotImplemented"),
//!     Err(ConversionError::NotImplemented(tracking_url)) => {
//!         assert!(tracking_url.contains("issues/2061"));
//!     }
//!     Err(_) => unreachable!("scaffold only returns NotImplemented"),
//! }
//! ```

#![forbid(unsafe_code)]

pub mod error;
pub mod ireal;

pub use error::{ConversionError, ConversionWarning, WarningKind};
pub use ireal::{ChordProToIreal, IrealToChordPro, chordpro_to_ireal, ireal_to_chordpro};

/// Result of a successful conversion.
///
/// `output` is the converted value; `warnings` is the list of
/// information lost or approximated during the transformation. An
/// empty `warnings` vector indicates a clean (lossless) conversion;
/// callers that prefer fail-fast behaviour can promote any non-empty
/// warning list to an error themselves.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConversionOutput<T> {
    /// The converted value.
    pub output: T,
    /// Warnings emitted during conversion (lossy drops,
    /// approximations, unsupported features).
    pub warnings: Vec<ConversionWarning>,
}

impl<T> ConversionOutput<T> {
    /// Wraps `output` with an empty warning list.
    #[must_use]
    pub fn lossless(output: T) -> Self {
        Self {
            output,
            warnings: Vec::new(),
        }
    }

    /// Wraps `output` with the provided warning list.
    #[must_use]
    pub fn with_warnings(output: T, warnings: Vec<ConversionWarning>) -> Self {
        Self { output, warnings }
    }
}

/// A converter that transforms `Source` into `Target`.
///
/// Implementations live alongside the source / target types — the
/// ChordPro ↔ iReal pair is in [`crate::ireal`]. Adding a new
/// direction means implementing `Converter<S, T>` for a new unit
/// struct (or extending an existing one) and re-exporting an
/// ergonomic free function from this crate's root.
///
/// # Why a trait in addition to free functions
///
/// The free functions in [`crate::ireal`] are the ergonomic entry
/// point for a known direction. The trait exists for two callers
/// the free functions cannot serve:
///
/// - **Generic dispatch.** A future pipeline that runs the same
///   ChordSketch `Song` through several converters
///   (`Vec<Box<dyn Converter<Song, MusicXml>>>` etc.) needs a
///   uniform type to hold them. The CLI auto-detect path (#2066)
///   is the first concrete consumer.
/// - **Configurable converters.** Once #2053 / #2061 land, an
///   implementation may need configuration (strictness level,
///   warning thresholds). A marker struct with fields holds that
///   state; the free function then becomes a thin wrapper around
///   the default-configured marker. Keeping the trait in place
///   from day one avoids a breaking re-shape later.
///
/// # Errors
///
/// Implementations return [`ConversionError`]; see that type for the
/// failure-mode taxonomy. Lossy but successful conversions return
/// `Ok(ConversionOutput { warnings: [...], .. })`, not `Err` — the
/// caller decides whether warnings should be promoted to errors.
pub trait Converter<Source, Target> {
    /// Converts `source` into `Target`, accumulating any
    /// information lost in `ConversionOutput::warnings`.
    ///
    /// # Errors
    ///
    /// See [`ConversionError`] for the documented failure modes.
    /// While the scaffold is in place every implementation returns
    /// [`ConversionError::NotImplemented`].
    #[must_use = "ignoring a conversion result drops both warnings and errors"]
    fn convert(&self, source: &Source) -> Result<ConversionOutput<Target>, ConversionError>;
}

/// Returns the library version (the workspace `Cargo.toml`
/// `version` field, baked in at compile time).
#[must_use]
pub fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}
