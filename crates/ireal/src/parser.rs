//! `irealb://` URL parser.
//!
//! Parses an iReal Pro export URL into one or more [`IrealSong`]
//! values. Handles both the `irealb://` (single-song) and
//! `irealbook://` (multi-song collection) prefixes, percent
//! decoding, the iReal Pro obfusc50 unscramble, and the chord-
//! chart syntax described in `crates/ireal/FORMAT.md`.
//!
//! # Format reference
//!
//! iReal Pro publishes the [Custom Chord Chart Protocol][spec]
//! (the chord-chart token grammar — `*X` rehearsal marks, barlines,
//! repeats, `n` no-chord, `Y+` vertical spacers, etc.) and a
//! companion [developer docs page][devdocs] (overview of the
//! `irealb://` and `irealbook://` URL prefixes used to embed
//! charts). The chord-chart grammar this parser accepts is a
//! **subset of that spec extended with internal tokens** observed
//! in real exports (`Kcl`, `XyQ`, `LZ|`) — see
//! `crates/ireal/FORMAT.md` for the exact token table and the
//! deltas from the spec.
//!
//! What the spec does **not** cover, and what therefore remains
//! reverse-engineered from external references, are: the
//! `irealb://` body's `MUSIC_PREFIX` sentinel + `obfusc50`
//! unscramble; the legacy 6-field `irealbook://` layout this
//! parser accepts with a packed-digit time signature in slot 5
//! (the spec's own 6-field example has the literal `n` placeholder
//! in slot 5 and the time signature embedded inside the chord
//! stream as a `T..` token); and the `===`-separated multi-song
//! envelope. For those halves the public references are the
//! open-source [`pianosnake/ireal-reader`][pianosnake] JavaScript
//! parser and the [`ironss/accompaniser`][accompaniser]
//! de-obfuscation routine it cites. The Rust port here implements
//! the same algorithms against the same shape of token grammar;
//! round-trip golden tests in `tests/parser.rs` verify the result
//! against known-good fixtures.
//!
//! [spec]: https://www.irealpro.com/ireal-pro-custom-chord-chart-protocol
//! [devdocs]: https://www.irealpro.com/developer-docs
//! [pianosnake]: https://github.com/pianosnake/ireal-reader
//! [accompaniser]: https://github.com/ironss/accompaniser
//!
//! # Scope
//!
//! - Single-song `irealb://` URLs: full parse to [`IrealSong`].
//! - Multi-song `irealbook://` URLs: full parse via
//!   [`parse_collection`].
//! - Repeats / endings / segno-coda symbols: preserved
//!   *structurally* on the AST (`BarLine::OpenRepeat`,
//!   `Bar::ending`, `Bar::symbol`). The parser does **not**
//!   expand a repeat into duplicated bars — that is a
//!   render-time concern, and our AST is the source-of-truth.
//! - `D.C.` / `D.S.` macros: recorded as `MusicalSymbol`s on the
//!   bar that carries the directive; the parser does not unfold
//!   them.

use crate::ast::{
    Accidental, Bar, BarChord, BarChordKind, BarLine, BeatGrouping, BeatPosition, Chord,
    ChordQuality, ChordRoot, ChordSize, Ending, IrealSong, JumpTarget, KeyMode, KeySignature,
    MusicalSymbol, Section, SectionLabel, StaffText, TimeSignature,
};
use std::fmt;

/// Bytes-after-`irealb://` magic that marks the start of the
/// chord-chart body. Every iReal Pro export prefixes the (still
/// scrambled) chord chart with this constant; the parser strips
/// it before invoking the obfusc50 unscramble. The serializer
/// in `crate::serialize` consumes this constant when building
/// the inverse music body, so it is `pub(crate)` rather than
/// fully private.
pub(crate) const MUSIC_PREFIX: &str = "1r34LbKcu7";

/// Hard ceiling on the raw URL length the parser will accept.
/// iReal Pro exports rarely exceed a few hundred KB even for large
/// collections; the cap prevents a caller from supplying an
/// arbitrarily large string and forcing proportionally large
/// allocations in the per-song body buffers.
pub const MAX_INPUT_BYTES: usize = 4 * 1024 * 1024;

/// Errors produced by [`parse`] and [`parse_collection`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParseError {
    /// The input did not begin with the expected `irealb://`
    /// (or `irealbook://`) prefix.
    MissingPrefix,
    /// The input exceeded [`MAX_INPUT_BYTES`].
    InputTooLarge(usize),
    /// A `%XX` percent-escape was malformed (truncated or non-hex).
    InvalidPercentEscape,
    /// The body did not split into a recognisable
    /// `Title=Composer=...=Music=...` field shape.
    MalformedBody(String),
    /// The chord-chart body did not start with the expected
    /// `1r34LbKcu7` music prefix.
    MissingMusicPrefix,
    /// The collection did not contain a single song. iReal export
    /// URLs always carry at least one chart; a zero-song body is
    /// a structural defect.
    NoSongs,
    /// A chord token did not match the documented grammar.
    InvalidChord(String),
    /// A field expected to be numeric (BPM, transpose, time
    /// signature) was not. Carries the offending raw value.
    InvalidNumericField(String),
}

impl fmt::Display for ParseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MissingPrefix => write!(f, "input does not start with irealb:// or irealbook://"),
            Self::InputTooLarge(n) => write!(
                f,
                "input length {n} exceeds MAX_INPUT_BYTES ({MAX_INPUT_BYTES})"
            ),
            Self::InvalidPercentEscape => write!(f, "malformed %XX escape"),
            Self::MalformedBody(reason) => write!(f, "malformed body: {reason}"),
            Self::MissingMusicPrefix => {
                write!(f, "music body did not start with the expected prefix")
            }
            Self::NoSongs => write!(f, "no songs found in collection"),
            Self::InvalidChord(c) => write!(f, "invalid chord token: {c:?}"),
            Self::InvalidNumericField(s) => write!(f, "invalid numeric field: {s:?}"),
        }
    }
}

impl std::error::Error for ParseError {}

/// Parses a single-song `irealb://` URL into [`IrealSong`].
///
/// For multi-song `irealbook://` URLs (which carry several charts
/// in one file), use [`parse_collection`] — this function returns
/// only the first song in such a URL.
///
/// # Errors
///
/// See [`ParseError`].
pub fn parse(url: &str) -> Result<IrealSong, ParseError> {
    let (songs, _name) = parse_collection(url)?;
    songs.into_iter().next().ok_or(ParseError::NoSongs)
}

/// Parses an `irealb://` or `irealbook://` URL.
///
/// Returns the parsed songs plus the collection name (the trailing
/// segment after the final `===`) if one is present. Single-song
/// `irealb://` URLs return a single-element `Vec` and `None`.
///
/// # Errors
///
/// See [`ParseError`].
pub fn parse_collection(url: &str) -> Result<(Vec<IrealSong>, Option<String>), ParseError> {
    if url.len() > MAX_INPUT_BYTES {
        return Err(ParseError::InputTooLarge(url.len()));
    }
    let body_encoded = strip_prefix(url)?;
    // percent_decode can only shrink the output (every `%XX` triplet
    // maps to a single byte), so `body.len() <= body_encoded.len() <=
    // url.len()`. The length check above already enforces the cap.
    let body = percent_decode(body_encoded)?;

    // Songs are separated by `===`. iReal also uses the trailing
    // segment after the final `===` as the playlist name when the
    // URL is `irealbook://`; mirror that convention.
    let mut parts: Vec<&str> = body.split("===").collect();

    // pianosnake treats the last `===` segment as the playlist
    // name only when there is more than one part. A single-song
    // `irealb://` URL has no `===` separator, so `parts` has just
    // one element and there is no name.
    // Use `nonempty` so a trailing `===` with no name (empty segment)
    // returns `None` rather than `Some("")`.
    let name = if parts.len() > 1 {
        parts.pop().and_then(nonempty)
    } else {
        None
    };

    let mut songs = Vec::new();
    for part in parts {
        let trimmed = part.trim();
        if trimmed.is_empty() {
            continue;
        }
        songs.push(make_song(trimmed)?);
    }
    if songs.is_empty() {
        return Err(ParseError::NoSongs);
    }
    Ok((songs, name))
}

/// Strips the `irealb://` or `irealbook://` prefix from `url` and
/// returns the still-percent-encoded body.
fn strip_prefix(url: &str) -> Result<&str, ParseError> {
    url.strip_prefix("irealb://")
        .or_else(|| url.strip_prefix("irealbook://"))
        .ok_or(ParseError::MissingPrefix)
}

/// Decodes a percent-encoded ASCII / UTF-8 string in place.
///
/// The iReal app encodes the body with the standard `%XX`
/// scheme. Invalid escapes are an error; passing through with the
/// raw `%` byte would silently round-trip-fail downstream.
fn percent_decode(input: &str) -> Result<String, ParseError> {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if i + 2 >= bytes.len() {
                return Err(ParseError::InvalidPercentEscape);
            }
            let hi = hex_digit(bytes[i + 1])?;
            let lo = hex_digit(bytes[i + 2])?;
            out.push((hi << 4) | lo);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|_| ParseError::InvalidPercentEscape)
}

fn hex_digit(b: u8) -> Result<u8, ParseError> {
    match b {
        b'0'..=b'9' => Ok(b - b'0'),
        b'a'..=b'f' => Ok(b - b'a' + 10),
        b'A'..=b'F' => Ok(b - b'A' + 10),
        _ => Err(ParseError::InvalidPercentEscape),
    }
}

/// Splits a decoded song body on `=` runs and constructs the
/// corresponding [`IrealSong`]. Mirrors `makeSong()` in
/// pianosnake/ireal-reader: the `=`-delimited shape carries
/// `Title=Composer=Style=Key=[Transpose=]Music=[CompStyle=]BPM=Repeats`,
/// and the parser dispatches by part count + whether the music
/// part starts with the [`MUSIC_PREFIX`] sentinel.
fn make_song(body: &str) -> Result<IrealSong, ParseError> {
    // pianosnake splits on `=+` (one or more equals) and removes
    // empties; mirror that exactly so we get the same field
    // alignment for the same input.
    let parts: Vec<&str> = body.split('=').filter(|s| !s.is_empty()).collect();

    // Two related URL shapes share `make_song`:
    //
    // 1. `irealb://` (iReal Pro export) — 7..=9 parts, music is
    //    `MUSIC_PREFIX` + obfusc50-scrambled chord stream.
    // 2. `irealbook://` (iRealBook export) — 6 parts, music is
    //    plain text with no prefix and no scrambling, and the time
    //    signature lives in field 4 (packed digits like `44` = 4/4
    //    rather than embedded `T44` in the chord stream).
    //
    // Detect (2) by part count + the absence of a `MUSIC_PREFIX`
    // anywhere in `parts`; everything else routes through the iReal
    // Pro arms.
    let is_irealbook_six_field =
        parts.len() == 6 && !parts.iter().any(|p| p.starts_with(MUSIC_PREFIX));
    if is_irealbook_six_field {
        return make_song_irealbook(&parts);
    }

    let (title, composer, style, key, transpose_raw, music_raw, _comp_style, bpm_raw, _repeats) =
        match parts.len() {
            7 => {
                let p = &parts;
                (
                    p[0],
                    p[1],
                    p[2],
                    p[3],
                    None,
                    p[4],
                    None,
                    Some(p[5]),
                    Some(p[6]),
                )
            }
            8 if parts[4].starts_with(MUSIC_PREFIX) => {
                let p = &parts;
                (
                    p[0],
                    p[1],
                    p[2],
                    p[3],
                    None,
                    p[4],
                    Some(p[5]),
                    Some(p[6]),
                    Some(p[7]),
                )
            }
            8 if parts[5].starts_with(MUSIC_PREFIX) => {
                let p = &parts;
                (
                    p[0],
                    p[1],
                    p[2],
                    p[3],
                    Some(p[4]),
                    p[5],
                    None,
                    Some(p[6]),
                    Some(p[7]),
                )
            }
            9 => {
                let p = &parts;
                (
                    p[0],
                    p[1],
                    p[2],
                    p[3],
                    Some(p[4]),
                    p[5],
                    Some(p[6]),
                    Some(p[7]),
                    Some(p[8]),
                )
            }
            n => {
                return Err(ParseError::MalformedBody(format!(
                    "expected 6 parts (irealbook) or 7..=9 parts (irealb), got {n}"
                )));
            }
        };

    let music_obfuscated = music_raw
        .strip_prefix(MUSIC_PREFIX)
        .ok_or(ParseError::MissingMusicPrefix)?;
    let music = unscramble(music_obfuscated);

    let chord_chart = parse_chord_chart(&music)?;
    let key_signature = parse_key(key);
    let tempo = bpm_raw
        .map(|s| {
            s.parse::<u16>()
                .map_err(|_| ParseError::InvalidNumericField(s.to_owned()))
        })
        .transpose()?
        .filter(|&n| n != 0);
    let transpose = transpose_raw
        .map(|s| {
            s.parse::<i8>()
                .map_err(|_| ParseError::InvalidNumericField(s.to_owned()))
                .map(|n| n.clamp(-11, 11))
        })
        .transpose()?
        .unwrap_or(0);

    Ok(IrealSong {
        title: title.trim().to_owned(),
        composer: nonempty(composer),
        style: nonempty(style),
        key_signature,
        time_signature: chord_chart.time_signature,
        tempo,
        transpose,
        sections: chord_chart.sections,
    })
}

/// `irealbook://` six-field song builder.
///
/// Layout: `Title=Composer=Style=Key=TimeSig=Music`. Music is plain
/// text (no `MUSIC_PREFIX`, no obfusc50). The time signature is a
/// packed-digit field (`44` → 4/4, `34` → 3/4, `68` → 6/8, `128` →
/// 12/8) sitting outside the chord stream — re-inject it as the
/// AST's `time_signature` field instead of as a `T..` directive
/// embedded in the music. Tempo and transpose default to none / 0.
fn make_song_irealbook(parts: &[&str]) -> Result<IrealSong, ParseError> {
    debug_assert_eq!(parts.len(), 6);
    let (title, composer, style, key_raw, timesig_raw, music_raw) =
        (parts[0], parts[1], parts[2], parts[3], parts[4], parts[5]);
    let key_signature = parse_key(key_raw);
    // The 7-field `irealb://` path errors on malformed numeric
    // fields (`InvalidNumericField`); the 6-field `irealbook://`
    // path mirrors that strict parse rather than silently falling
    // back to 4/4 — a malformed timesig (`9X`, `0`, empty) is
    // user-supplied data and should surface as an error per
    // `.claude/rules/code-style.md` "Silent Fallback" and
    // `fix-propagation.md` (sister-site parity with the 7-field
    // numeric-field validation).
    let time_signature = parse_time_signature(timesig_raw)
        .map(|(ts, _)| ts)
        .ok_or_else(|| ParseError::InvalidNumericField(timesig_raw.to_owned()))?;
    // Pass the header meter into the music-body parser so consumer
    // directives that depend on the active meter (e.g. the #2449
    // compound-time `<a+b>` grouping) validate against the chart's
    // declared meter, not `TimeSignature::default()`.
    let chord_chart = parse_chord_chart_with_header_ts(music_raw, time_signature)?;
    Ok(IrealSong {
        title: title.trim().to_owned(),
        composer: nonempty(composer),
        style: nonempty(style),
        key_signature,
        // The chord stream may itself contain a `T..` directive
        // that overrides the field-level time signature. Prefer the
        // chord-stream value when it differs from the default,
        // mirroring the iReal Pro app's behaviour where an inline
        // `T..` overrides any header default.
        time_signature: if chord_chart.time_signature != TimeSignature::default() {
            chord_chart.time_signature
        } else {
            time_signature
        },
        tempo: None,
        transpose: 0,
        sections: chord_chart.sections,
    })
}

/// Maps a staff-text comment to its [`MusicalSymbol`] (#2427).
///
/// Accepts the **eleven player-recognised phrases** from
/// <https://www.irealpro.com/ireal-pro-custom-chord-chart-protocol>
/// plus the bare `<D.C.>` / `<D.S.>` legacy export forms — case
/// insensitive, with internal whitespace runs collapsed to a single
/// space. Surrounding whitespace must already have been trimmed by
/// the caller.
///
/// The match is **exact**, not a prefix scan: a comment that
/// almost looks like a macro (e.g. `<D.C. on Cue>`, where the
/// tail `on Cue` doesn't match the `al ...` grammar at all) falls
/// through to `None` and lands in `Bar::staff_texts` instead.
/// This is what gives the AST its "either symbol OR staff_texts,
/// never both" invariant — the parser only stamps a symbol when
/// it can name the spec phrase unambiguously. `End`, `Ending`,
/// and `End.` are accepted as synonyms (real exports use all
/// three); the strict ordinal-suffix check (`1st`/`2nd`/`3rd`/...)
/// is enforced by [`classify_al_target`] to keep the parser
/// aligned with the JSON deserializer's grammar.
pub(crate) fn classify_macro_comment(trimmed: &str) -> Option<MusicalSymbol> {
    let normalised = normalise_macro_text(trimmed);
    // Atomic, single-token bare forms first. The bare D.C. / D.S.
    // arms are after `fine`/`break` so a hypothetical future
    // overlap (none today) can't shadow a literal phrase.
    match normalised.as_str() {
        "fine" => return Some(MusicalSymbol::Fine),
        "break" => return Some(MusicalSymbol::Break),
        "d.c." => return Some(MusicalSymbol::DaCapo(JumpTarget::Unspecified)),
        "d.s." => return Some(MusicalSymbol::DalSegno(JumpTarget::Unspecified)),
        _ => {}
    }
    // `D.C. al ...` / `D.S. al ...` arms share an ending-classifier
    // helper. The helper accepts the spec phrasing `End.` (period)
    // plus the equally common informal spellings `End` and
    // `Ending` real charts use ('D.C. al 3rd Ending' appears in
    // pianosnake's tester corpus). The canonical serialized form
    // remains `End.` so re-emission lands on the spec phrasing.
    if let Some(rest) = normalised.strip_prefix("d.c. ") {
        return classify_al_target(rest).map(MusicalSymbol::DaCapo);
    }
    if let Some(rest) = normalised.strip_prefix("d.s. ") {
        return classify_al_target(rest).map(MusicalSymbol::DalSegno);
    }
    None
}

/// Classifies the `al ...` tail of a D.C./D.S. phrase.
///
/// Accepts:
///
/// | Input tail | `JumpTarget` |
/// |---|---|
/// | `al coda` | `AlCoda` |
/// | `al fine` | `AlFine` |
/// | `al <ordinal> end.` / `al <ordinal> end` / `al <ordinal> ending` | `AlEnding(<n>)` |
///
/// where `<ordinal>` is `1st`/`2nd`/`3rd` for the spec phrases plus
/// `<n>th` for the overflow path. Anything outside this grammar
/// returns `None` so the caller drops the macro and stores the
/// original text in `Bar::staff_texts`.
fn classify_al_target(tail: &str) -> Option<JumpTarget> {
    match tail {
        "al coda" => return Some(JumpTarget::AlCoda),
        "al fine" => return Some(JumpTarget::AlFine),
        _ => {}
    }
    let ending_body = tail.strip_prefix("al ").and_then(|t| {
        t.strip_suffix(" end.")
            .or_else(|| t.strip_suffix(" end"))
            .or_else(|| t.strip_suffix(" ending"))
    })?;
    // `ending_body` is the ordinal with `st`/`nd`/`rd`/`th` suffix
    // (or no suffix, which we reject). Strip the alpha suffix to
    // recover the digit body so `1st`/`2nd`/`3rd`/`4th`/...
    // all parse uniformly.
    let digit_end = ending_body.find(|c: char| !c.is_ascii_digit())?;
    if digit_end == 0 {
        return None;
    }
    let n: u8 = ending_body[..digit_end].parse().ok()?;
    let suffix = &ending_body[digit_end..];
    // Strict ordinal-suffix check: `1st`, `2nd`, `3rd`, `4th`...
    // The parser rejects `1rd`/`2st`/`3nd` so it agrees with
    // [`crate::json::expected_ordinal_suffix`] — sister-site
    // discipline per `.claude/rules/fix-propagation.md`. The teen
    // exception (11th/12th/13th) is preserved.
    let expected = match n % 100 {
        11..=13 => "th",
        _ => match n % 10 {
            1 => "st",
            2 => "nd",
            3 => "rd",
            _ => "th",
        },
    };
    if suffix != expected {
        return None;
    }
    let nz = std::num::NonZeroU8::new(n)?;
    Some(JumpTarget::AlEnding(nz))
}

/// Lowercases and collapses internal whitespace runs to a single
/// space so the macro lookup table can match phrases users typed
/// with the wrong spacing (`"D.C.  al  Coda"`, `"D.C.\tal\tCoda"`)
/// without listing every variant. Callers MUST pre-trim leading /
/// trailing whitespace.
fn normalise_macro_text(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut prev_was_space = false;
    for ch in input.chars() {
        let mapped = ch.to_ascii_lowercase();
        if mapped.is_whitespace() {
            if !prev_was_space && !out.is_empty() {
                out.push(' ');
            }
            prev_was_space = true;
        } else {
            out.push(mapped);
            prev_was_space = false;
        }
    }
    // Trim a trailing space introduced by a run-of-whitespace at the
    // end of the input. The leading case is already prevented by the
    // `out.is_empty()` guard above.
    if out.ends_with(' ') {
        out.pop();
    }
    out
}

/// Detects the spec's compound-time-signature staff-text token
/// (#2449) — a `digit+digit(+digit)*` sequence such as `2+3`,
/// `3+2+2`. Whitespace around the token is rejected; iReal Pro
/// emits the directive as a bare `<a+b>` with no surrounding
/// commentary, so any non-digit char outside the `+` separator is
/// a free-form caption rather than a grouping override.
///
/// Each subgroup must parse as a `NonZeroU8`. The function returns
/// `None` (and `apply_comment` falls through to text-comment
/// behaviour) for any malformed input: empty subgroups (`<+3>`,
/// `<2+>`, `<2++3>`), zero-valued subgroups (`<0+3>`), values
/// outside `1..=u8::MAX`, or non-digit characters.
///
/// Sum-vs-time-signature validation is the caller's job — this
/// helper only parses the lexical shape so the same parsed
/// grouping can be reused for the running-state and the per-bar
/// override.
fn parse_beat_grouping(input: &str) -> Option<BeatGrouping> {
    if input.is_empty() {
        return None;
    }
    let mut parts = Vec::new();
    for piece in input.split('+') {
        // Every `+`-separated piece must be a non-empty integer in
        // `1..=u8::MAX`. The empty-string rejection here is what
        // turns `<2++3>` and `<+3>` into None.
        if piece.is_empty() || !piece.chars().all(|c| c.is_ascii_digit()) {
            return None;
        }
        let n: u8 = piece.parse().ok()?;
        parts.push(core::num::NonZeroU8::new(n)?);
    }
    // A single integer without a `+` is not a grouping — the
    // input was just a number, which is not a compound-time
    // directive. Spec requires at least two subgroups.
    if parts.len() < 2 {
        return None;
    }
    BeatGrouping::new(parts)
}

/// Classifies a non-macro, non-grouping `<...>` body into a
/// [`StaffText`] variant per the iReal Pro open-protocol "Staff
/// Text" section (#2426).
///
/// Three shapes are recognised, in priority order:
///
/// 1. **Repeat-count override** — body of the form `Nx` (one or more
///    ASCII digits followed by a single lowercase `x`), where `N`
///    is a non-zero `u16`. Produces [`StaffText::RepeatCount`].
///    Examples: `<8x>`, `<3x>`, `<128x>`. A body like `<x>` (no
///    digits), `<8X>` (uppercase), `<8 x>` (whitespace), `<0x>`
///    (the spec gives `<0x>` no defined meaning), or `<65536x>`
///    (`u16` overflow) does NOT match — the iReal Pro spec
///    documents only the lowercase, no-whitespace, non-zero form.
///
/// 2. **Vertically-positioned caption** — body of the form `*XY...`
///    (a `*` followed by exactly two ASCII digits, then the caption
///    body). The two-digit prefix is parsed as `u8` and validated
///    against `0..=74` per the spec; out-of-range values fall
///    through to the plain text branch so the original token
///    survives the round trip. Single-digit prefixes (`*9`) also
///    fall through — the spec requires exactly two digits.
///    Examples: `<*36Solo Section:>` → vertical=36, text="Solo Section:".
///
/// 3. **Plain caption** — anything else lands as
///    [`StaffText::Text`] with `vertical_position = None`. Examples:
///    `<solo break>`, `<13 measure lead break>`, malformed forms
///    that fail (1) or (2).
///
/// The caller MUST have already pre-trimmed the input and confirmed
/// it is not a macro phrase (handled by [`classify_macro_comment`])
/// or a compound-time grouping (handled by [`parse_beat_grouping`]).
fn classify_staff_text(trimmed: &str) -> StaffText {
    // (1) `<Nx>` repeat-count form.
    if let Some(prefix) = trimmed.strip_suffix('x') {
        if !prefix.is_empty() && prefix.bytes().all(|b| b.is_ascii_digit()) {
            if let Ok(n) = prefix.parse::<u16>() {
                if let Some(nz) = core::num::NonZeroU16::new(n) {
                    return StaffText::RepeatCount(nz);
                }
            }
        }
    }
    // (2) `<*XYtext>` vertical-position form. The two-digit
    // prefix is split on a byte boundary; `*` is single-byte ASCII
    // so `rest` starts at a char boundary, and `rest` is then
    // sliced at byte index 2 only after we've confirmed the first
    // two bytes are ASCII digits (and therefore single-byte chars).
    // This protects against panics on multi-byte UTF-8 captions
    // like `<*36さくら>` where naive `split_at(2)` on the raw
    // body would slice mid-char.
    if let Some(rest) = trimmed.strip_prefix('*') {
        let bytes = rest.as_bytes();
        if bytes.len() >= 2 && bytes[0].is_ascii_digit() && bytes[1].is_ascii_digit() {
            // INVARIANT: bytes 0 and 1 are confirmed ASCII digits
            // above, so they are valid UTF-8 starts and byte index
            // 2 lands on a char boundary. (No `unsafe` block is
            // involved; this is a char-boundary justification for
            // the safe `&rest[..2]` / `&rest[2..]` slices below.)
            let pos: u8 = rest[..2].parse().expect("two ASCII digits parse as u8");
            if pos <= StaffText::MAX_VERTICAL_POSITION {
                return StaffText::Text {
                    text: rest[2..].to_owned(),
                    vertical_position: Some(pos),
                };
            }
        }
    }
    // (3) Plain caption — everything else.
    StaffText::Text {
        text: trimmed.to_owned(),
        vertical_position: None,
    }
}

fn nonempty(s: &str) -> Option<String> {
    let trimmed = s.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_owned())
    }
}

/// Implements the iReal Pro obfusc50 unscramble described in
/// `pianosnake/ireal-reader/unscramble.js`. The body is processed
/// in 50-character chunks; each chunk is unscrambled by mirroring
/// the byte ranges `0..5` ↔ `45..50` and `10..24` ↔ `26..40`
/// around the chunk centre. The trailing-< 2-bytes carve-out
/// reproduces the upstream JS quirk exactly so round-trip parity
/// against published fixtures is preserved.
fn unscramble(s: &str) -> String {
    // Operate on chars (not bytes) because iReal exports may
    // contain UTF-8 metadata in the chart body; the obfuscation
    // permutation indexes into char positions, not byte offsets,
    // and the JS reference iterates Unicode code units the same way.
    let chars: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while chars.len() - i > 50 {
        let chunk_end = i + 50;
        let remaining_after = chars.len() - chunk_end;
        if remaining_after < 2 {
            // Carve-out from upstream JS: when the tail after a
            // 50-char chunk is shorter than 2 chars, the chunk is
            // appended unscrambled.
            out.extend(&chars[i..chunk_end]);
        } else {
            out.push_str(&obfusc50(&chars[i..chunk_end]));
        }
        i = chunk_end;
    }
    // Tail (≤ 50 chars) appended unscrambled.
    out.extend(&chars[i..]);
    out
}

fn obfusc50(chunk: &[char]) -> String {
    debug_assert_eq!(chunk.len(), 50);
    let mut buf: [char; 50] = ['\0'; 50];
    buf.copy_from_slice(chunk);
    // First 5 chars swap with the last 5 (mirror).
    for k in 0..5 {
        let opp = 49 - k;
        buf.swap(k, opp);
    }
    // Chars 10..24 swap with 26..39 (mirror, skipping centre).
    for k in 10..24 {
        let opp = 49 - k;
        buf.swap(k, opp);
    }
    buf.iter().collect()
}

/// Intermediate result of parsing the chord-chart body: ordered
/// sections + the chart-level time signature (`Tnd` markers default
/// to 4/4 when absent).
struct ChordChart {
    sections: Vec<Section>,
    time_signature: TimeSignature,
}

/// Tokenises the unscrambled chord-chart body and assembles the
/// AST. Mirrors `Parser.js` in pianosnake/ireal-reader for the
/// recognised tokens (see the `rules` table there) and additionally
/// preserves section / barline / ending / symbol structure on the
/// resulting [`Section`] / [`Bar`] tree (whereas pianosnake flattens
/// to a single measures array).
fn parse_chord_chart(input: &str) -> Result<ChordChart, ParseError> {
    parse_chord_chart_with_header_ts(input, TimeSignature::default())
}

/// Variant of [`parse_chord_chart`] that pre-initialises the
/// chord-chart state's running time signature from the URL
/// header. Inline `T..` directives still take precedence (they
/// override mid-chart), but consumer directives like the #2449
/// compound-time `<a+b>` grouping that validate against the
/// active meter need the meter to be the *header* meter, not the
/// `TimeSignature::default()` placeholder.
fn parse_chord_chart_with_header_ts(
    input: &str,
    header_ts: TimeSignature,
) -> Result<ChordChart, ParseError> {
    let mut state = ChartParseState::new();
    state.time_signature = header_ts;
    let mut rest = input;
    while let Some(c) = rest.chars().next() {
        // Pre-skip whitespace.
        if c.is_whitespace() {
            rest = &rest[c.len_utf8()..];
            continue;
        }
        // Order matters — longer tokens before their prefixes.
        if let Some(r) = rest.strip_prefix("XyQ") {
            rest = r;
            continue;
        }
        if let Some(r) = rest.strip_prefix("Kcl") {
            // "Repeat previous measure and create new measure".
            // Commit the current bar as a repeat-previous-measure
            // marker bar; the renderer paints a percent-style glyph
            // in its centre.
            state.finish_bar();
            state.start_new_bar();
            state.current_bar.repeat_previous = true;
            rest = r;
            continue;
        }
        if let Some(r) = rest.strip_prefix("LZ|") {
            state.finish_bar();
            state.start_new_bar();
            rest = r;
            continue;
        }
        if let Some(r) = rest.strip_prefix("LZ") {
            state.finish_bar();
            state.start_new_bar();
            rest = r;
            continue;
        }
        // *X = section marker, where X is a single letter or
        // `m` / `i` / `v` / `c` / `b` (named section). The marker
        // applies to the next bar.
        if let Some(after_star) = rest.strip_prefix('*') {
            let mut iter = after_star.chars();
            if let Some(label_char) = iter.next() {
                let consumed = '*'.len_utf8() + label_char.len_utf8();
                state.queue_section(label_char);
                rest = &rest[consumed..];
                continue;
            }
        }
        // <...> = comment / DC / DS / Fine instruction
        if let Some(after_lt) = rest.strip_prefix('<') {
            if let Some(end) = after_lt.find('>') {
                let comment = &after_lt[..end];
                state.apply_comment(comment);
                let consumed = '<'.len_utf8() + end + '>'.len_utf8();
                rest = &rest[consumed..];
                continue;
            }
        }
        // T<numerator><denominator> — time signature directive.
        // iReal uses 2-digit packed form: T44 = 4/4, T34 = 3/4,
        // T68 = 6/8, T128 = 12/8 (3 digits when the numerator
        // is two-digit). Try the longer match first.
        if let Some(after_t) = rest.strip_prefix('T') {
            if let Some((ts, consumed)) = parse_time_signature(after_t) {
                state.set_time_signature(ts);
                rest = &after_t[consumed..];
                continue;
            }
        }
        if let Some(r) = rest.strip_prefix('x') {
            // "Repeat previous measure" — mark the current bar with
            // `repeat_previous = true` so the renderer can paint
            // the percent-style 1-bar simile glyph.
            state.current_bar.repeat_previous = true;
            rest = r;
            continue;
        }
        if let Some(r) = rest.strip_prefix('r') {
            // "Repeat previous two measures" — structurally encoded
            // as `repeat_previous` for now (single-bar repeat
            // glyph). A future extension may distinguish 1-bar from
            // 2-bar simile via a separate field.
            state.current_bar.repeat_previous = true;
            rest = r;
            continue;
        }
        if rest.starts_with('Y') {
            // Vertical spacer — count consecutive `Y` characters
            // (the iReal Pro spec defines `Y` / `YY` / `YYY` as a
            // small / medium / large between-system gap) and stamp
            // the count on the bar currently being assembled. By
            // the structure of the parse loop, that bar is the one
            // that follows the most recent bar boundary, which is
            // exactly the bar the Y run is intended to label. The
            // count is clamped at `3` because the spec only defines
            // up to three Ys; surplus Ys past the cap are absorbed
            // silently rather than promoted to a wider gap.
            let mut count: u8 = 0;
            while let Some(r) = rest.strip_prefix('Y') {
                count = count.saturating_add(1);
                rest = r;
            }
            state.add_system_break_space(count);
            continue;
        }
        if let Some(r) = rest.strip_prefix('n') {
            // "No Chord" — mark the current bar so the renderer can
            // paint the literal `N.C.` glyph. The bar still consumes
            // a measure of time but no chord sounds.
            state.current_bar.no_chord = true;
            rest = r;
            continue;
        }
        if let Some(r) = rest.strip_prefix('p') {
            // Pause slash — emit a `SlashRepeat` BarChord whose
            // chord field carries a snapshot of the preceding
            // chord (see `BarChordKind` doc). An orphan `p` with
            // no preceding chord (malformed URL) is dropped
            // silently to match the pre-#2435 behaviour. Inside
            // a `(...)` alternate-chord paren the slash is also
            // dropped — alternates are an annotation on the
            // primary chord, not a beat slot the slash could
            // legitimately occupy.
            if !state.in_alternate {
                state.push_slash_repeat();
            }
            rest = r;
            continue;
        }
        if let Some(r) = rest.strip_prefix('U') {
            // Player ending marker — no AST impact.
            rest = r;
            continue;
        }
        if let Some(r) = rest.strip_prefix('S') {
            state.queue_symbol(MusicalSymbol::Segno);
            rest = r;
            continue;
        }
        if let Some(r) = rest.strip_prefix('Q') {
            state.queue_symbol(MusicalSymbol::Coda);
            rest = r;
            continue;
        }
        if let Some(r) = rest.strip_prefix('f') {
            // Fermata — lowercase `f` per the iReal Pro Rehearsal
            // Marks table. Placed before the chord-root check
            // (`A..=G | W`) so a stray `f` is never misinterpreted
            // as a chord prefix — lowercase `f` is not a valid root
            // letter today, but explicit ordering keeps the
            // dispatcher stable if a future spec revision adds one.
            state.queue_symbol(MusicalSymbol::Fermata);
            rest = r;
            continue;
        }
        if let Some(r) = rest.strip_prefix('s') {
            // Chord-size marker — `s` switches every subsequent
            // chord to `ChordSize::Small`. Placed before the
            // chord-root check so a top-level `s` (between chord
            // boundaries, where this branch is reached) acts as a
            // size modifier, not as a malformed chord. `s` INSIDE
            // a chord token (e.g. `Csus4`) never reaches this
            // branch — `consume_chord_token` slurps the whole
            // chord including the `s` quality character before
            // control returns to the dispatcher.
            state.set_chord_size(ChordSize::Small);
            rest = r;
            continue;
        }
        if let Some(r) = rest.strip_prefix('l') {
            // Chord-size marker — `l` restores the default chord
            // size. Like `s` above, this only matches at top level
            // (between chord boundaries); a trailing `l` inside a
            // chord-quality string would have been consumed by
            // `consume_chord_token`.
            state.set_chord_size(ChordSize::Default);
            rest = r;
            continue;
        }
        if let Some(r) = rest.strip_prefix('{') {
            state.finish_bar();
            state.queue_start_repeat();
            state.start_new_bar();
            rest = r;
            continue;
        }
        if let Some(r) = rest.strip_prefix('}') {
            state.queue_close_repeat();
            state.finish_bar();
            state.start_new_bar();
            rest = r;
            continue;
        }
        if let Some(r) = rest.strip_prefix('|') {
            state.finish_bar();
            state.start_new_bar();
            rest = r;
            continue;
        }
        if let Some(r) = rest.strip_prefix('[') {
            state.finish_bar();
            state.queue_double_open();
            state.start_new_bar();
            rest = r;
            continue;
        }
        if let Some(r) = rest.strip_prefix(']') {
            state.queue_double_close();
            state.finish_bar();
            state.start_new_bar();
            rest = r;
            continue;
        }
        if let Some(after_n) = rest.strip_prefix('N') {
            if let Some(d) = after_n.chars().next() {
                if let Some(digit_value) = d.to_digit(10) {
                    // `N0` is the spec's "no text Ending" token —
                    // map it to `Ending::Untitled` instead of
                    // falling through. `N1`..=`N9` route through
                    // `Ending::new`, which today returns `None`
                    // only for `0`, and `0` is already consumed by
                    // the explicit branch above. Use `.expect` so
                    // any future widening of `Ending::new`'s
                    // rejection set surfaces as an audible panic
                    // in tests rather than silently downgrading a
                    // numbered bracket to `Untitled`.
                    let ending = if digit_value == 0 {
                        Ending::Untitled
                    } else {
                        Ending::new(digit_value as u8)
                            .expect("digit_value > 0; Ending::new currently rejects only 0")
                    };
                    state.queue_ending(ending);
                    rest = &after_n[d.len_utf8()..];
                    continue;
                }
            }
        }
        if let Some(r) = rest.strip_prefix('Z') {
            // Final bar line.
            state.queue_final();
            state.finish_bar();
            state.start_new_bar();
            rest = r;
            continue;
        }
        // Punctuation that the JS reference simply skips when no
        // rule applies: `,`, `.`, `:` and the like. Drop one char
        // and continue.
        if matches!(c, ',' | '.' | ':' | ';' | '\u{00a0}') {
            rest = &rest[c.len_utf8()..];
            continue;
        }
        // `(altchord)` — alternate chord. Iralb encodes alternate
        // chord choices in parentheses immediately after the
        // primary chord they modify (e.g. `Em7(E7#9)` reads as
        // primary `Em7` with alternate `E7#9`). The rendered chart
        // stacks the alternate as a smaller chord above the
        // primary.
        if c == '(' {
            state.set_in_alternate(true);
            rest = &rest[c.len_utf8()..];
            continue;
        }
        if c == ')' {
            state.set_in_alternate(false);
            rest = &rest[c.len_utf8()..];
            continue;
        }
        // Chord: `[A-GW][quality]*[/Bass[#b]?]?`.
        if matches!(c, 'A'..='G' | 'W') {
            let consumed = consume_chord_token(rest);
            let chord_str = &rest[..consumed];
            state.push_chord(chord_str)?;
            rest = &rest[consumed..];
            continue;
        }
        // No rule applies — drop one char (mirrors the JS
        // fall-through path).
        rest = &rest[c.len_utf8()..];
    }
    state.finish_bar();
    let chart = state.into_chart();
    Ok(chart)
}

/// Parses a `Tnd` (or `Tnnd`) time-signature token from the
/// post-`T` slice. Returns `Some((TimeSignature, consumed_bytes))`
/// on success or `None` if the digit run does not form a
/// recognised iReal time signature.
///
/// Implemented as a free function (rather than a `let`-chain
/// inline match) because the workspace pins `rust-version = 1.85`,
/// which predates stable `if let && let` chains (#53667 — those
/// landed in 1.88).
fn parse_time_signature(after_t: &str) -> Option<(TimeSignature, usize)> {
    let digits: String = after_t.chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.len() >= 3 {
        let num = digits[..2].parse::<u8>().ok();
        let den = digits[2..3].parse::<u8>().ok();
        if let (Some(n), Some(d)) = (num, den) {
            if let Some(ts) = TimeSignature::new(n, d) {
                return Some((ts, 3));
            }
        }
    }
    if digits.len() >= 2 {
        let num = digits[..1].parse::<u8>().ok();
        let den = digits[1..2].parse::<u8>().ok();
        if let (Some(n), Some(d)) = (num, den) {
            if let Some(ts) = TimeSignature::new(n, d) {
                return Some((ts, 2));
            }
        }
    }
    None
}

/// Returns the byte length of the chord token starting at
/// `input`. Caller has already verified the first char is one of
/// `A..G` or `W`.
fn consume_chord_token(input: &str) -> usize {
    let mut chars = input.char_indices();
    // Always consume the root letter.
    let (_first_idx, _first_ch) = chars.next().expect("caller checked non-empty");
    let mut last = input.chars().next().unwrap().len_utf8();
    let mut after_slash = false;
    for (idx, ch) in chars {
        let allowed = if after_slash {
            matches!(ch, 'A'..='G' | '#' | 'b')
        } else {
            matches!(
                ch,
                '+' | '-' | '^' | 'h' | 'o' | '#' | 'b' | 's' | 'u' | 'a' | 'd' | 'l' | 't'
            ) || ch.is_ascii_digit()
                || ch == '/'
        };
        if !allowed {
            break;
        }
        last = idx + ch.len_utf8();
        if ch == '/' {
            after_slash = true;
        }
    }
    last
}

#[derive(Default)]
struct ChartParseState {
    sections: Vec<Section>,
    current_section: Option<Section>,
    current_bar: Bar,
    pending_section_label: Option<SectionLabel>,
    pending_start_repeat: bool,
    pending_double_open: bool,
    pending_double_close: bool,
    pending_final: bool,
    /// `true` between `(` and `)` — the next chord parsed in this
    /// window attaches as the previous chord's `alternate` rather
    /// than as a new chord on the bar.
    in_alternate: bool,
    last_chord: Option<String>,
    time_signature: TimeSignature,
    /// Display size applied to every subsequently-emitted chord
    /// until the next `s` / `l` marker. Persists across bar
    /// boundaries — the spec's "all the following chord symbols
    /// will be narrower until an `l` symbol is encountered" wording
    /// is parser-wide, not bar-scoped.
    current_chord_size: ChordSize,
    /// Active compound-time beat grouping override (#2449).
    /// Per the spec, an override "remains until the opposite is
    /// used", so the parser tracks the running grouping and stamps
    /// it onto every bar from the override forward. Reset to `None`
    /// whenever the time signature itself changes, because the new
    /// meter's natural grouping is the only well-defined default
    /// across the spec's documented odd-meter set (5/8, 5/4, 7/8,
    /// 7/4); requiring an explicit re-assert under the new meter
    /// keeps the AST honest about which feel is active.
    current_beat_grouping: Option<BeatGrouping>,
}

impl ChartParseState {
    fn new() -> Self {
        Self::default()
    }

    fn set_time_signature(&mut self, ts: TimeSignature) {
        if ts != self.time_signature {
            // The previous bar's running grouping was valid only
            // under the prior meter; a new meter resets the
            // running state so an explicit `<a+b>` is needed
            // before the next bar inherits a non-default feel.
            self.current_beat_grouping = None;
        }
        self.time_signature = ts;
    }

    fn queue_section(&mut self, c: char) {
        self.pending_section_label = Some(label_for(c));
    }

    fn set_in_alternate(&mut self, on: bool) {
        self.in_alternate = on;
    }

    fn queue_symbol(&mut self, sym: MusicalSymbol) {
        // Symbols (`S` segno, `Q` coda, `<D.C.>` / `<D.S.>` /
        // `<Fine>` macros) label the bar in which the marker
        // appears. After the most recent `|` / `[` / `{` already
        // ran `start_new_bar`, `current_bar` IS that bar. Earlier
        // revisions queued the symbol via `pending_symbol` so the
        // NEXT `start_new_bar` would consume it onto the next bar
        // — that pushed `,S,E-7|A7|` onto A7 instead of E-7,
        // because `S` sits between the bar boundary and the chord
        // it labels.
        self.current_bar.symbol = Some(sym);
    }

    fn queue_start_repeat(&mut self) {
        self.pending_start_repeat = true;
    }

    fn queue_close_repeat(&mut self) {
        self.current_bar.end = BarLine::CloseRepeat;
    }

    fn queue_double_open(&mut self) {
        self.pending_double_open = true;
    }

    fn queue_double_close(&mut self) {
        self.pending_double_close = true;
    }

    fn queue_final(&mut self) {
        self.pending_final = true;
    }

    fn set_chord_size(&mut self, size: ChordSize) {
        self.current_chord_size = size;
    }

    fn add_system_break_space(&mut self, count: u8) {
        // Saturating-add against the spec cap (`3`). Re-running `Y`
        // tokens within the same bar context accumulates toward the
        // cap; once at the cap, extra Ys are absorbed silently.
        let new_count = self.current_bar.system_break_space.saturating_add(count);
        self.current_bar.system_break_space = new_count.min(3);
    }

    fn queue_ending(&mut self, ending: Ending) {
        // iReal Pro encodes ending markers (`N1`, `N2`) immediately
        // after a bar boundary (`|`, `}`, `]`), so by the time this
        // runs, `current_bar` is the freshly-started bar that the
        // marker labels — set the field directly. Earlier revisions
        // queued the marker for the NEXT `start_new_bar`, which made
        // the chord that followed `N1` land on an unlabelled bar
        // and the next bar boundary commit an empty placeholder
        // bearing the label.
        self.current_bar.ending = Some(ending);
    }

    fn apply_comment(&mut self, comment: &str) {
        // Compound-time beat-grouping override (#2449). Detected
        // first because the `digit+digit(+...)+` shape is
        // unambiguously numeric and cannot collide with the
        // English-prefix macros below. Validation against the
        // active meter happens inside the helper; on failure the
        // text falls through to the text-comment path so a
        // malformed grouping (e.g. `<3+3>` under 5/4) survives
        // the URL round-trip as free-form text rather than being
        // silently dropped.
        let trimmed_input = comment.trim();
        if let Some(grouping) = parse_beat_grouping(trimmed_input) {
            let sum = u16::from(self.time_signature.numerator);
            if grouping.sum() == sum {
                self.current_beat_grouping = Some(grouping.clone());
                self.current_bar.beat_grouping_override = Some(grouping);
                return;
            }
            // Sum mismatch: keep going through the rest of
            // `apply_comment` so the original token is preserved
            // verbatim as a [`StaffText`] entry. The spec doesn't
            // say how the iReal Pro player handles mismatched
            // groupings; saving the raw text matches the
            // pre-#2449 fallback behaviour and lets a future
            // audit recover the original intent.
        }
        let trimmed = trimmed_input;
        if trimmed.is_empty() {
            return;
        }
        // Detect the recognised musical-direction macros. The
        // matched symbol is set directly on `current_bar` (see
        // `queue_symbol`). `staff_texts` is intentionally NOT
        // populated when a macro matches: the structured symbol
        // (#2427) fully captures the spec phrasing and the
        // serializer re-derives the original `<D.C. al Coda>` /
        // `<D.S. al 1st End.>` / `<Fine>` text from
        // `MusicalSymbol::canonical_text`. Saving the same string in
        // both `bar.symbol` and a `StaffText` entry would round-trip
        // into duplicated output and force every renderer to
        // deduplicate.
        //
        // The match table is the eleven player-recognised phrases
        // from
        // <https://www.irealpro.com/ireal-pro-custom-chord-chart-protocol>
        // plus the bare `<D.C.>` / `<D.S.>` / `<Fine>` / `<Break>`
        // legacy export forms. Anything outside this exact set
        // falls through to a `StaffText` entry so unrecognised
        // free-form captions (`<13 measure lead break>`, `<D.C. on
        // Cue>`, `<solo break>`) survive the round trip as staff
        // text rather than spuriously firing a macro. Note that
        // `End`, `Ending`, and `End.` ARE accepted as synonyms by
        // `classify_al_target` because real iReal Pro exports use
        // all three spellings; only structurally-wrong tails
        // (`on Cue`, `defining`, etc.) fall through.
        if let Some(symbol) = classify_macro_comment(trimmed) {
            self.queue_symbol(symbol);
            return;
        }
        // Everything else is preserved as one [`StaffText`] entry
        // appended to the bar's `staff_texts`. The shape classifier
        // (`classify_staff_text`) handles the spec's two structured
        // forms — `<*XYtext>` (vertical position) and `<Nx>`
        // (repeat-count override) — and otherwise falls through to
        // a plain `Text` entry so any caption the iReal Pro app
        // permitted survives the round trip verbatim. Multiple
        // tokens on the same bar produce multiple entries in source
        // order (#2426).
        self.current_bar
            .staff_texts
            .push(classify_staff_text(trimmed));
    }

    fn push_chord(&mut self, raw: &str) -> Result<(), ParseError> {
        let resolved = if let Some(after_w) = raw.strip_prefix('W') {
            // `W` is iReal's "invisible slash" — repeat the
            // previous root with this quality. If we have no
            // previous chord, fall back to treating the `W` as a
            // chord root spelling `C` (the JS reference does this
            // implicitly by leaving the `W` in the chord string).
            if let Some(ref last_root) = self.last_chord {
                format!("{}{}", last_root, after_w)
            } else {
                raw.to_owned()
            }
        } else {
            // Store only the root (note + optional accidental) so that
            // a subsequent `W{quality}` token resolves to the correct
            // root. Storing the full chord string (including quality)
            // would produce a double-quality concatenation, e.g.
            // `last="Db-7"` followed by `W-7` → `"Db-7-7"` instead
            // of `"Db-7"`.
            let root = chord_root_str(strip_slash_bass(raw));
            self.last_chord = Some(root.to_owned());
            raw.to_owned()
        };
        let chord = parse_chord(&resolved)?;
        // When inside `(...)` parens, attach the parsed chord as
        // the previous *Played* chord's `alternate` rather than as
        // a new chord on the bar. Walking back to the last Played
        // entry (rather than `chords.last_mut()`) matters when a
        // `p` pause-slash sits between the primary chord and the
        // open paren — e.g. `|C7p(D7)|`. The SlashRepeat at
        // index 1 is unfit to carry an alternate because it
        // renders as `/` and the alternate field would never
        // surface. Attaching to the C7 at index 0 is the only
        // semantically meaningful destination. Falls back to a
        // regular push if no Played chord exists (URL malformed —
        // alt without primary).
        if self.in_alternate {
            if let Some(prev) = self
                .current_bar
                .chords
                .iter_mut()
                .rev()
                .find(|bc| bc.kind == BarChordKind::Played)
            {
                prev.chord.alternate = Some(Box::new(chord));
                return Ok(());
            }
        }
        // Beat positions are not encoded in the iReal URL format; the
        // renderer distributes chords across beats based on count and
        // time signature. Beat 1 is a structural placeholder here.
        // See #2057 (render-ireal) for beat-distribution logic.
        let position = BeatPosition::on_beat(1).expect("beat 1 is always a valid NonZeroU8");
        let size = self.current_chord_size;
        self.current_bar.chords.push(BarChord {
            chord,
            position,
            size,
            kind: BarChordKind::Played,
        });
        Ok(())
    }

    /// Emits a pause-slash marker — a [`BarChord`] with
    /// [`BarChordKind::SlashRepeat`] carrying a snapshot of the
    /// preceding chord. Returns `false` (and pushes nothing) when no
    /// preceding chord exists; that case represents a malformed URL
    /// and is dropped silently to match the pre-#2435 behaviour of
    /// orphan `p` tokens.
    fn push_slash_repeat(&mut self) -> bool {
        let Some(prev_chord) = self.most_recent_chord() else {
            return false;
        };
        let position = BeatPosition::on_beat(1).expect("beat 1 is always a valid NonZeroU8");
        let size = self.current_chord_size;
        self.current_bar.chords.push(BarChord {
            chord: prev_chord,
            position,
            size,
            kind: BarChordKind::SlashRepeat,
        });
        true
    }

    /// Returns the most recent `Played` chord — first the current
    /// bar's last `Played` chord (a slash repeat of the same bar's
    /// previous chord), then any previous bar's last `Played` chord
    /// inside the current section (a slash repeat across a bar
    /// boundary, e.g. `|C7|pF7|`). Walks back only within the
    /// current section; a pause-slash as the first token of a new
    /// section (input: `|C7|[*Bp|F7|`) is treated as an orphan and
    /// dropped, because section breaks in iReal Pro typically reset
    /// the rhythmic context and a slash crossing them would carry
    /// ambiguous provenance. `SlashRepeat` entries are skipped
    /// because they themselves carry a snapshot of an earlier
    /// chord — chaining snapshots is unnecessary and would dilute
    /// provenance if the original chord changes.
    fn most_recent_chord(&self) -> Option<Chord> {
        let from_current = self
            .current_bar
            .chords
            .iter()
            .rev()
            .find(|bc| bc.kind == BarChordKind::Played)
            .map(|bc| bc.chord.clone());
        if from_current.is_some() {
            return from_current;
        }
        let section = self.current_section.as_ref()?;
        for bar in section.bars.iter().rev() {
            if let Some(bc) = bar
                .chords
                .iter()
                .rev()
                .find(|bc| bc.kind == BarChordKind::Played)
            {
                return Some(bc.chord.clone());
            }
        }
        None
    }

    fn start_new_bar(&mut self) {
        self.current_bar = Bar::default();
        if self.pending_start_repeat {
            self.current_bar.start = BarLine::OpenRepeat;
            self.pending_start_repeat = false;
        }
        if self.pending_double_open {
            self.current_bar.start = BarLine::Double;
            self.pending_double_open = false;
        }
        // Inherit the running beat-grouping override (#2449) so the
        // spec's "remains until the opposite is used" wording is
        // realised at the AST level: every bar from the override
        // forward carries the same grouping, and the per-bar field
        // is sufficient for renderers / consumers without a
        // separate query over the section's running state.
        if let Some(grouping) = self.current_beat_grouping.clone() {
            self.current_bar.beat_grouping_override = Some(grouping);
        }
    }

    fn finish_bar(&mut self) {
        let is_empty_placeholder = self.current_bar.chords.is_empty()
            && self.current_bar.ending.is_none()
            && self.current_bar.symbol.is_none()
            && !self.current_bar.repeat_previous
            && !self.current_bar.no_chord
            && self.current_bar.staff_texts.is_empty()
            && self.current_bar.start == BarLine::Single
            && self.current_bar.end == BarLine::Single;
        // `system_break_space` is deliberately excluded from this
        // check: a bar carrying only a vertical-space hint has no
        // content to space against, so dropping it (and the
        // orphaned hint) matches the "Y between bars" intent of
        // the spec.
        if is_empty_placeholder {
            // The current bar is the empty placeholder iReal's
            // lexer leaves between consecutive bar boundaries (a
            // common pattern at song end, e.g. `…G-11XyQKcl  Z`).
            // Dropping it is the right move BUT first promote any
            // pending end-barline marker (Double / Final) to the
            // last committed bar in the current section — those
            // markers attach to a bar's RIGHT edge, and the
            // committed bar is the rightmost real bar in the song.
            if self.pending_final || self.pending_double_close {
                if let Some(section) = self.current_section.as_mut() {
                    if let Some(last) = section.bars.last_mut() {
                        if self.pending_final {
                            last.end = BarLine::Final;
                            self.pending_final = false;
                        } else if self.pending_double_close {
                            last.end = BarLine::Double;
                            self.pending_double_close = false;
                        }
                    }
                }
            }
            return;
        }
        if self.pending_double_close {
            self.current_bar.end = BarLine::Double;
            self.pending_double_close = false;
        }
        if self.pending_final {
            self.current_bar.end = BarLine::Final;
            self.pending_final = false;
        }
        // Move the bar into the right section. If we have a
        // pending section label, start a new section.
        if let Some(label) = self.pending_section_label.take() {
            if let Some(prev) = self.current_section.take() {
                self.sections.push(prev);
            }
            self.current_section = Some(Section {
                label,
                bars: Vec::new(),
            });
        }
        let section = self
            .current_section
            .get_or_insert_with(|| Section::new(SectionLabel::Letter('A')));
        section.bars.push(std::mem::take(&mut self.current_bar));
    }

    fn into_chart(mut self) -> ChordChart {
        if let Some(section) = self.current_section.take() {
            self.sections.push(section);
        }
        ChordChart {
            sections: self.sections,
            time_signature: self.time_signature,
        }
    }
}

fn label_for(c: char) -> SectionLabel {
    // Per the iReal Pro open-protocol spec the app emits six
    // rehearsal-mark tokens: `*A`, `*B`, `*C`, `*D`, `*i`, `*V`.
    // Match the named tokens first (#2432 — the spec lists `*V`
    // uppercase, not `*v`; we accept both). All other uppercase
    // single letters fall through to `Letter(c)`. Anything else
    // is `Custom(string)` — same escape hatch as before, but the
    // matched-named-token vocabulary is now restricted to what
    // the iReal Pro app actually emits (#2450 — `c` / `b` / `o`
    // were never emitted, the variants have been removed).
    match c {
        'i' | 'I' => SectionLabel::Intro,
        'v' | 'V' => SectionLabel::Verse,
        'A'..='Z' => SectionLabel::Letter(c),
        other => SectionLabel::Custom(other.to_string()),
    }
}

fn strip_slash_bass(chord: &str) -> &str {
    chord.split('/').next().unwrap_or(chord)
}

/// Returns the root portion (note letter + optional accidental) of a
/// raw chord token. Used so [`ChartParseState::last_chord`] stores
/// only the root for `W` (invisible-slash) resolution.
///
/// Examples: `"Db-7"` → `"Db"`, `"C7"` → `"C"`, `"F#"` → `"F#"`.
fn chord_root_str(s: &str) -> &str {
    let mut iter = s.char_indices();
    let Some((_, _root_ch)) = iter.next() else {
        return s;
    };
    match iter.next() {
        // '#' and 'b' immediately after the root letter are the accidental.
        Some((_acc_idx, '#' | 'b')) => match iter.next() {
            // Byte index of the char after the accidental is the start
            // of the quality — slice up to (but not including) it.
            Some((after_acc_idx, _)) => &s[..after_acc_idx],
            // String is exactly root + accidental with nothing after.
            None => s,
        },
        // Non-accidental char: quality starts here.
        Some((qual_idx, _)) => &s[..qual_idx],
        // String is just the root letter with nothing after.
        None => s,
    }
}

fn parse_chord(raw: &str) -> Result<Chord, ParseError> {
    let mut chars = raw.chars();
    let root_char = chars.next().ok_or(ParseError::InvalidChord(raw.into()))?;
    if !matches!(root_char, 'A'..='G' | 'W') {
        return Err(ParseError::InvalidChord(raw.into()));
    }
    let (root_acc_consumed, root_acc) = peek_accidental(chars.clone());
    let after_root_idx = root_char.len_utf8() + root_acc_consumed;
    let body = &raw[after_root_idx..];
    let (quality_part, bass_part) = match body.find('/') {
        Some(idx) => (&body[..idx], Some(&body[idx + '/'.len_utf8()..])),
        None => (body, None),
    };
    let quality = parse_quality(quality_part);
    let bass = bass_part
        .map(|b| {
            let mut iter = b.chars();
            let bass_char = iter.next().ok_or(ParseError::InvalidChord(raw.into()))?;
            if !matches!(bass_char, 'A'..='G') {
                return Err(ParseError::InvalidChord(raw.into()));
            }
            let (_consumed, bass_acc) = peek_accidental(iter);
            Ok::<ChordRoot, ParseError>(ChordRoot {
                note: bass_char,
                accidental: bass_acc,
            })
        })
        .transpose()?;
    let root = ChordRoot {
        note: if root_char == 'W' { 'C' } else { root_char },
        accidental: root_acc,
    };
    Ok(Chord {
        root,
        quality,
        bass,
        alternate: None,
    })
}

fn peek_accidental(mut iter: std::str::Chars<'_>) -> (usize, Accidental) {
    match iter.next() {
        Some('#') => ('#'.len_utf8(), Accidental::Sharp),
        Some('b') => ('b'.len_utf8(), Accidental::Flat),
        _ => (0, Accidental::Natural),
    }
}

fn parse_quality(raw: &str) -> ChordQuality {
    // The quality token is the post-root, pre-slash portion of the
    // chord. Map the canonical iReal forms; everything else is a
    // verbatim `Custom`.
    match raw {
        "" => ChordQuality::Major,
        "-" | "min" | "m" => ChordQuality::Minor,
        "o" => ChordQuality::Diminished,
        "+" | "aug" => ChordQuality::Augmented,
        "^7" | "maj7" | "M7" => ChordQuality::Major7,
        "-7" | "m7" | "min7" => ChordQuality::Minor7,
        "7" => ChordQuality::Dominant7,
        "h7" | "h" | "m7b5" => ChordQuality::HalfDiminished,
        "o7" => ChordQuality::Diminished7,
        "sus2" => ChordQuality::Suspended2,
        "sus" | "sus4" => ChordQuality::Suspended4,
        other => ChordQuality::Custom(other.to_owned()),
    }
}

/// Parses the `Key` field from the iReal song body into a
/// [`KeySignature`].
///
/// iReal Pro exports a short string such as `"C"`, `"Db"`, or
/// `"F#-"`. If the field is absent or does not start with a valid
/// note letter the function silently returns C major — matching the
/// iReal app's own implicit default for charts with missing or
/// unrecognised key fields.
fn parse_key(raw: &str) -> KeySignature {
    let mut iter = raw.chars();
    let note = iter.next().unwrap_or('C');
    let mut acc = Accidental::Natural;
    let mut peeked = iter.clone();
    if let Some(next) = peeked.next() {
        match next {
            '#' => {
                acc = Accidental::Sharp;
                iter.next();
            }
            'b' => {
                acc = Accidental::Flat;
                iter.next();
            }
            _ => {}
        }
    }
    let mode = match iter.next() {
        Some('-') => KeyMode::Minor,
        _ => KeyMode::Major,
    };
    KeySignature {
        root: ChordRoot {
            note: if matches!(note, 'A'..='G') { note } else { 'C' },
            accidental: acc,
        },
        mode,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percent_decode_basic() {
        assert_eq!(percent_decode("Hello%20World").unwrap(), "Hello World");
        assert_eq!(percent_decode("%41%42%43").unwrap(), "ABC");
    }

    #[test]
    fn percent_decode_rejects_truncated() {
        assert!(matches!(
            percent_decode("foo%4"),
            Err(ParseError::InvalidPercentEscape)
        ));
    }

    #[test]
    fn percent_decode_rejects_non_hex() {
        assert!(matches!(
            percent_decode("foo%4Z"),
            Err(ParseError::InvalidPercentEscape)
        ));
    }

    #[test]
    fn obfusc50_is_self_inverse() {
        // The obfusc50 permutation is symmetric (the same swap
        // pattern unscrambles a scrambled chunk and vice versa),
        // so applying it twice yields the original.
        let original: Vec<char> = (0..50).map(|i| char::from(b'a' + (i as u8 % 26))).collect();
        let once = obfusc50(&original);
        let twice = obfusc50(&once.chars().collect::<Vec<char>>());
        assert_eq!(twice, original.iter().collect::<String>());
    }

    #[test]
    fn obfusc50_swaps_documented_positions() {
        let chunk: Vec<char> = (0..50).map(|i| char::from(b'a' + (i as u8 % 26))).collect();
        let scrambled: Vec<char> = obfusc50(&chunk).chars().collect();
        // Loop 1: i in 0..5 (exclusive 5), so positions
        // [0..=4] swap with [45..=49].
        assert_eq!(scrambled[0], chunk[49]);
        assert_eq!(scrambled[49], chunk[0]);
        assert_eq!(scrambled[4], chunk[45]);
        assert_eq!(scrambled[45], chunk[4]);
        // Loop 2: i in 10..24 (exclusive 24), so positions
        // [10..=23] swap with [26..=39].
        assert_eq!(scrambled[10], chunk[39]);
        assert_eq!(scrambled[23], chunk[26]);
        assert_eq!(scrambled[26], chunk[23]);
        assert_eq!(scrambled[39], chunk[10]);
        // Untouched positions: 5..=9, 24..=25, 40..=44.
        for i in 5..=9 {
            assert_eq!(scrambled[i], chunk[i], "pos {i} should be unchanged");
        }
        for i in 24..=25 {
            assert_eq!(scrambled[i], chunk[i], "pos {i} should be unchanged");
        }
        for i in 40..=44 {
            assert_eq!(scrambled[i], chunk[i], "pos {i} should be unchanged");
        }
    }

    #[test]
    fn unscramble_short_input_passes_through() {
        // Inputs <= 50 chars are appended unchanged.
        let s = "abc";
        assert_eq!(unscramble(s), s);
    }

    #[test]
    fn parse_quality_canonical_forms() {
        assert_eq!(parse_quality(""), ChordQuality::Major);
        assert_eq!(parse_quality("-"), ChordQuality::Minor);
        assert_eq!(parse_quality("7"), ChordQuality::Dominant7);
        assert_eq!(parse_quality("^7"), ChordQuality::Major7);
        assert_eq!(parse_quality("-7"), ChordQuality::Minor7);
        assert!(matches!(
            parse_quality("13b9"),
            ChordQuality::Custom(s) if s == "13b9"
        ));
    }

    #[test]
    fn parse_chord_round_trips() {
        let c = parse_chord("C-7").unwrap();
        assert_eq!(c.root.note, 'C');
        assert_eq!(c.root.accidental, Accidental::Natural);
        assert_eq!(c.quality, ChordQuality::Minor7);
        assert!(c.bass.is_none());

        let slash = parse_chord("C/G").unwrap();
        assert_eq!(slash.bass.unwrap().note, 'G');

        let sharp_minor = parse_chord("F#-").unwrap();
        assert_eq!(sharp_minor.root.note, 'F');
        assert_eq!(sharp_minor.root.accidental, Accidental::Sharp);
        assert_eq!(sharp_minor.quality, ChordQuality::Minor);
    }

    #[test]
    fn chord_root_str_extracts_root_only() {
        assert_eq!(chord_root_str("C"), "C");
        assert_eq!(chord_root_str("C7"), "C");
        assert_eq!(chord_root_str("C-7"), "C");
        assert_eq!(chord_root_str("Db"), "Db");
        assert_eq!(chord_root_str("Db-7"), "Db");
        assert_eq!(chord_root_str("F#-"), "F#");
        assert_eq!(chord_root_str("Bbmaj7"), "Bb");
        // slash chords: strip_slash_bass is called first in practice,
        // but chord_root_str must also handle them correctly alone.
        assert_eq!(chord_root_str("C/G"), "C");
    }

    #[test]
    fn w_resolution_uses_root_not_full_quality() {
        // Regression test: when `W` follows a chord with a non-empty
        // quality (e.g. `Db-7`), the resolved chord must use only the
        // root (`Db`), not the full previous token (`Db-7`). The bug
        // was that `last_chord` stored the full quality-bearing string,
        // causing `W-7` to resolve to `"Db-7-7"` (a Custom quality)
        // rather than `"Db-7"` (Minor7).
        let mut state = ChartParseState::new();
        // Push a chord with non-empty quality to set last_chord.
        state.push_chord("Db-7").unwrap();
        // Now push a W chord — should resolve to Db + quality "-7".
        state.push_chord("W-7").unwrap();
        let chords = &state.current_bar.chords;
        assert_eq!(chords.len(), 2);
        assert_eq!(chords[1].chord.root.note, 'D');
        assert_eq!(chords[1].chord.root.accidental, Accidental::Flat);
        assert_eq!(chords[1].chord.quality, ChordQuality::Minor7);
    }

    #[test]
    fn parse_rejects_missing_prefix() {
        assert!(matches!(
            parse("https://example.com"),
            Err(ParseError::MissingPrefix)
        ));
    }

    #[test]
    fn parse_rejects_oversized_input() {
        let large = "x".repeat(MAX_INPUT_BYTES + 1);
        assert!(matches!(parse(&large), Err(ParseError::InputTooLarge(_))));
    }

    // ---- Macro classifier (exact-match, post-#2427) ----------------

    #[test]
    fn classify_macro_rejects_english_substrings() {
        // The regression these tests guard against: a substring
        // `lower.contains("fine")` would happily match `refine` /
        // `define`, leading to spurious `MusicalSymbol::Fine` on the
        // bar. The exact-match classifier (`classify_macro_comment`)
        // structurally cannot fire for these inputs because the
        // normalised text isn't an exact key in the match table.
        for caption in [
            "refine",
            "define",
            "undefined",
            "13 measure lead break",
            "a d.c. directive",
            "breakaway",
        ] {
            assert!(
                classify_macro_comment(caption).is_none(),
                "caption `{caption}` must not classify as a macro"
            );
        }
    }

    // ---- Parser behaviour for the new commit's URL tokens ---------

    #[test]
    fn alternate_chord_parses_to_alternate_field() {
        // `Em7(E7#9)` — primary E-7 with alt E7#9.
        let url = "irealbook://Test=A==Style=C=44=[*AE-7(E7#9)|G7]";
        let song = parse(url).expect("parse");
        let bar0 = &song.sections[0].bars[0];
        assert_eq!(bar0.chords.len(), 1);
        let chord = &bar0.chords[0].chord;
        assert_eq!(chord.root.note, 'E');
        assert!(chord.alternate.is_some());
        let alt = chord.alternate.as_ref().unwrap();
        assert_eq!(alt.root.note, 'E');
    }

    #[test]
    fn alternate_chord_with_no_primary_falls_through_to_regular_push() {
        // Malformed URL `(C)|D|` — alt parens with no preceding
        // chord. The current contract is to fall through to a
        // regular push so the chart still renders SOMETHING. Lock
        // that contract in a test so a future tightening (errors
        // out instead) is a deliberate decision.
        let url = "irealbook://Test=A==Style=C=44=[*A(C)|D|]";
        let song = parse(url).expect("parse");
        let bar0 = &song.sections[0].bars[0];
        assert_eq!(bar0.chords.len(), 1);
        assert_eq!(bar0.chords[0].chord.root.note, 'C');
        assert!(bar0.chords[0].chord.alternate.is_none());
    }

    #[test]
    fn n_token_sets_no_chord_flag() {
        let url = "irealbook://Test=A==Style=C=44=[*An|C|]";
        let song = parse(url).expect("parse");
        assert!(song.sections[0].bars[0].no_chord);
    }

    #[test]
    fn x_token_sets_repeat_previous_flag() {
        let url = "irealbook://Test=A==Style=C=44=[*AC| x |D|]";
        let song = parse(url).expect("parse");
        assert!(song.sections[0].bars[1].repeat_previous);
    }

    #[test]
    fn compound_time_grouping_3_plus_2_under_5_4() {
        // Spec example: 5/4 played as 3+2. The `<3+2>` directive
        // lands on the second bar; subsequent bars inherit the
        // running grouping per the spec's "remains until the
        // opposite is used" wording.
        let url = "irealbook://Test=A==Style=C=54=[*AC|<3+2>D|E|F|]";
        let song = parse(url).expect("parse");
        let bars = &song.sections[0].bars;
        // First bar predates the override.
        assert!(bars[0].beat_grouping_override.is_none());
        // Override bar carries the explicit grouping.
        let g1 = bars[1]
            .beat_grouping_override
            .as_ref()
            .expect("3+2 grouping");
        assert_eq!(g1.parts().len(), 2);
        assert_eq!(g1.parts()[0].get(), 3);
        assert_eq!(g1.parts()[1].get(), 2);
        // Running state inherits forward.
        assert_eq!(bars[2].beat_grouping_override, Some(g1.clone()));
        assert_eq!(bars[3].beat_grouping_override, Some(g1.clone()));
    }

    #[test]
    fn compound_time_grouping_3_plus_2_plus_2_under_7_8() {
        // Spec example: 7/8 as 3+2+2 (non-default for 7/8).
        let url = "irealbook://Test=A==Style=C=78=[*A<3+2+2>C|D|]";
        let song = parse(url).expect("parse");
        let bars = &song.sections[0].bars;
        let g = bars[0]
            .beat_grouping_override
            .as_ref()
            .expect("3+2+2 grouping");
        assert_eq!(g.parts().len(), 3);
        assert_eq!(g.sum(), 7);
        assert_eq!(bars[1].beat_grouping_override, Some(g.clone()));
    }

    #[test]
    fn compound_time_grouping_rejects_sum_mismatch() {
        // `<3+3>` under 5/4: sum is 6, numerator is 5. The grouping
        // is rejected as an override but the text falls through to
        // `staff_texts` so the original intent isn't lost on
        // round-trip.
        let url = "irealbook://Test=A==Style=C=54=[*A<3+3>C|]";
        let song = parse(url).expect("parse");
        let bar0 = &song.sections[0].bars[0];
        assert!(bar0.beat_grouping_override.is_none());
        assert_eq!(bar0.staff_texts, vec![StaffText::plain("3+3")]);
    }

    #[test]
    fn compound_time_grouping_reset_on_time_signature_change() {
        // A `<3+2>` override under 5/4 must NOT survive a meter
        // change to 7/8 — the new meter's natural grouping is the
        // default, and the parser drops the running state so an
        // explicit `<a+b>` is needed before the new meter inherits
        // a non-default feel.
        let url = "irealbook://Test=A==Style=C=54=[*A<3+2>C|D|T78E|F|]";
        let song = parse(url).expect("parse");
        let bars = &song.sections[0].bars;
        assert_eq!(
            bars[0]
                .beat_grouping_override
                .as_ref()
                .map(|g| g.parts().len()),
            Some(2),
            "5/4 bar carries 3+2"
        );
        // After T78 the running state is reset; the post-change
        // bars carry no override.
        let post_change: Vec<_> = bars
            .iter()
            .skip_while(|b| {
                b.beat_grouping_override
                    .as_ref()
                    .is_some_and(|g| g.parts()[0].get() == 3)
            })
            .collect();
        assert!(
            !post_change.is_empty(),
            "expected at least one post-T78 bar"
        );
        for b in post_change {
            assert!(
                b.beat_grouping_override.is_none(),
                "T78 must reset the running grouping; got {:?}",
                b.beat_grouping_override
            );
        }
    }

    #[test]
    fn compound_time_grouping_rejects_malformed_input() {
        // Malformed groupings fall through to staff_texts rather
        // than being silently dropped or panicking:
        //
        // - `<2++3>`, `<+3>`, `<2+>`: empty subgroup (split-on-`+`
        //   produces an empty piece).
        // - `<2+0+3>`: zero subgroup (NonZeroU8 rejects).
        // - `<2+a>`: non-digit char in a subgroup
        //   (`piece.chars().all(is_ascii_digit)` rejects).
        // - `<5>`: single subgroup (the constructor's `len() >= 2`
        //   rejects; the parser's lexer also rejects on the same
        //   condition).
        for token in ["2++3", "+3", "2+", "2+0+3", "2+a", "5"] {
            let url = format!("irealbook://Test=A==Style=C=44=[*A<{token}>C|]");
            let song = parse(&url).expect("parse");
            let bar0 = &song.sections[0].bars[0];
            assert!(
                bar0.beat_grouping_override.is_none(),
                "malformed `<{token}>` must not produce an override"
            );
            assert_eq!(
                bar0.staff_texts,
                vec![StaffText::plain(token)],
                "malformed token must round-trip via staff_texts"
            );
        }
    }

    #[test]
    fn pause_slash_emits_slash_repeat_with_previous_chord() {
        // `|C7ppF7|` — the spec example from
        // https://www.irealpro.com/ireal-pro-custom-chord-chart-protocol.
        // Beat 1: C7. Beats 2,3: slash repeats of C7. Beat 4: F7.
        let url = "irealbook://Test=A==Style=C=44=[*AC7ppF7|]";
        let song = parse(url).expect("parse");
        let bar0 = &song.sections[0].bars[0];
        assert_eq!(bar0.chords.len(), 4, "C7 + 2 slash + F7 = 4 entries");
        assert_eq!(bar0.chords[0].kind, BarChordKind::Played);
        assert_eq!(bar0.chords[0].chord.root.note, 'C');
        assert_eq!(bar0.chords[1].kind, BarChordKind::SlashRepeat);
        // SlashRepeat carries a snapshot of the preceding chord so
        // consumers that introspect harmony see C7, not a sentinel.
        assert_eq!(bar0.chords[1].chord.root.note, 'C');
        assert_eq!(bar0.chords[2].kind, BarChordKind::SlashRepeat);
        assert_eq!(bar0.chords[2].chord.root.note, 'C');
        assert_eq!(bar0.chords[3].kind, BarChordKind::Played);
        assert_eq!(bar0.chords[3].chord.root.note, 'F');
    }

    #[test]
    fn pause_slash_orphan_at_start_of_song_is_dropped() {
        // `|pC7|` — orphan `p` with no preceding chord. Per the spec
        // and the parser's defensive policy, the slash is dropped
        // silently rather than emitting a SlashRepeat with no
        // referent.
        let url = "irealbook://Test=A==Style=C=44=[*ApC7|]";
        let song = parse(url).expect("parse");
        let bar0 = &song.sections[0].bars[0];
        assert_eq!(
            bar0.chords.len(),
            1,
            "orphan pause-slash must not emit a chord entry"
        );
        assert_eq!(bar0.chords[0].kind, BarChordKind::Played);
        assert_eq!(bar0.chords[0].chord.root.note, 'C');
    }

    #[test]
    fn alternate_after_pause_slash_attaches_to_played_chord_not_slash() {
        // `|C7p(D7)|` — the `(D7)` alternate-chord paren follows a
        // pause-slash. Without the fix on `push_chord`'s in_alternate
        // branch, the alternate attaches to the SlashRepeat at
        // index 1 (via `chords.last_mut()`), which is never painted
        // because the renderer paints `/` for SlashRepeat. With the
        // fix, the alternate attaches to the Played C7 at index 0,
        // where consumers can see it.
        let url = "irealbook://Test=A==Style=C=44=[*AC7p(D7)|]";
        let song = parse(url).expect("parse");
        let bar0 = &song.sections[0].bars[0];
        // 2 entries: Played C7 + SlashRepeat snapshot.
        assert_eq!(bar0.chords.len(), 2);
        assert_eq!(bar0.chords[0].kind, BarChordKind::Played);
        assert_eq!(bar0.chords[0].chord.root.note, 'C');
        let alt = bar0.chords[0]
            .chord
            .alternate
            .as_deref()
            .expect("alternate must attach to the Played C7, not the SlashRepeat");
        assert_eq!(alt.root.note, 'D');
        assert_eq!(bar0.chords[1].kind, BarChordKind::SlashRepeat);
        // The SlashRepeat snapshot must NOT carry the alternate;
        // it predates the `(D7)` paren in parse order.
        assert!(
            bar0.chords[1].chord.alternate.is_none(),
            "SlashRepeat snapshot must not absorb the alternate"
        );
    }

    #[test]
    fn pause_slash_across_bar_boundary_carries_previous_bar_chord() {
        // `|C7|p|F7|` — the slash sits in a new bar, repeating the
        // chord from the previous bar. Tests that `most_recent_chord`
        // walks back across the bar boundary into the section's
        // committed bars.
        let url = "irealbook://Test=A==Style=C=44=[*AC7|p|F7|]";
        let song = parse(url).expect("parse");
        let bars = &song.sections[0].bars;
        assert!(bars.len() >= 3, "expected at least 3 bars, got {bars:?}");
        assert_eq!(bars[1].chords.len(), 1, "middle bar carries one slash");
        assert_eq!(bars[1].chords[0].kind, BarChordKind::SlashRepeat);
        assert_eq!(bars[1].chords[0].chord.root.note, 'C');
    }

    #[test]
    fn pause_slash_inside_alternate_paren_is_dropped() {
        // `|C7(p)|` — a `p` token that appears inside an `(...)`
        // alternate-chord paren. The paren scope means the parser is
        // looking for an alternate chord string, not a beat slot;
        // `p` is not a valid chord root and has no meaning there.
        // The parser sets `in_alternate = true` before entering the
        // paren so the `if !state.in_alternate` guard drops the `p`
        // without emitting a `SlashRepeat`. This test covers the
        // `in_alternate == true` branch in the `p` handler to close
        // the Codecov gap on that line.
        let url = "irealbook://Test=A==Style=C=44=[*AC7(p)|]";
        let song = parse(url).expect("parse");
        let bar0 = &song.sections[0].bars[0];
        // Only the primary C7 chord should be present — no SlashRepeat
        // entry, and no spurious chord from the `p` inside the paren.
        assert_eq!(
            bar0.chords.len(),
            1,
            "p inside alternate paren must not emit a chord entry"
        );
        assert_eq!(bar0.chords[0].kind, BarChordKind::Played);
        assert_eq!(bar0.chords[0].chord.root.note, 'C');
        // The `(p)` paren did not produce a valid alternate chord —
        // no alternate should be attached to C7.
        assert!(
            bar0.chords[0].chord.alternate.is_none(),
            "p inside alternate paren must not create an alternate chord"
        );
    }

    #[test]
    fn staff_text_populates_when_not_a_macro() {
        // `<13 measure lead break>` is a free-form caption — should
        // land in `staff_texts`, NOT trigger any macro symbol.
        let url = "irealbook://Test=A==Style=C=44=[*A<13 measure lead break>C|D|]";
        let song = parse(url).expect("parse");
        let bar0 = &song.sections[0].bars[0];
        assert_eq!(
            bar0.staff_texts,
            vec![StaffText::plain("13 measure lead break")]
        );
        assert!(
            bar0.symbol.is_none(),
            "non-macro caption must not set symbol"
        );
    }

    #[test]
    fn staff_text_with_dc_macro_sets_structured_symbol_and_skips_text() {
        // Post-#2427: an exact-match spec phrase fills the
        // structured `MusicalSymbol::DaCapo(JumpTarget)` AND skips
        // staff_texts. The serializer re-emits the phrase from
        // the symbol alone, so duplicating into staff_texts would
        // round-trip into a doubled output.
        let url = "irealbook://Test=A==Style=C=44=[*A<D.C. al Coda>C|D|]";
        let song = parse(url).expect("parse");
        let bar0 = &song.sections[0].bars[0];
        assert_eq!(bar0.symbol, Some(MusicalSymbol::DaCapo(JumpTarget::AlCoda)));
        assert!(
            bar0.staff_texts.is_empty(),
            "exact-match macro must not duplicate into staff_texts"
        );
    }

    #[test]
    fn bare_macro_uses_unspecified_jump_target() {
        // `<D.C.>` → DaCapo(Unspecified), no staff_texts. The bare
        // legacy form is preserved as a first-class variant rather
        // than being collapsed into the `staff_texts` fallback so
        // the renderer can paint it identically to the spec phrases.
        let url = "irealbook://Test=A==Style=C=44=[*A<D.C.>C|D|]";
        let song = parse(url).expect("parse");
        let bar0 = &song.sections[0].bars[0];
        assert_eq!(
            bar0.symbol,
            Some(MusicalSymbol::DaCapo(JumpTarget::Unspecified))
        );
        assert!(bar0.staff_texts.is_empty());
    }

    #[test]
    fn unrecognised_macro_spelling_falls_through_to_staff_text() {
        // `<D.C. on Cue>` doesn't match either the canonical `al
        // ...` grammar or the bare `D.C.` form (the trailing `on
        // Cue` is free-form), so it round-trips as text only.
        let url = "irealbook://Test=A==Style=C=44=[*A<D.C. on Cue>C|D|]";
        let song = parse(url).expect("parse");
        let bar0 = &song.sections[0].bars[0];
        assert_eq!(bar0.staff_texts, vec![StaffText::plain("D.C. on Cue")]);
        assert!(
            bar0.symbol.is_none(),
            "free-form D.C./D.S. caption must NOT fire a macro symbol"
        );
    }

    #[test]
    fn eleven_spec_phrases_round_trip_through_classifier() {
        // Locks every player-recognised phrase from
        // <https://www.irealpro.com/ireal-pro-custom-chord-chart-protocol>
        // through `apply_comment` so a future refactor that drops
        // a spec arm fails loudly. Pairs with the AST
        // `canonical_text_covers_eleven_spec_phrases_plus_bare_forms`
        // test that locks the inverse direction.
        let cases: [(&str, MusicalSymbol); 11] = [
            (
                "[*A<D.C. al Coda>C|D|]",
                MusicalSymbol::DaCapo(JumpTarget::AlCoda),
            ),
            (
                "[*A<D.C. al Fine>C|D|]",
                MusicalSymbol::DaCapo(JumpTarget::AlFine),
            ),
            (
                "[*A<D.C. al 1st End.>C|D|]",
                MusicalSymbol::DaCapo(JumpTarget::AlEnding(std::num::NonZeroU8::new(1).unwrap())),
            ),
            (
                "[*A<D.C. al 2nd End.>C|D|]",
                MusicalSymbol::DaCapo(JumpTarget::AlEnding(std::num::NonZeroU8::new(2).unwrap())),
            ),
            (
                "[*A<D.C. al 3rd End.>C|D|]",
                MusicalSymbol::DaCapo(JumpTarget::AlEnding(std::num::NonZeroU8::new(3).unwrap())),
            ),
            (
                "[*A<D.S. al Coda>C|D|]",
                MusicalSymbol::DalSegno(JumpTarget::AlCoda),
            ),
            (
                "[*A<D.S. al Fine>C|D|]",
                MusicalSymbol::DalSegno(JumpTarget::AlFine),
            ),
            (
                "[*A<D.S. al 1st End.>C|D|]",
                MusicalSymbol::DalSegno(JumpTarget::AlEnding(std::num::NonZeroU8::new(1).unwrap())),
            ),
            (
                "[*A<D.S. al 2nd End.>C|D|]",
                MusicalSymbol::DalSegno(JumpTarget::AlEnding(std::num::NonZeroU8::new(2).unwrap())),
            ),
            (
                "[*A<D.S. al 3rd End.>C|D|]",
                MusicalSymbol::DalSegno(JumpTarget::AlEnding(std::num::NonZeroU8::new(3).unwrap())),
            ),
            ("[*A<Fine>C|D|]", MusicalSymbol::Fine),
        ];
        for (body, expected) in cases {
            let url = format!("irealbook://Test=A==Style=C=44={body}");
            let song = parse(&url).unwrap_or_else(|e| panic!("parse {url}: {e:?}"));
            let bar0 = &song.sections[0].bars[0];
            assert_eq!(
                bar0.symbol,
                Some(expected),
                "URL `{url}` should produce {expected:?}"
            );
            assert!(
                bar0.staff_texts.is_empty(),
                "URL `{url}`: spec-phrase match must not write staff_texts"
            );
        }
    }

    #[test]
    fn macro_classifier_is_case_and_whitespace_tolerant() {
        // The spec phrases land regardless of casing; internal
        // whitespace runs collapse to a single space. This is
        // load-bearing because users hand-author URLs with
        // inconsistent capitalisation.
        let url = "irealbook://Test=A==Style=C=44=[*A<d.c.  AL   coda>C|D|]";
        let song = parse(url).expect("parse");
        let bar0 = &song.sections[0].bars[0];
        assert_eq!(bar0.symbol, Some(MusicalSymbol::DaCapo(JumpTarget::AlCoda)));
    }

    #[test]
    fn macro_classifier_accepts_ending_synonyms() {
        // Real iReal Pro exports use `Ending` / `End` informally
        // (pianosnake's tester corpus has `D.C. al 3rd Ending`).
        // All three spellings — `End.` (spec), `End`, `Ending` —
        // resolve to the same `AlEnding(n)` variant; the canonical
        // `End.` form is what the serializer re-emits. Both D.C.
        // and D.S. families MUST accept all three (sister-site
        // discipline per `.claude/rules/fix-propagation.md`).
        let nz = |n: u8| std::num::NonZeroU8::new(n).unwrap();
        let cases: &[(&str, MusicalSymbol)] = &[
            (
                "D.C. al 1st End.",
                MusicalSymbol::DaCapo(JumpTarget::AlEnding(nz(1))),
            ),
            (
                "D.C. al 2nd End",
                MusicalSymbol::DaCapo(JumpTarget::AlEnding(nz(2))),
            ),
            (
                "D.C. al 3rd Ending",
                MusicalSymbol::DaCapo(JumpTarget::AlEnding(nz(3))),
            ),
            (
                "D.S. al 1st End.",
                MusicalSymbol::DalSegno(JumpTarget::AlEnding(nz(1))),
            ),
            (
                "D.S. al 2nd End",
                MusicalSymbol::DalSegno(JumpTarget::AlEnding(nz(2))),
            ),
            (
                "D.S. al 3rd Ending",
                MusicalSymbol::DalSegno(JumpTarget::AlEnding(nz(3))),
            ),
        ];
        for (caption, expected) in cases {
            let url = format!("irealbook://Test=A==Style=C=44=[*A<{caption}>C|D|]");
            let song = parse(&url).unwrap_or_else(|e| panic!("parse {url}: {e:?}"));
            let bar0 = &song.sections[0].bars[0];
            assert_eq!(
                bar0.symbol,
                Some(*expected),
                "caption `{caption}` should resolve to {expected:?}"
            );
            assert!(
                bar0.staff_texts.is_empty(),
                "caption `{caption}` should NOT leave any staff_texts"
            );
        }
    }

    #[test]
    fn refine_caption_does_not_trigger_fine_macro() {
        // Regression: substring match treated `refine` as the Fine
        // macro. Anchored detection must reject it.
        let url = "irealbook://Test=A==Style=C=44=[*A<refine the chord>C|D|]";
        let song = parse(url).expect("parse");
        let bar0 = &song.sections[0].bars[0];
        assert_eq!(bar0.staff_texts, vec![StaffText::plain("refine the chord")]);
        assert!(
            bar0.symbol.is_none(),
            "`refine` must NOT set MusicalSymbol::Fine"
        );
    }

    #[test]
    fn unrecognised_dc_ds_phrases_fall_through_to_staff_text() {
        // Every structurally-malformed `D.C. al ...` / `D.S. al ...`
        // tail MUST fall through to `staff_texts` with no symbol
        // attached. Locks the exact-match contract — a future
        // refactor that re-introduces prefix matching would
        // produce spurious DaCapo/DalSegno symbols on these
        // captions and fail the loop. Mirrors the JSON malformed-
        // input test in `tests/ast.rs`.
        let captions = [
            // Tail doesn't start with `al`.
            "D.C. on Cue",
            // `al` clause with no recognised target.
            "D.C. al unknown",
            // No digit before ordinal suffix.
            "D.C. al th End.",
            // Ordinal-suffix disagrees with number.
            "D.C. al 2st End.",
            "D.S. al 1rd End.",
            // Number with no ordinal suffix at all.
            "D.C. al 1 End.",
            // Zero ordinal (non-zero NonZeroU8 violation).
            "D.C. al 0th End.",
            // Overflow u8.
            "D.S. al 999th End.",
            // `al` clause with non-target tail.
            "D.S. al refining",
        ];
        for caption in captions {
            let url = format!("irealbook://Test=A==Style=C=44=[*A<{caption}>C|D|]");
            let song = parse(&url).unwrap_or_else(|e| panic!("parse `{url}`: {e:?}"));
            let bar0 = &song.sections[0].bars[0];
            assert!(
                bar0.symbol.is_none(),
                "caption `{caption}` must NOT classify as a macro; got symbol={:?}",
                bar0.symbol
            );
            assert_eq!(
                bar0.staff_texts,
                vec![StaffText::plain(caption)],
                "caption `{caption}` must land in staff_texts verbatim"
            );
        }
    }

    #[test]
    fn irealbook_six_field_url_parses_with_explicit_timesig() {
        // 6-field iRealBook URL: Title=Composer=Style=Key=TimeSig=Music.
        let url = "irealbook://Spain=Corea Chick=Medium Samba=B-=44=[*AC|D|E|F]";
        let song = parse(url).expect("parse");
        assert_eq!(song.title, "Spain");
        assert_eq!(song.composer.as_deref(), Some("Corea Chick"));
        assert_eq!(song.style.as_deref(), Some("Medium Samba"));
        assert_eq!(song.time_signature.numerator, 4);
        assert_eq!(song.time_signature.denominator, 4);
        // Tempo and transpose default in the 6-field path.
        assert_eq!(song.tempo, None);
        assert_eq!(song.transpose, 0);
    }

    #[test]
    fn irealbook_six_field_rejects_malformed_timesig() {
        // Sister-site parity with the 7-field path: a malformed
        // numeric field surfaces as `InvalidNumericField` rather
        // than silently falling back to a default.
        let url = "irealbook://Test=A==Style=C=9X=[*AC|D|]";
        match parse(url) {
            Err(ParseError::InvalidNumericField(s)) => {
                assert_eq!(s, "9X");
            }
            other => panic!("expected InvalidNumericField, got {other:?}"),
        }
    }

    #[test]
    fn irealbook_six_field_inline_t_directive_overrides_field_timesig() {
        // The 6-field path documents that an inline `T..`
        // directive in the chord stream overrides the field-level
        // time signature. Field says 4/4, inline says 3/4 — chord
        // stream wins.
        let url = "irealbook://Test=A==Style=C=44=[*AT34C|D|]";
        let song = parse(url).expect("parse");
        assert_eq!(song.time_signature.numerator, 3);
        assert_eq!(song.time_signature.denominator, 4);
    }

    #[test]
    fn r_token_sets_repeat_previous_flag() {
        // `r` (repeat previous TWO measures) currently collapses
        // to the same `repeat_previous = true` flag as `x` / `Kcl`
        // — locked in until the AST grows a separate 2-bar simile
        // marker.
        let url = "irealbook://Test=A==Style=C=44=[*AC| r |D|]";
        let song = parse(url).expect("parse");
        assert!(song.sections[0].bars[1].repeat_previous);
    }

    #[test]
    fn consecutive_endings_keeps_last() {
        // `N1N2` on the same bar: `queue_ending` overwrites, so
        // the second marker wins. This is the documented contract
        // — a future schema change to track multiple endings on
        // one bar would need a deliberate API break.
        let url = "irealbook://Test=A==Style=C=44=[*AN1N2C|D|]";
        let song = parse(url).expect("parse");
        let bar0 = &song.sections[0].bars[0];
        assert_eq!(bar0.ending.and_then(|e| e.number()), Some(2));
    }

    #[test]
    fn n0_token_maps_to_untitled_ending() {
        // Spec token `N0` is the "no text Ending" bracket — the
        // pre-#2436 parser fell through on `Ending::new(0) == None`
        // and dropped the bracket entirely. Locking the AST shape
        // here so regressions resurface as a test failure rather
        // than as silently-lost layout in the SVG renderer.
        let url = "irealbook://Test=A==Style=C=44=[*AN0C|D|]";
        let song = parse(url).expect("parse");
        let bar0 = &song.sections[0].bars[0];
        assert_eq!(bar0.ending, Some(Ending::Untitled));
        assert_eq!(bar0.ending.and_then(|e| e.number()), None);
    }

    #[test]
    fn empty_alternate_parens_does_not_corrupt_state() {
        // `()` between chords is a no-op — the second chord still
        // pushes as a new primary, not an alternate of the first.
        let url = "irealbook://Test=A==Style=C=44=[*AC()|D|]";
        let song = parse(url).expect("parse");
        let bar0 = &song.sections[0].bars[0];
        assert_eq!(bar0.chords.len(), 1);
        assert_eq!(bar0.chords[0].chord.root.note, 'C');
        assert!(bar0.chords[0].chord.alternate.is_none());
    }

    #[test]
    fn alternate_chord_with_slash_bass_parses() {
        // Slash chord inside alt parens — `Em7(C/G)`.
        let url = "irealbook://Test=A==Style=C=44=[*AE-7(C/G)|D|]";
        let song = parse(url).expect("parse");
        let chord = &song.sections[0].bars[0].chords[0].chord;
        let alt = chord.alternate.as_ref().expect("alternate present");
        assert_eq!(alt.root.note, 'C');
        assert_eq!(alt.bass.map(|b| b.note), Some('G'));
    }

    // ---- Section-label vocabulary (#2432, #2450) ------------------

    #[test]
    fn section_marker_uppercase_v_maps_to_verse() {
        // Spec lists `*V` uppercase. Was `Letter('V')` before
        // #2432.
        let url = "irealbook://Test=A==Style=C=44=[*VC|D|]";
        let song = parse(url).expect("parse");
        assert_eq!(song.sections[0].label, SectionLabel::Verse);
    }

    #[test]
    fn section_marker_lowercase_v_maps_to_verse() {
        // Backwards-compat: hand-edited URLs may use `*v`.
        let url = "irealbook://Test=A==Style=C=44=[*vC|D|]";
        let song = parse(url).expect("parse");
        assert_eq!(song.sections[0].label, SectionLabel::Verse);
    }

    #[test]
    fn section_marker_uppercase_i_maps_to_intro() {
        let url = "irealbook://Test=A==Style=C=44=[*IC|D|]";
        let song = parse(url).expect("parse");
        assert_eq!(song.sections[0].label, SectionLabel::Intro);
    }

    #[test]
    fn section_marker_lowercase_i_maps_to_intro() {
        let url = "irealbook://Test=A==Style=C=44=[*iC|D|]";
        let song = parse(url).expect("parse");
        assert_eq!(song.sections[0].label, SectionLabel::Intro);
    }

    // ---- Vertical-space hint Y / YY / YYY -------------------------

    #[test]
    fn single_y_sets_system_break_space_one() {
        // `Y` immediately before a bar's chord content stamps
        // `system_break_space = 1` on that bar.
        let url = "irealbook://Test=A==Style=C=44=[*AC|YD|E|F]";
        let song = parse(url).expect("parse");
        let bars = &song.sections[0].bars;
        assert_eq!(bars[0].system_break_space, 0, "first bar carries no Y");
        assert_eq!(
            bars[1].system_break_space, 1,
            "bar after `Y` carries system_break_space=1"
        );
        // The chord on the labelled bar must survive.
        assert_eq!(bars[1].chords.len(), 1);
        assert_eq!(bars[1].chords[0].chord.root.note, 'D');
    }

    #[test]
    fn double_y_sets_system_break_space_two() {
        let url = "irealbook://Test=A==Style=C=44=[*AC|YYD|E|F]";
        let song = parse(url).expect("parse");
        assert_eq!(song.sections[0].bars[1].system_break_space, 2);
    }

    #[test]
    fn triple_y_sets_system_break_space_three() {
        let url = "irealbook://Test=A==Style=C=44=[*AC|YYYD|E|F]";
        let song = parse(url).expect("parse");
        assert_eq!(song.sections[0].bars[1].system_break_space, 3);
    }

    #[test]
    fn excess_y_clamps_to_three() {
        // The spec only defines `Y` / `YY` / `YYY`; longer runs
        // clamp at 3 rather than promoting to a wider gap.
        let url = "irealbook://Test=A==Style=C=44=[*AC|YYYYYYD|E|F]";
        let song = parse(url).expect("parse");
        assert_eq!(song.sections[0].bars[1].system_break_space, 3);
    }

    #[test]
    fn trailing_y_without_subsequent_bar_is_dropped() {
        // A `Y` run at the end of the chord stream has no bar to
        // label; the parser drops the empty placeholder rather
        // than leaving an orphaned hint bar in the AST.
        let url = "irealbook://Test=A==Style=C=44=[*AC|D|E|FYY]";
        let song = parse(url).expect("parse");
        // The bar with chord F must be preserved (its barline
        // close `]` finalises it before the trailing Ys are read).
        let last_bar = song
            .sections
            .iter()
            .flat_map(|s| s.bars.iter())
            .last()
            .expect("at least one bar");
        assert_eq!(last_bar.chords[0].chord.root.note, 'F');
        // No bar in the song carries an orphan system_break_space
        // pointing at content that doesn't exist.
        for (i, bar) in song.sections[0].bars.iter().enumerate() {
            if bar.chords.is_empty() {
                assert_eq!(
                    bar.system_break_space, 0,
                    "bar {i} has no chords; system_break_space must be 0"
                );
            }
        }
    }

    #[test]
    fn two_separate_y_runs_on_same_bar_accumulate() {
        // Two Y runs separated by other content but not by a
        // barline both land on the same `current_bar`, so
        // `add_system_break_space` is called twice. The
        // `saturating_add` accumulation must combine them.
        //
        // Chart: `[*AC|Y<text>Y D|]`
        //         bar A has chords C; then a new (Single-start) bar B
        //         is opened by `|`; Y → system_break_space=1; the
        //         `<text>` comment is consumed; second Y → saturating_add(1)
        //         → system_break_space=2; chord D → bar B.
        let url = "irealbook://Test=A==Style=C=44=[*AC|Y<cap>Y D]";
        let song = parse(url).expect("parse");
        let bar_d = song
            .sections
            .iter()
            .flat_map(|s| s.bars.iter())
            .find(|b| b.chords.iter().any(|c| c.chord.root.note == 'D'))
            .expect("bar with chord D must exist");
        assert_eq!(
            bar_d.system_break_space, 2,
            "two separate Y runs must accumulate to 2"
        );
    }

    // ---- Fermata `f` marker (#2431) ------------------------------

    #[test]
    fn f_token_attaches_fermata_to_current_bar() {
        // `f` before a bar's chord content labels that bar with
        // `MusicalSymbol::Fermata` — same attach-to-current-bar
        // contract as `S` / `Q` (see `queue_symbol`).
        let url = "irealbook://Test=A==Style=C=44=[*AC|fD|E|F]";
        let song = parse(url).expect("parse");
        let bars = &song.sections[0].bars;
        assert_eq!(bars[0].symbol, None, "first bar carries no fermata");
        assert_eq!(
            bars[1].symbol,
            Some(MusicalSymbol::Fermata),
            "bar after `f` carries Fermata"
        );
        // The chord on the labelled bar must survive — the `f`
        // branch consumes one character, not the chord that follows.
        assert_eq!(bars[1].chords[0].chord.root.note, 'D');
    }

    #[test]
    fn f_token_does_not_consume_following_chord_letter() {
        // Regression guard: a hypothetical implementation that
        // swallowed `f<chord>` together would drop the chord that
        // shares the bar with the fermata. Lock the per-character
        // dispatch contract.
        let url = "irealbook://Test=A==Style=C=44=[*AfG7|D|]";
        let song = parse(url).expect("parse");
        let bar0 = &song.sections[0].bars[0];
        assert_eq!(bar0.symbol, Some(MusicalSymbol::Fermata));
        assert_eq!(bar0.chords.len(), 1);
        assert_eq!(bar0.chords[0].chord.root.note, 'G');
    }

    #[test]
    fn legacy_lowercase_cbo_section_markers_decay_to_custom() {
        // `*c` / `*b` / `*o` are NOT emitted by iReal Pro per the
        // spec (#2450). The parser previously named them
        // Chorus/Bridge/Outro — that mapping was removed. They now
        // fall through to `Custom(string)`, the same path any
        // unrecognised lowercase letter takes. Locks the new
        // contract so a future revival of the named arms is a
        // deliberate API decision.
        for ch in ['c', 'b', 'o'] {
            let url = format!("irealbook://Test=A==Style=C=44=[*{ch}C|D|]");
            let song = parse(&url).expect("parse");
            assert_eq!(
                song.sections[0].label,
                SectionLabel::Custom(ch.to_string()),
                "expected `*{ch}` to decay to Custom(\"{ch}\"), got {:?}",
                song.sections[0].label,
            );
        }
    }

    // ---- Chord-size markers `s` / `l` (#2433) ---------------------

    #[test]
    fn s_token_stamps_small_size_on_subsequent_chords() {
        // `s` before a chord root sets `ChordSize::Small` on that
        // chord. All chords after `s` until the next `l` are Small.
        let url = "irealbook://Test=A==Style=C=44=[*AsC|D|]";
        let song = parse(url).expect("parse");
        let bars = &song.sections[0].bars;
        assert_eq!(
            bars[0].chords[0].size,
            ChordSize::Small,
            "chord C after `s` must be Small"
        );
        assert_eq!(
            bars[1].chords[0].size,
            ChordSize::Small,
            "chord D in next bar must also be Small (state persists)"
        );
    }

    #[test]
    fn l_token_restores_default_size() {
        // `s` sets Small; `l` restores Default. Chords after `l`
        // are back to Default.
        let url = "irealbook://Test=A==Style=C=44=[*AsC|lD|E|]";
        let song = parse(url).expect("parse");
        let bars = &song.sections[0].bars;
        assert_eq!(bars[0].chords[0].size, ChordSize::Small, "C after `s`");
        assert_eq!(bars[1].chords[0].size, ChordSize::Default, "D after `l`");
        assert_eq!(bars[2].chords[0].size, ChordSize::Default, "E also Default");
    }

    #[test]
    fn chord_size_state_persists_across_bar_boundaries() {
        // The spec says "all the following chord symbols will be
        // narrower until an `l` symbol is encountered". There is no
        // bar-boundary reset — the flag persists.
        let url = "irealbook://Test=A==Style=C=44=[*AsC|D|E|lF]";
        let song = parse(url).expect("parse");
        let bars = &song.sections[0].bars;
        assert_eq!(bars[0].chords[0].size, ChordSize::Small, "C");
        assert_eq!(bars[1].chords[0].size, ChordSize::Small, "D");
        assert_eq!(bars[2].chords[0].size, ChordSize::Small, "E");
        assert_eq!(bars[3].chords[0].size, ChordSize::Default, "F after `l`");
    }

    #[test]
    fn chord_size_state_persists_across_section_boundaries() {
        // Sections are also transparent to the size state — no reset
        // at the `*X` section-start marker.
        let url = "irealbook://Test=A==Style=C=44=[*AsC|D][*BE|lF]";
        let song = parse(url).expect("parse");
        let sec_a = &song.sections[0];
        let sec_b = &song.sections[1];
        assert_eq!(sec_a.bars[0].chords[0].size, ChordSize::Small, "C in A");
        assert_eq!(sec_a.bars[1].chords[0].size, ChordSize::Small, "D in A");
        // The `s` from section A must still be active at the start of B.
        assert_eq!(sec_b.bars[0].chords[0].size, ChordSize::Small, "E in B");
        assert_eq!(
            sec_b.bars[1].chords[0].size,
            ChordSize::Default,
            "F after `l`"
        );
    }

    #[test]
    fn s_token_does_not_consume_following_chord_letter() {
        // `s` is a one-character marker; it must NOT swallow the chord
        // that immediately follows it.
        let url = "irealbook://Test=A==Style=C=44=[*AsG7|D|]";
        let song = parse(url).expect("parse");
        let bar0 = &song.sections[0].bars[0];
        assert_eq!(bar0.chords.len(), 1);
        assert_eq!(bar0.chords[0].chord.root.note, 'G');
        assert_eq!(bar0.chords[0].size, ChordSize::Small);
    }

    // ---- Break macro recognition (#2448) ---------------------------------

    #[test]
    fn break_comment_sets_symbol_and_no_staff_text() {
        // `<Break>` must set `symbol = MusicalSymbol::Break` and leave
        // `staff_texts` empty — the bare-macro suppression branch in
        // `apply_comment` must fire so a subsequent serialize → parse
        // round-trip does not produce a duplicated `<Break>` comment.
        let url = "irealbook://Test=A==Style=C=44=[*A<Break>C|D|]";
        let song = parse(url).expect("parse");
        let bar0 = &song.sections[0].bars[0];
        assert_eq!(bar0.symbol, Some(MusicalSymbol::Break));
        assert!(
            bar0.staff_texts.is_empty(),
            "bare <Break> must not populate staff_texts"
        );
    }

    #[test]
    fn break_with_extra_text_falls_through_to_staff_text_only() {
        // Post-#2427: only the exact `<Break>` phrase fires the
        // structured symbol. `<Break pattern>` is free-form text
        // and lands in `staff_texts` without a symbol — the
        // either-symbol-or-staff-text invariant of the new
        // exact-match contract. Renderers that previously used a
        // symbol+text combination must read staff_texts directly
        // for non-spec captions.
        let url = "irealbook://Test=A==Style=C=44=[*A<Break pattern>C|D|]";
        let song = parse(url).expect("parse");
        let bar0 = &song.sections[0].bars[0];
        assert!(
            bar0.symbol.is_none(),
            "non-spec caption must not fire symbol"
        );
        assert_eq!(bar0.staff_texts, vec![StaffText::plain("Break pattern")]);
    }

    #[test]
    fn breakaway_does_not_trigger_break_macro() {
        // `breakaway` shares the `break` prefix but does NOT match
        // the exact `break` key in `classify_macro_comment`'s match
        // table — the structured rejection means `MusicalSymbol::Break`
        // is not spuriously set.
        let url = "irealbook://Test=A==Style=C=44=[*A<breakaway section>C|D|]";
        let song = parse(url).expect("parse");
        let bar0 = &song.sections[0].bars[0];
        assert!(
            bar0.symbol.is_none(),
            "`breakaway` must NOT set MusicalSymbol::Break"
        );
        assert_eq!(
            bar0.staff_texts,
            vec![StaffText::plain("breakaway section")],
            "non-macro caption must still land in staff_texts"
        );
    }

    // ---- StaffText parsing (#2426) ---------------------------------

    #[test]
    fn staff_text_vertical_position_prefix_parses() {
        // `<*36Solo Section:>` — the two-digit `*XY` prefix raises
        // the caption by 36 units; the remainder is the caption.
        let url = "irealbook://Test=A==Style=C=44=[*A<*36Solo Section:>C|D|]";
        let song = parse(url).expect("parse");
        let bar0 = &song.sections[0].bars[0];
        assert_eq!(
            bar0.staff_texts,
            vec![StaffText::raised("Solo Section:", 36)]
        );
    }

    #[test]
    fn staff_text_repeat_count_parses() {
        // `<8x>` — the `Nx` form is the spec's repeat-count override
        // for the surrounding `{ ... }` block.
        let url = "irealbook://Test=A==Style=C=44=[*A<8x>C|D|]";
        let song = parse(url).expect("parse");
        let bar0 = &song.sections[0].bars[0];
        assert_eq!(
            bar0.staff_texts,
            vec![StaffText::repeat_count(8).expect("8 is non-zero")]
        );
    }

    #[test]
    fn staff_text_repeat_count_accepts_multi_digit() {
        // The spec doesn't pin a digit cap, but the editor permits at
        // least three digits — the AST keeps `u16` so larger
        // hand-authored values still round-trip.
        let url = "irealbook://Test=A==Style=C=44=[*A<128x>C|D|]";
        let song = parse(url).expect("parse");
        let bar0 = &song.sections[0].bars[0];
        assert_eq!(
            bar0.staff_texts,
            vec![StaffText::repeat_count(128).expect("128 is non-zero")]
        );
    }

    #[test]
    fn staff_text_repeat_count_zero_falls_through_to_plain_text() {
        // `<0x>` is structurally `digits + 'x'` but the spec gives
        // it no defined meaning ("play zero times") — the
        // [`StaffText::RepeatCount`] payload is `NonZeroU16`, so
        // the URL token falls through to a plain `Text` entry and
        // round-trips losslessly as `<0x>` text. Locks the
        // non-zero contract documented on `Bar::staff_texts`.
        let url = "irealbook://Test=A==Style=C=44=[*A<0x>C|D|]";
        let song = parse(url).expect("parse");
        let bar0 = &song.sections[0].bars[0];
        assert_eq!(bar0.staff_texts, vec![StaffText::plain("0x")]);
    }

    #[test]
    fn staff_text_repeat_count_u16_overflow_falls_through_to_plain_text() {
        // `<65536x>` overflows `u16::MAX` — `prefix.parse::<u16>()`
        // returns `Err`, the form falls through to plain text, and
        // the original token survives the round trip verbatim. A
        // future refactor that swaps `u16` for `u32` or
        // `saturating_*` would silently change behaviour without
        // this regression test.
        let url = "irealbook://Test=A==Style=C=44=[*A<65536x>C|D|]";
        let song = parse(url).expect("parse");
        let bar0 = &song.sections[0].bars[0];
        assert_eq!(bar0.staff_texts, vec![StaffText::plain("65536x")]);
    }

    #[test]
    fn staff_text_repeat_count_u16_max_round_trips() {
        // `<65535x>` is the largest `<Nx>` form representable in
        // `NonZeroU16` (= `u16::MAX`). Locks the upper boundary
        // alongside the overflow test above.
        let url = "irealbook://Test=A==Style=C=44=[*A<65535x>C|D|]";
        let song = parse(url).expect("parse");
        let bar0 = &song.sections[0].bars[0];
        assert_eq!(
            bar0.staff_texts,
            vec![StaffText::repeat_count(u16::MAX).expect("u16::MAX is non-zero")]
        );
    }

    #[test]
    fn staff_text_lone_x_falls_through_to_plain_text() {
        // `<x>` has no digits before the trailing `x`, so the
        // `!prefix.is_empty()` guard rejects the repeat-count
        // shape and the token falls through to plain text. A
        // future refactor that drops the guard would parse `<x>`
        // as a degenerate repeat count.
        let url = "irealbook://Test=A==Style=C=44=[*A<x>C|D|]";
        let song = parse(url).expect("parse");
        let bar0 = &song.sections[0].bars[0];
        assert_eq!(bar0.staff_texts, vec![StaffText::plain("x")]);
    }

    #[test]
    fn staff_text_empty_body_produces_no_entry() {
        // `apply_comment` short-circuits on `trimmed.is_empty()`
        // before calling `classify_staff_text`. The bar gets no
        // staff_text entry. A regression that dropped the early
        // return would produce a zero-width caption.
        let url = "irealbook://Test=A==Style=C=44=[*A<>C|D|]";
        let song = parse(url).expect("parse");
        let bar0 = &song.sections[0].bars[0];
        assert!(bar0.staff_texts.is_empty(), "got {:?}", bar0.staff_texts);
    }

    #[test]
    fn staff_text_vertical_position_zero_and_seventy_four_boundary() {
        // Locks the inclusive `0..=74` bound — both endpoints
        // produce a vertically-positioned caption, not a fall
        // through.
        let zero =
            parse("irealbook://Test=A==Style=C=44=[*A<*00caption>C|D|]").expect("parse <*00>");
        assert_eq!(
            zero.sections[0].bars[0].staff_texts,
            vec![StaffText::raised("caption", 0)],
        );
        let seventy_four =
            parse("irealbook://Test=A==Style=C=44=[*A<*74top>C|D|]").expect("parse <*74>");
        assert_eq!(
            seventy_four.sections[0].bars[0].staff_texts,
            vec![StaffText::raised("top", 74)],
        );
    }

    #[test]
    fn staff_text_vertical_position_out_of_range_falls_through() {
        // Spec range is `00..=74`. `*99` is out of range — the parser
        // falls through to plain text so the original token survives
        // the round trip rather than being silently clamped (matches
        // the beat-grouping mismatch fall-through pattern in
        // `compound_time_grouping_rejects_sum_mismatch`).
        let url = "irealbook://Test=A==Style=C=44=[*A<*99text>C|D|]";
        let song = parse(url).expect("parse");
        let bar0 = &song.sections[0].bars[0];
        assert_eq!(bar0.staff_texts, vec![StaffText::plain("*99text")]);
    }

    #[test]
    fn staff_text_vertical_position_single_digit_falls_through() {
        // Spec requires exactly two digits after the `*`. `*9text`
        // (one digit) falls through to plain text.
        let url = "irealbook://Test=A==Style=C=44=[*A<*9text>C|D|]";
        let song = parse(url).expect("parse");
        let bar0 = &song.sections[0].bars[0];
        assert_eq!(bar0.staff_texts, vec![StaffText::plain("*9text")]);
    }

    #[test]
    fn staff_text_vertical_position_multibyte_body_round_trips() {
        // Regression: `<*36さくら>` must not panic on the
        // `split_at(2)` step. The byte-index probe in
        // `classify_staff_text` confirms the two prefix bytes are
        // ASCII digits before slicing, so the body's multi-byte UTF-8
        // characters stay intact.
        let url = "irealbook://Test=A==Style=C=44=[*A<*36さくら>C|D|]";
        let song = parse(url).expect("parse");
        let bar0 = &song.sections[0].bars[0];
        assert_eq!(bar0.staff_texts, vec![StaffText::raised("さくら", 36)]);
    }

    #[test]
    fn multiple_staff_texts_on_one_bar_preserve_order() {
        // Two `<...>` tokens on the same bar produce two entries in
        // source order (previously concatenated with `; `).
        let url = "irealbook://Test=A==Style=C=44=[*A<intro><8x>C|D|]";
        let song = parse(url).expect("parse");
        let bar0 = &song.sections[0].bars[0];
        assert_eq!(
            bar0.staff_texts,
            vec![
                StaffText::plain("intro"),
                StaffText::repeat_count(8).expect("8 is non-zero"),
            ]
        );
    }

    #[test]
    fn multiple_staff_texts_reverse_order_also_preserves() {
        // Companion to the forward-order test above. Swapping the
        // tokens proves the parser preserves arrival order rather
        // than sorting by type. Locks the [`StaffText::RepeatCount`]
        // and [`StaffText::Text`] arrival-order contract from both
        // directions.
        let url = "irealbook://Test=A==Style=C=44=[*A<8x><intro>C|D|]";
        let song = parse(url).expect("parse");
        let bar0 = &song.sections[0].bars[0];
        assert_eq!(
            bar0.staff_texts,
            vec![
                StaffText::repeat_count(8).expect("8 is non-zero"),
                StaffText::plain("intro"),
            ]
        );
    }
}
