//! iReal Pro AST types and a zero-dependency JSON debug serializer / parser.
//!
//! This crate carries the iReal Pro data model plus the
//! `irealb://` URL parser (#2054) and serializer (#2052).
//! Conversion to/from ChordPro (#2053 / #2061) and the
//! iReal-style graphical renderer (#2058 et seq) build on this
//! foundation in their own crates.
//!
//! See `ARCHITECTURE.md` (in this crate's directory) for the design
//! decisions behind the AST shape, the field/variant choices made up
//! front to keep the follow-up crates non-breaking, and the open
//! questions deferred to the parser crate (#2054).
//!
//! # Dependency policy
//!
//! Like `chordsketch-chordpro`, this crate has **zero external
//! dependencies**. Mirrors the policy that anchors the core AST in the
//! standard library so downstream crates inherit a minimal compile
//! surface and a stable transitive-dep tree.

#![forbid(unsafe_code)]

pub mod ast;
pub mod json;
pub mod parser;
pub mod serialize;

// Re-export the AST types so call sites can write
// `chordsketch_ireal::IrealSong` instead of
// `chordsketch_ireal::ast::IrealSong`. Mirrors the re-export style
// `chordsketch-chordpro` uses for its frequently-typed names.
pub use ast::{
    Accidental, Bar, BarChord, BarLine, BeatPosition, Chord, ChordQuality, ChordRoot, ChordSize,
    Ending, IrealSong, KeyMode, KeySignature, MusicalSymbol, Section, SectionLabel, TimeSignature,
};
pub use json::{FromJson, JsonError, JsonValue, ToJson, parse_json};
pub use parser::{ParseError, parse, parse_collection};
pub use serialize::{irealb_serialize, irealbook_serialize};

/// Returns the library version (the workspace `Cargo.toml` `version`
/// field, baked in at compile time).
#[must_use]
pub fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}
