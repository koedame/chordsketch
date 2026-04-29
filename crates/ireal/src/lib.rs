//! iReal Pro AST types and a zero-dependency JSON debug serializer / parser.
//!
//! This crate is the foundational scaffold for `irealb://` URL parsing
//! (#2054), URL serialization (#2052), conversion to/from ChordPro
//! (#2053 / #2061), and the iReal-style graphical renderer (#2058 et seq).
//! It deliberately ships only the data model — no parser, no URL writer,
//! no renderer — so the cross-cutting AST shape can stabilise before the
//! follow-up crates layer features on top.
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

// Re-export the AST types so call sites can write
// `chordsketch_ireal::IrealSong` instead of
// `chordsketch_ireal::ast::IrealSong`. Mirrors the re-export style
// `chordsketch-chordpro` uses for its frequently-typed names.
pub use ast::{
    Accidental, Bar, BarChord, BarLine, BeatPosition, Chord, ChordQuality, ChordRoot, Ending,
    IrealSong, KeyMode, KeySignature, MusicalSymbol, Section, SectionLabel, TimeSignature,
};
pub use json::{FromJson, JsonError, JsonValue, ToJson, parse_json};

/// Returns the library version (the workspace `Cargo.toml` `version`
/// field, baked in at compile time).
#[must_use]
pub fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}
