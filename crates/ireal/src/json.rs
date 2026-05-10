//! Zero-dependency JSON debug serializer.
//!
//! Emits a stable, human-readable JSON view of an [`IrealSong`] for
//! testing and golden-snapshot diffing. Not a public wire format —
//! the canonical iReal serialisation is the `irealb://` URL, owned
//! by #2052.
//!
//! # Why hand-rolled
//!
//! `chordsketch-chordpro` is zero-dependency on principle (see the
//! crate's `Cargo.toml`); this crate inherits that policy because the
//! AST types are the cross-cutting layer that every iReal-related
//! follow-up crate (#2052 / #2054 / #2058 / etc.) builds on. Adding
//! `serde` here would force the policy onto every dependent. The
//! debug-format escape rules are limited to what the AST actually
//! produces (printable strings + numbers + finite enum variants), so
//! the hand-rolled writer stays small without sacrificing
//! correctness.
//!
//! # Format
//!
//! Output is compact (no indentation) but deterministic — the field
//! order matches the struct field order in `ast.rs`, which is the
//! property golden-snapshot tests rely on. JSON strings are escaped
//! per RFC 8259 §7 (only the mandatory escapes plus `\u{XXXX}` for
//! C0 control chars).

use crate::ast::{
    Accidental, Bar, BarChord, BarLine, BeatPosition, Chord, ChordQuality, ChordRoot, Ending,
    IrealSong, KeyMode, KeySignature, MusicalSymbol, Section, SectionLabel, TimeSignature,
};

/// Anything that knows how to write itself as JSON into a `String`
/// buffer. Implementors append; the caller decides what the buffer
/// is for (a `String::new()` for one-off serialisation, a shared
/// buffer for a multi-song collection).
pub trait ToJson {
    /// Append this value's JSON form to `out`. The format is
    /// documented at the module level.
    fn to_json(&self, out: &mut String);

    /// Convenience: allocate a fresh `String` and serialise into it.
    /// Equivalent to `let mut s = String::new(); self.to_json(&mut s); s`.
    #[must_use]
    fn to_json_string(&self) -> String {
        let mut out = String::new();
        self.to_json(&mut out);
        out
    }
}

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

fn write_str(out: &mut String, s: &str) {
    out.push('"');
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\x08' => out.push_str("\\b"),
            '\x0c' => out.push_str("\\f"),
            c if (c as u32) < 0x20 => {
                // Mandatory `\u{XXXX}` escape for the remaining C0
                // controls (NUL, …, US except the named escapes
                // above). Higher Unicode passes through verbatim
                // because the JSON output is UTF-8 and JSON allows
                // any Unicode scalar inside a string literal.
                use core::fmt::Write;
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

fn write_opt_str(out: &mut String, s: &Option<String>) {
    match s {
        Some(v) => write_str(out, v),
        None => out.push_str("null"),
    }
}

fn write_u8(out: &mut String, v: u8) {
    use core::fmt::Write;
    let _ = write!(out, "{v}");
}

fn write_i8(out: &mut String, v: i8) {
    use core::fmt::Write;
    let _ = write!(out, "{v}");
}

fn write_u16(out: &mut String, v: u16) {
    use core::fmt::Write;
    let _ = write!(out, "{v}");
}

fn write_opt_u16(out: &mut String, v: &Option<u16>) {
    match v {
        Some(n) => write_u16(out, *n),
        None => out.push_str("null"),
    }
}

fn write_array<T: ToJson>(out: &mut String, items: &[T]) {
    out.push('[');
    for (i, item) in items.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        item.to_json(out);
    }
    out.push(']');
}

// ---------------------------------------------------------------------------
// AST impls
// ---------------------------------------------------------------------------

impl ToJson for IrealSong {
    fn to_json(&self, out: &mut String) {
        out.push('{');
        out.push_str("\"title\":");
        write_str(out, &self.title);
        out.push_str(",\"composer\":");
        write_opt_str(out, &self.composer);
        out.push_str(",\"style\":");
        write_opt_str(out, &self.style);
        out.push_str(",\"key_signature\":");
        self.key_signature.to_json(out);
        out.push_str(",\"time_signature\":");
        self.time_signature.to_json(out);
        out.push_str(",\"tempo\":");
        write_opt_u16(out, &self.tempo);
        out.push_str(",\"transpose\":");
        write_i8(out, self.transpose);
        out.push_str(",\"sections\":");
        write_array(out, &self.sections);
        out.push('}');
    }
}

impl ToJson for Section {
    fn to_json(&self, out: &mut String) {
        out.push('{');
        out.push_str("\"label\":");
        self.label.to_json(out);
        out.push_str(",\"bars\":");
        write_array(out, &self.bars);
        out.push('}');
    }
}

impl ToJson for SectionLabel {
    fn to_json(&self, out: &mut String) {
        out.push('{');
        match self {
            Self::Letter(c) => {
                out.push_str("\"kind\":\"letter\",\"value\":");
                let s = c.to_string();
                write_str(out, &s);
            }
            Self::Verse => out.push_str("\"kind\":\"verse\""),
            Self::Chorus => out.push_str("\"kind\":\"chorus\""),
            Self::Intro => out.push_str("\"kind\":\"intro\""),
            Self::Outro => out.push_str("\"kind\":\"outro\""),
            Self::Bridge => out.push_str("\"kind\":\"bridge\""),
            Self::Custom(s) => {
                out.push_str("\"kind\":\"custom\",\"value\":");
                write_str(out, s);
            }
        }
        out.push('}');
    }
}

impl ToJson for Bar {
    fn to_json(&self, out: &mut String) {
        out.push('{');
        out.push_str("\"start\":");
        self.start.to_json(out);
        out.push_str(",\"end\":");
        self.end.to_json(out);
        out.push_str(",\"chords\":");
        write_array(out, &self.chords);
        out.push_str(",\"ending\":");
        match &self.ending {
            Some(e) => write_u8(out, e.number()),
            None => out.push_str("null"),
        }
        out.push_str(",\"symbol\":");
        match &self.symbol {
            Some(s) => s.to_json(out),
            None => out.push_str("null"),
        }
        if self.repeat_previous {
            // Emit only when true; downstream readers tolerate the
            // missing field as `false` (`get_optional` in
            // `Bar::from_json_value`). Keeps regular bars one byte
            // smaller in the wasm JSON payload.
            out.push_str(",\"repeat_previous\":true");
        }
        if self.no_chord {
            out.push_str(",\"no_chord\":true");
        }
        if let Some(text) = &self.text_comment {
            out.push_str(",\"text_comment\":");
            write_str(out, text);
        }
        out.push('}');
    }
}

impl ToJson for BarLine {
    fn to_json(&self, out: &mut String) {
        let s = match self {
            Self::Single => "single",
            Self::Double => "double",
            Self::Final => "final",
            Self::OpenRepeat => "open_repeat",
            Self::CloseRepeat => "close_repeat",
        };
        write_str(out, s);
    }
}

impl ToJson for Ending {
    fn to_json(&self, out: &mut String) {
        write_u8(out, self.number());
    }
}

impl ToJson for BarChord {
    fn to_json(&self, out: &mut String) {
        out.push('{');
        out.push_str("\"chord\":");
        self.chord.to_json(out);
        out.push_str(",\"position\":");
        self.position.to_json(out);
        out.push('}');
    }
}

impl ToJson for BeatPosition {
    fn to_json(&self, out: &mut String) {
        out.push('{');
        out.push_str("\"beat\":");
        write_u8(out, self.beat.get());
        out.push_str(",\"subdivision\":");
        write_u8(out, self.subdivision);
        out.push('}');
    }
}

impl ToJson for Chord {
    fn to_json(&self, out: &mut String) {
        out.push('{');
        out.push_str("\"root\":");
        self.root.to_json(out);
        out.push_str(",\"quality\":");
        self.quality.to_json(out);
        out.push_str(",\"bass\":");
        match &self.bass {
            Some(b) => b.to_json(out),
            None => out.push_str("null"),
        }
        if let Some(alt) = &self.alternate {
            out.push_str(",\"alternate\":");
            alt.to_json(out);
        }
        out.push('}');
    }
}

impl ToJson for ChordRoot {
    fn to_json(&self, out: &mut String) {
        out.push('{');
        out.push_str("\"note\":");
        let s = self.note.to_string();
        write_str(out, &s);
        out.push_str(",\"accidental\":");
        self.accidental.to_json(out);
        out.push('}');
    }
}

impl ToJson for Accidental {
    fn to_json(&self, out: &mut String) {
        let s = match self {
            Self::Natural => "natural",
            Self::Flat => "flat",
            Self::Sharp => "sharp",
        };
        write_str(out, s);
    }
}

impl ToJson for ChordQuality {
    fn to_json(&self, out: &mut String) {
        out.push('{');
        match self {
            Self::Major => out.push_str("\"kind\":\"major\""),
            Self::Minor => out.push_str("\"kind\":\"minor\""),
            Self::Diminished => out.push_str("\"kind\":\"diminished\""),
            Self::Augmented => out.push_str("\"kind\":\"augmented\""),
            Self::Major7 => out.push_str("\"kind\":\"major7\""),
            Self::Minor7 => out.push_str("\"kind\":\"minor7\""),
            Self::Dominant7 => out.push_str("\"kind\":\"dominant7\""),
            Self::HalfDiminished => out.push_str("\"kind\":\"half_diminished\""),
            Self::Diminished7 => out.push_str("\"kind\":\"diminished7\""),
            Self::Suspended2 => out.push_str("\"kind\":\"suspended2\""),
            Self::Suspended4 => out.push_str("\"kind\":\"suspended4\""),
            Self::Custom(s) => {
                out.push_str("\"kind\":\"custom\",\"value\":");
                write_str(out, s);
            }
        }
        out.push('}');
    }
}

impl ToJson for KeySignature {
    fn to_json(&self, out: &mut String) {
        out.push('{');
        out.push_str("\"root\":");
        self.root.to_json(out);
        out.push_str(",\"mode\":");
        self.mode.to_json(out);
        out.push('}');
    }
}

impl ToJson for KeyMode {
    fn to_json(&self, out: &mut String) {
        let s = match self {
            Self::Major => "major",
            Self::Minor => "minor",
        };
        write_str(out, s);
    }
}

impl ToJson for TimeSignature {
    fn to_json(&self, out: &mut String) {
        out.push('{');
        out.push_str("\"numerator\":");
        write_u8(out, self.numerator);
        out.push_str(",\"denominator\":");
        write_u8(out, self.denominator);
        out.push('}');
    }
}

impl ToJson for MusicalSymbol {
    fn to_json(&self, out: &mut String) {
        let s = match self {
            Self::Segno => "segno",
            Self::Coda => "coda",
            Self::DaCapo => "da_capo",
            Self::DalSegno => "dal_segno",
            Self::Fine => "fine",
        };
        write_str(out, s);
    }
}

// ===========================================================================
// Deserialization
// ===========================================================================
//
// A minimal JSON parser sized to exactly the shape `ToJson` emits — strings,
// non-negative integers, signed integers (only for `transpose`), `null`,
// arrays, and string-keyed objects. The deserializer is **not** a generic
// JSON library; it round-trips the testing-only debug format documented at
// the top of this module and rejects anything outside that grammar with
// `JsonError`. Parser scope and AST scope evolve together; widening one
// without the other is a structural defect.
//
// # Resource limits
//
// The parser is intended for trusted debug-snapshot input but is hardened
// for adversarial use anyway, because the AST surface is reachable from
// every iReal-related follow-up crate and the bindings in #2067. Hard
// limits below are documented constants — tweaking any of them is a
// review-required change because raising the bound on adversarial input
// linearly raises the worst-case memory cost.

/// Hard cap on the input byte length accepted by [`parse_json`]. Larger
/// inputs are rejected up-front so a single very-long string cannot
/// dominate the heap.
pub const MAX_INPUT_BYTES: usize = 4 * 1024 * 1024;

/// Maximum nesting depth (objects + arrays). Protects against
/// stack-overflow crashes from inputs like `[[[[[[…`.
pub const MAX_DEPTH: u16 = 128;

/// Maximum number of elements in any single array.
pub const MAX_ARRAY_LEN: usize = 65_536;

/// Maximum number of fields in any single object.
pub const MAX_OBJECT_FIELDS: usize = 65_536;

/// Maximum decoded length of any single JSON string in characters
/// (after escape decoding). Keeps individual string-allocation cost
/// bounded so a 4 MB input cannot decode into a much larger heap value.
pub const MAX_STRING_CHARS: usize = 1 << 20;

fn utf8_lead_width(b: u8) -> Option<usize> {
    // Maps a UTF-8 leading byte to its scalar width in bytes. Returns
    // `None` for continuation bytes (0x80..=0xBF) and invalid lead bytes
    // (0xF8..). The single-byte ASCII case is handled by the caller.
    if b < 0x80 {
        Some(1)
    } else if b < 0xC0 {
        None
    } else if b < 0xE0 {
        Some(2)
    } else if b < 0xF0 {
        Some(3)
    } else if b < 0xF8 {
        Some(4)
    } else {
        None
    }
}

fn truncate_for_message(s: &str) -> String {
    // Cap user-controlled bytes that flow into `JsonError::message` so the
    // error-string size stays bounded even if upstream relaxes
    // `MAX_STRING_CHARS`. 64 chars is enough to identify a key/value
    // without dominating a log line.
    const LIMIT: usize = 64;
    let mut out = String::new();
    out.push('"');
    for (i, ch) in s.chars().enumerate() {
        if i >= LIMIT {
            out.push('…');
            break;
        }
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c if (c as u32) < 0x20 => {
                use core::fmt::Write;
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// An error produced by [`parse_json`] or one of the [`FromJson`] impls.
///
/// `position` is the zero-based byte index in the input string at which the
/// parser noticed the problem (or `0` for "field missing" errors that
/// originate after parsing). `message` is a short, English description.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JsonError {
    /// Byte index in the source where the error was detected.
    pub position: usize,
    /// Short human-readable description.
    pub message: String,
}

impl JsonError {
    fn new(position: usize, msg: impl Into<String>) -> Self {
        Self {
            position,
            message: msg.into(),
        }
    }
}

impl core::fmt::Display for JsonError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        write!(f, "{} (at byte {})", self.message, self.position)
    }
}

impl std::error::Error for JsonError {}

/// A parsed JSON value. The variants correspond exactly to what the
/// [`ToJson`] impls in this module emit; floating-point numbers are
/// absent on purpose because the AST never serialises them. `Bool`
/// is emitted only for the `Bar.repeat_previous` flag.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum JsonValue {
    /// JSON `null`.
    Null,
    /// JSON `true` / `false`. Used by `Bar.repeat_previous`.
    Bool(bool),
    /// A signed integer. The serialiser only emits `i8`, `u8`, and `u16`,
    /// so `i64` covers every value losslessly.
    Integer(i64),
    /// A JSON string with all escapes already decoded.
    String(String),
    /// A JSON array.
    Array(Vec<JsonValue>),
    /// A JSON object with insertion-order field list. Duplicate keys are
    /// rejected at parse time so AST extractors do not have to choose
    /// between "first wins" and "last wins" semantics.
    Object(Vec<(String, JsonValue)>),
}

impl JsonValue {
    fn get(&self, key: &str) -> Result<&JsonValue, JsonError> {
        match self {
            Self::Object(fields) => fields
                .iter()
                .find(|(k, _)| k == key)
                .map(|(_, v)| v)
                .ok_or_else(|| {
                    JsonError::new(0, format!("missing field {}", truncate_for_message(key)))
                }),
            _ => Err(JsonError::new(
                0,
                format!("expected object for {}", truncate_for_message(key)),
            )),
        }
    }

    fn get_optional(&self, key: &str) -> Option<&JsonValue> {
        match self {
            Self::Object(fields) => fields.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }

    fn as_str(&self) -> Result<&str, JsonError> {
        match self {
            Self::String(s) => Ok(s.as_str()),
            _ => Err(JsonError::new(0, "expected string".to_string())),
        }
    }

    fn as_array(&self) -> Result<&[JsonValue], JsonError> {
        match self {
            Self::Array(v) => Ok(v.as_slice()),
            _ => Err(JsonError::new(0, "expected array".to_string())),
        }
    }

    fn as_int(&self) -> Result<i64, JsonError> {
        match self {
            Self::Integer(n) => Ok(*n),
            _ => Err(JsonError::new(0, "expected integer".to_string())),
        }
    }

    fn as_opt_str(&self) -> Result<Option<&str>, JsonError> {
        match self {
            Self::Null => Ok(None),
            Self::String(s) => Ok(Some(s.as_str())),
            _ => Err(JsonError::new(0, "expected string or null".to_string())),
        }
    }

    fn as_opt_int(&self) -> Result<Option<i64>, JsonError> {
        match self {
            Self::Null => Ok(None),
            Self::Integer(n) => Ok(Some(*n)),
            _ => Err(JsonError::new(0, "expected integer or null".to_string())),
        }
    }
}

/// Parses a JSON string into a [`JsonValue`].
///
/// The parser accepts only the subset of JSON that the [`ToJson`] impls in
/// this module emit. In particular, floating-point numbers, booleans,
/// trailing commas, leading-zero integers, and unquoted keys are rejected —
/// see the module-level documentation for the format definition.
///
/// # Resource limits
///
/// The parser enforces [`MAX_INPUT_BYTES`], [`MAX_DEPTH`], [`MAX_ARRAY_LEN`],
/// [`MAX_OBJECT_FIELDS`], and [`MAX_STRING_CHARS`]; inputs that exceed any
/// of these bounds are rejected with a descriptive [`JsonError`] rather
/// than allocating without bound. The constants are documented above.
///
/// # Errors
///
/// Returns `Err(JsonError)` if the input violates the supported subset
/// (unexpected tokens, unterminated strings, duplicate object keys, integer
/// overflow, leftover bytes after the top-level value, etc.) or any of the
/// resource limits documented above.
#[must_use = "ignoring a parse result drops every error this function exists to surface"]
pub fn parse_json(input: &str) -> Result<JsonValue, JsonError> {
    if input.len() > MAX_INPUT_BYTES {
        return Err(JsonError::new(
            0,
            format!(
                "input length {} exceeds MAX_INPUT_BYTES ({MAX_INPUT_BYTES})",
                input.len()
            ),
        ));
    }
    let mut parser = Parser::new(input);
    let value = parser.parse_value()?;
    parser.skip_ws();
    if parser.pos < parser.bytes.len() {
        return Err(JsonError::new(
            parser.pos,
            "unexpected trailing content after top-level value".to_string(),
        ));
    }
    Ok(value)
}

struct Parser<'a> {
    bytes: &'a [u8],
    pos: usize,
    /// Current nesting depth of arrays + objects. Increment on entry,
    /// decrement on exit, reject above [`MAX_DEPTH`].
    depth: u16,
}

impl<'a> Parser<'a> {
    fn new(input: &'a str) -> Self {
        Self {
            bytes: input.as_bytes(),
            pos: 0,
            depth: 0,
        }
    }

    fn enter_container(&mut self) -> Result<(), JsonError> {
        if self.depth >= MAX_DEPTH {
            return Err(JsonError::new(
                self.pos,
                format!("nesting depth exceeds MAX_DEPTH ({MAX_DEPTH})"),
            ));
        }
        self.depth += 1;
        Ok(())
    }

    fn leave_container(&mut self) {
        // Decrement is bounds-safe because every `leave_container` is paired
        // with a successful `enter_container` earlier in the call stack.
        self.depth = self.depth.saturating_sub(1);
    }

    fn skip_ws(&mut self) {
        while let Some(&b) = self.bytes.get(self.pos) {
            if matches!(b, b' ' | b'\t' | b'\r' | b'\n') {
                self.pos += 1;
            } else {
                break;
            }
        }
    }

    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.pos).copied()
    }

    fn expect_byte(&mut self, expected: u8) -> Result<(), JsonError> {
        match self.peek() {
            Some(b) if b == expected => {
                self.pos += 1;
                Ok(())
            }
            Some(b) => Err(JsonError::new(
                self.pos,
                format!("expected {:?}, got {:?}", expected as char, b as char),
            )),
            None => Err(JsonError::new(
                self.pos,
                format!("expected {:?}, got end of input", expected as char),
            )),
        }
    }

    fn parse_value(&mut self) -> Result<JsonValue, JsonError> {
        self.skip_ws();
        match self.peek() {
            Some(b'{') => self.parse_object(),
            Some(b'[') => self.parse_array(),
            Some(b'"') => self.parse_string().map(JsonValue::String),
            Some(b'n') => self.parse_null(),
            Some(b't') => self.parse_bool_literal(b"true", true),
            Some(b'f') => self.parse_bool_literal(b"false", false),
            Some(b'-' | b'0'..=b'9') => self.parse_integer(),
            Some(b) => Err(JsonError::new(
                self.pos,
                format!("unexpected byte {:?} at value start", b as char),
            )),
            None => Err(JsonError::new(
                self.pos,
                "unexpected end of input at value start".to_string(),
            )),
        }
    }

    fn parse_null(&mut self) -> Result<JsonValue, JsonError> {
        let start = self.pos;
        if self.bytes.get(start..start + 4) == Some(b"null") {
            self.pos += 4;
            Ok(JsonValue::Null)
        } else {
            Err(JsonError::new(start, "expected `null`".to_string()))
        }
    }

    fn parse_bool_literal(&mut self, literal: &[u8], value: bool) -> Result<JsonValue, JsonError> {
        let start = self.pos;
        if self.bytes.get(start..start + literal.len()) == Some(literal) {
            self.pos += literal.len();
            Ok(JsonValue::Bool(value))
        } else {
            Err(JsonError::new(
                start,
                format!(
                    "expected `{}`",
                    std::str::from_utf8(literal).unwrap_or("boolean")
                ),
            ))
        }
    }

    fn parse_integer(&mut self) -> Result<JsonValue, JsonError> {
        let start = self.pos;
        let negative = self.peek() == Some(b'-');
        if negative {
            self.pos += 1;
        }
        let digit_start = self.pos;
        while let Some(b) = self.peek() {
            if b.is_ascii_digit() {
                self.pos += 1;
            } else {
                break;
            }
        }
        if self.pos == digit_start {
            return Err(JsonError::new(start, "expected digit".to_string()));
        }
        // RFC 8259 §6 forbids leading zeros (and `-0` is not produced by
        // the serializer). Rejecting them here keeps the deserializer
        // round-trip-only and prevents drift between hand-written
        // snapshots and the serializer's output.
        if self.bytes[digit_start] == b'0' && self.pos - digit_start > 1 {
            return Err(JsonError::new(
                digit_start,
                "leading zeros are not permitted".to_string(),
            ));
        }
        if negative && self.bytes[digit_start] == b'0' && self.pos - digit_start == 1 {
            return Err(JsonError::new(
                start,
                "negative zero is not permitted".to_string(),
            ));
        }
        if matches!(self.peek(), Some(b'.' | b'e' | b'E')) {
            return Err(JsonError::new(
                self.pos,
                "non-integer numbers are not supported".to_string(),
            ));
        }
        // Safe: digit_start..pos is all ASCII bytes the loop accepted, and
        // the optional leading `-` is also ASCII.
        let text = core::str::from_utf8(&self.bytes[start..self.pos])
            .expect("integer slice is ASCII by construction");
        text.parse::<i64>()
            .map(JsonValue::Integer)
            .map_err(|e| JsonError::new(start, format!("integer parse: {e}")))
    }

    fn parse_string(&mut self) -> Result<String, JsonError> {
        self.expect_byte(b'"')?;
        let mut out = String::new();
        let mut chars_decoded: usize = 0;
        loop {
            if chars_decoded > MAX_STRING_CHARS {
                return Err(JsonError::new(
                    self.pos,
                    format!("decoded string exceeds MAX_STRING_CHARS ({MAX_STRING_CHARS})"),
                ));
            }
            match self.peek() {
                Some(b'"') => {
                    self.pos += 1;
                    return Ok(out);
                }
                Some(b'\\') => {
                    self.pos += 1;
                    let escape = self.peek().ok_or_else(|| {
                        JsonError::new(self.pos, "unterminated escape".to_string())
                    })?;
                    self.pos += 1;
                    match escape {
                        b'"' | b'\\' | b'/' | b'n' | b'r' | b't' | b'b' | b'f' => {
                            let ch = match escape {
                                b'"' => '"',
                                b'\\' => '\\',
                                b'/' => '/',
                                b'n' => '\n',
                                b'r' => '\r',
                                b't' => '\t',
                                b'b' => '\u{08}',
                                b'f' => '\u{0c}',
                                // SAFETY: all arms covered by the outer match guard
                                _ => unreachable!(),
                            };
                            out.push(ch);
                            chars_decoded += 1;
                        }
                        b'u' => {
                            let hex_start = self.pos;
                            let hex =
                                self.bytes.get(hex_start..hex_start + 4).ok_or_else(|| {
                                    JsonError::new(hex_start, "incomplete \\u escape".to_string())
                                })?;
                            let hex_str = core::str::from_utf8(hex).map_err(|_| {
                                JsonError::new(hex_start, "non-ASCII in \\u escape".to_string())
                            })?;
                            let code = u32::from_str_radix(hex_str, 16).map_err(|_| {
                                JsonError::new(hex_start, "invalid \\u hex digits".to_string())
                            })?;
                            // The serializer only emits `\uXXXX` for C0
                            // controls (U+0000..U+001F), which are all
                            // single-unit BMP scalars. UTF-16 surrogate
                            // pairs (`U+D800..=U+DFFF`) and any out-of-
                            // range code unit are rejected here so a
                            // hand-written snapshot cannot synthesise an
                            // input the serializer would never emit.
                            if (0xD800..=0xDFFF).contains(&code) {
                                return Err(JsonError::new(
                                    hex_start,
                                    "surrogate-pair \\u escapes are not supported".to_string(),
                                ));
                            }
                            let ch = char::from_u32(code).ok_or_else(|| {
                                JsonError::new(
                                    hex_start,
                                    "\\u escape is not a valid scalar".to_string(),
                                )
                            })?;
                            out.push(ch);
                            self.pos += 4;
                            chars_decoded += 1;
                        }
                        other => {
                            return Err(JsonError::new(
                                self.pos - 1,
                                format!("unknown escape \\{}", other as char),
                            ));
                        }
                    }
                }
                Some(b) if b < 0x20 => {
                    return Err(JsonError::new(
                        self.pos,
                        format!("unescaped control byte 0x{b:02x} in string"),
                    ));
                }
                Some(b) if b < 0x80 => {
                    // ASCII non-control byte: copy directly.
                    out.push(b as char);
                    self.pos += 1;
                    chars_decoded += 1;
                }
                Some(b) => {
                    // Multi-byte UTF-8 scalar. The leading byte determines
                    // the width (2/3/4); the input is a `&str`, so the
                    // remaining bytes are guaranteed to form a valid
                    // continuation, but we validate the bounded slice to
                    // avoid an unsafe `from_utf8_unchecked` and to keep
                    // the work O(1) per char (the previous implementation
                    // re-validated the entire remainder, which was O(N²)
                    // on long non-ASCII strings).
                    let width = utf8_lead_width(b).ok_or_else(|| {
                        JsonError::new(self.pos, "invalid UTF-8 lead byte in string".to_string())
                    })?;
                    let chunk = self.bytes.get(self.pos..self.pos + width).ok_or_else(|| {
                        JsonError::new(self.pos, "truncated UTF-8 sequence".to_string())
                    })?;
                    let s = core::str::from_utf8(chunk).map_err(|_| {
                        JsonError::new(self.pos, "invalid UTF-8 in string".to_string())
                    })?;
                    let ch = s.chars().next().expect("string is non-empty");
                    out.push(ch);
                    self.pos += width;
                    chars_decoded += 1;
                }
                None => {
                    return Err(JsonError::new(self.pos, "unterminated string".to_string()));
                }
            }
        }
    }

    fn parse_array(&mut self) -> Result<JsonValue, JsonError> {
        self.expect_byte(b'[')?;
        self.enter_container()?;
        self.skip_ws();
        let mut items = Vec::new();
        if self.peek() == Some(b']') {
            self.pos += 1;
            self.leave_container();
            return Ok(JsonValue::Array(items));
        }
        loop {
            if items.len() >= MAX_ARRAY_LEN {
                return Err(JsonError::new(
                    self.pos,
                    format!("array length exceeds MAX_ARRAY_LEN ({MAX_ARRAY_LEN})"),
                ));
            }
            let value = self.parse_value()?;
            items.push(value);
            self.skip_ws();
            match self.peek() {
                Some(b',') => {
                    self.pos += 1;
                    self.skip_ws();
                }
                Some(b']') => {
                    self.pos += 1;
                    self.leave_container();
                    return Ok(JsonValue::Array(items));
                }
                Some(b) => {
                    return Err(JsonError::new(
                        self.pos,
                        format!("expected `,` or `]`, got {:?}", b as char),
                    ));
                }
                None => {
                    return Err(JsonError::new(self.pos, "unterminated array".to_string()));
                }
            }
        }
    }

    fn parse_object(&mut self) -> Result<JsonValue, JsonError> {
        use std::collections::BTreeSet;
        self.expect_byte(b'{')?;
        self.enter_container()?;
        self.skip_ws();
        let mut fields: Vec<(String, JsonValue)> = Vec::new();
        let mut seen: BTreeSet<String> = BTreeSet::new();
        if self.peek() == Some(b'}') {
            self.pos += 1;
            self.leave_container();
            return Ok(JsonValue::Object(fields));
        }
        loop {
            if fields.len() >= MAX_OBJECT_FIELDS {
                return Err(JsonError::new(
                    self.pos,
                    format!("object has more than MAX_OBJECT_FIELDS ({MAX_OBJECT_FIELDS}) fields"),
                ));
            }
            self.skip_ws();
            let key_pos = self.pos;
            let key = self.parse_string()?;
            // O(log n) duplicate-key check; the previous linear scan was
            // quadratic on adversarial wide objects.
            if seen.contains(&key) {
                return Err(JsonError::new(
                    key_pos,
                    format!("duplicate object key {}", truncate_for_message(&key)),
                ));
            }
            self.skip_ws();
            self.expect_byte(b':')?;
            let value = self.parse_value()?;
            seen.insert(key.clone());
            fields.push((key, value));
            self.skip_ws();
            match self.peek() {
                Some(b',') => {
                    self.pos += 1;
                }
                Some(b'}') => {
                    self.pos += 1;
                    self.leave_container();
                    return Ok(JsonValue::Object(fields));
                }
                Some(b) => {
                    return Err(JsonError::new(
                        self.pos,
                        format!("expected `,` or `}}`, got {:?}", b as char),
                    ));
                }
                None => {
                    return Err(JsonError::new(self.pos, "unterminated object".to_string()));
                }
            }
        }
    }
}

/// AST nodes that can be reconstructed from the JSON debug format produced
/// by [`ToJson`].
///
/// The trait is round-trip-only: `T::from_json(v.to_json_string())` returns
/// a value structurally equal to `v`. It is **not** a tolerant parser for
/// hand-written JSON; field order is the only ordering accepted by
/// [`parse_json`], but every required field is read by name, so reordering
/// only matters for the byte-stable property of the serialiser, not for
/// `from_json` itself.
pub trait FromJson: Sized {
    /// Reads a JSON string produced by [`ToJson::to_json_string`] and
    /// returns the corresponding AST node.
    ///
    /// # Errors
    ///
    /// Returns `Err` when the input is malformed JSON (per [`parse_json`]),
    /// when a required field is missing, or when a field carries a value
    /// outside the expected shape (e.g. a `numerator` of `0` for
    /// [`TimeSignature`]).
    #[must_use = "ignoring a parse result drops every error this method exists to surface"]
    fn from_json_str(input: &str) -> Result<Self, JsonError> {
        let value = parse_json(input)?;
        Self::from_json_value(&value)
    }

    /// Same as [`FromJson::from_json_str`] but starts from an already-parsed
    /// [`JsonValue`]. Useful when an extractor walks a parent object and
    /// needs to reconstruct one nested AST node at a time.
    ///
    /// # Errors
    ///
    /// See [`FromJson::from_json_str`].
    #[must_use = "ignoring a parse result drops every error this method exists to surface"]
    fn from_json_value(value: &JsonValue) -> Result<Self, JsonError>;
}

fn extract_char(value: &JsonValue) -> Result<char, JsonError> {
    let s = value.as_str()?;
    let mut iter = s.chars();
    let ch = iter
        .next()
        .ok_or_else(|| JsonError::new(0, "expected single-character string".to_string()))?;
    if iter.next().is_some() {
        return Err(JsonError::new(
            0,
            "expected single-character string".to_string(),
        ));
    }
    Ok(ch)
}

fn extract_u8(value: &JsonValue) -> Result<u8, JsonError> {
    let n = value.as_int()?;
    u8::try_from(n).map_err(|_| JsonError::new(0, format!("integer {n} out of u8 range")))
}

fn extract_opt_u16(value: &JsonValue) -> Result<Option<u16>, JsonError> {
    match value.as_opt_int()? {
        None => Ok(None),
        Some(n) => u16::try_from(n)
            .map(Some)
            .map_err(|_| JsonError::new(0, format!("integer {n} out of u16 range"))),
    }
}

fn extract_i8(value: &JsonValue) -> Result<i8, JsonError> {
    let n = value.as_int()?;
    i8::try_from(n).map_err(|_| JsonError::new(0, format!("integer {n} out of i8 range")))
}

fn extract_root_note(value: &JsonValue) -> Result<char, JsonError> {
    // `ChordRoot::note` is documented (and asserted by the parser in
    // #2054) as an uppercase ASCII letter `A`..=`G`. Enforce it here so
    // a hand-written snapshot cannot inject nonsense roots that round-
    // trip silently and then surface as crashes in #2057 (renderer) or
    // #2052 (URL serializer).
    let ch = extract_char(value)?;
    if !matches!(ch, 'A'..='G') {
        return Err(JsonError::new(
            0,
            format!("chord root note must be one of A..=G, got {ch:?}"),
        ));
    }
    Ok(ch)
}

impl FromJson for IrealSong {
    fn from_json_value(value: &JsonValue) -> Result<Self, JsonError> {
        let title = value.get("title")?.as_str()?.to_string();
        let composer = value.get("composer")?.as_opt_str()?.map(str::to_string);
        let style = value.get("style")?.as_opt_str()?.map(str::to_string);
        let key_signature = KeySignature::from_json_value(value.get("key_signature")?)?;
        let time_signature = TimeSignature::from_json_value(value.get("time_signature")?)?;
        let tempo = extract_opt_u16(value.get("tempo")?)?;
        if matches!(tempo, Some(0)) {
            return Err(JsonError::new(0, "tempo must be non-zero".to_string()));
        }
        let transpose = extract_i8(value.get("transpose")?)?;
        if !(-11..=11).contains(&transpose) {
            // Mirrors the `chordsketch-chordpro` clamp and the doc-comment
            // contract on `IrealSong::transpose`. Rejecting here keeps the
            // round-trip-only deserializer symmetric with the serializer
            // (which never emits a value outside this range when called on
            // a well-constructed AST).
            return Err(JsonError::new(
                0,
                format!("transpose {transpose} out of range [-11, 11]"),
            ));
        }
        let sections = value
            .get("sections")?
            .as_array()?
            .iter()
            .map(Section::from_json_value)
            .collect::<Result<_, _>>()?;
        Ok(Self {
            title,
            composer,
            style,
            key_signature,
            time_signature,
            tempo,
            transpose,
            sections,
        })
    }
}

impl FromJson for Section {
    fn from_json_value(value: &JsonValue) -> Result<Self, JsonError> {
        let label = SectionLabel::from_json_value(value.get("label")?)?;
        let bars = value
            .get("bars")?
            .as_array()?
            .iter()
            .map(Bar::from_json_value)
            .collect::<Result<_, _>>()?;
        Ok(Self { label, bars })
    }
}

impl FromJson for SectionLabel {
    fn from_json_value(value: &JsonValue) -> Result<Self, JsonError> {
        let kind = value.get("kind")?.as_str()?;
        match kind {
            "letter" => {
                let ch = extract_char(value.get("value")?)?;
                Ok(Self::Letter(ch))
            }
            "verse" => Ok(Self::Verse),
            "chorus" => Ok(Self::Chorus),
            "intro" => Ok(Self::Intro),
            "outro" => Ok(Self::Outro),
            "bridge" => Ok(Self::Bridge),
            "custom" => {
                let s = value.get("value")?.as_str()?.to_string();
                Ok(Self::Custom(s))
            }
            other => Err(JsonError::new(
                0,
                format!("unknown section label kind {}", truncate_for_message(other)),
            )),
        }
    }
}

impl FromJson for Bar {
    fn from_json_value(value: &JsonValue) -> Result<Self, JsonError> {
        let start = BarLine::from_json_value(value.get("start")?)?;
        let end = BarLine::from_json_value(value.get("end")?)?;
        let chords = value
            .get("chords")?
            .as_array()?
            .iter()
            .map(BarChord::from_json_value)
            .collect::<Result<_, _>>()?;
        let ending = match value.get("ending")? {
            JsonValue::Null => None,
            other => {
                let n = extract_u8(other)?;
                Some(Ending::new(n).ok_or_else(|| {
                    JsonError::new(0, "ending number must be non-zero".to_string())
                })?)
            }
        };
        let symbol = match value.get("symbol")? {
            JsonValue::Null => None,
            other => Some(MusicalSymbol::from_json_value(other)?),
        };
        let repeat_previous = match value.get_optional("repeat_previous") {
            Some(JsonValue::Bool(b)) => *b,
            _ => false,
        };
        let no_chord = match value.get_optional("no_chord") {
            Some(JsonValue::Bool(b)) => *b,
            _ => false,
        };
        let text_comment = match value.get_optional("text_comment") {
            Some(JsonValue::String(s)) => Some(s.clone()),
            _ => None,
        };
        Ok(Self {
            start,
            end,
            chords,
            ending,
            symbol,
            repeat_previous,
            no_chord,
            text_comment,
        })
    }
}

impl FromJson for BarLine {
    fn from_json_value(value: &JsonValue) -> Result<Self, JsonError> {
        match value.as_str()? {
            "single" => Ok(Self::Single),
            "double" => Ok(Self::Double),
            "final" => Ok(Self::Final),
            "open_repeat" => Ok(Self::OpenRepeat),
            "close_repeat" => Ok(Self::CloseRepeat),
            other => Err(JsonError::new(
                0,
                format!("unknown bar line {}", truncate_for_message(other)),
            )),
        }
    }
}

impl FromJson for BarChord {
    fn from_json_value(value: &JsonValue) -> Result<Self, JsonError> {
        let chord = Chord::from_json_value(value.get("chord")?)?;
        let position = BeatPosition::from_json_value(value.get("position")?)?;
        Ok(Self { chord, position })
    }
}

impl FromJson for BeatPosition {
    fn from_json_value(value: &JsonValue) -> Result<Self, JsonError> {
        let beat = extract_u8(value.get("beat")?)?;
        let beat = core::num::NonZeroU8::new(beat)
            .ok_or_else(|| JsonError::new(0, "beat must be non-zero".to_string()))?;
        let subdivision = extract_u8(value.get("subdivision")?)?;
        Ok(Self { beat, subdivision })
    }
}

impl FromJson for Chord {
    fn from_json_value(value: &JsonValue) -> Result<Self, JsonError> {
        let root = ChordRoot::from_json_value(value.get("root")?)?;
        let quality = ChordQuality::from_json_value(value.get("quality")?)?;
        let bass = match value.get("bass")? {
            JsonValue::Null => None,
            other => Some(ChordRoot::from_json_value(other)?),
        };
        let alternate = match value.get_optional("alternate") {
            Some(JsonValue::Null) | None => None,
            Some(other) => Some(Box::new(Chord::from_json_value(other)?)),
        };
        Ok(Self {
            root,
            quality,
            bass,
            alternate,
        })
    }
}

impl FromJson for ChordRoot {
    fn from_json_value(value: &JsonValue) -> Result<Self, JsonError> {
        let note = extract_root_note(value.get("note")?)?;
        let accidental = Accidental::from_json_value(value.get("accidental")?)?;
        Ok(Self { note, accidental })
    }
}

impl FromJson for Accidental {
    fn from_json_value(value: &JsonValue) -> Result<Self, JsonError> {
        match value.as_str()? {
            "natural" => Ok(Self::Natural),
            "flat" => Ok(Self::Flat),
            "sharp" => Ok(Self::Sharp),
            other => Err(JsonError::new(
                0,
                format!("unknown accidental {}", truncate_for_message(other)),
            )),
        }
    }
}

impl FromJson for ChordQuality {
    fn from_json_value(value: &JsonValue) -> Result<Self, JsonError> {
        let kind = value.get("kind")?.as_str()?;
        match kind {
            "major" => Ok(Self::Major),
            "minor" => Ok(Self::Minor),
            "diminished" => Ok(Self::Diminished),
            "augmented" => Ok(Self::Augmented),
            "major7" => Ok(Self::Major7),
            "minor7" => Ok(Self::Minor7),
            "dominant7" => Ok(Self::Dominant7),
            "half_diminished" => Ok(Self::HalfDiminished),
            "diminished7" => Ok(Self::Diminished7),
            "suspended2" => Ok(Self::Suspended2),
            "suspended4" => Ok(Self::Suspended4),
            "custom" => {
                let s = value.get("value")?.as_str()?.to_string();
                Ok(Self::Custom(s))
            }
            other => Err(JsonError::new(
                0,
                format!("unknown chord quality kind {}", truncate_for_message(other)),
            )),
        }
    }
}

impl FromJson for KeySignature {
    fn from_json_value(value: &JsonValue) -> Result<Self, JsonError> {
        let root = ChordRoot::from_json_value(value.get("root")?)?;
        let mode = KeyMode::from_json_value(value.get("mode")?)?;
        Ok(Self { root, mode })
    }
}

impl FromJson for KeyMode {
    fn from_json_value(value: &JsonValue) -> Result<Self, JsonError> {
        match value.as_str()? {
            "major" => Ok(Self::Major),
            "minor" => Ok(Self::Minor),
            other => Err(JsonError::new(
                0,
                format!("unknown key mode {}", truncate_for_message(other)),
            )),
        }
    }
}

impl FromJson for TimeSignature {
    fn from_json_value(value: &JsonValue) -> Result<Self, JsonError> {
        let numerator = extract_u8(value.get("numerator")?)?;
        let denominator = extract_u8(value.get("denominator")?)?;
        Self::new(numerator, denominator).ok_or_else(|| {
            JsonError::new(
                0,
                format!("invalid time signature {numerator}/{denominator}"),
            )
        })
    }
}

impl FromJson for MusicalSymbol {
    fn from_json_value(value: &JsonValue) -> Result<Self, JsonError> {
        match value.as_str()? {
            "segno" => Ok(Self::Segno),
            "coda" => Ok(Self::Coda),
            "da_capo" => Ok(Self::DaCapo),
            "dal_segno" => Ok(Self::DalSegno),
            "fine" => Ok(Self::Fine),
            other => Err(JsonError::new(
                0,
                format!("unknown musical symbol {}", truncate_for_message(other)),
            )),
        }
    }
}
