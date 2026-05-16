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
    Accidental, Bar, BarChord, BarLine, BeatPosition, Chord, ChordQuality, ChordRoot, ChordSize,
    Ending, IrealSong, KeyMode, KeySignature, MusicalSymbol, Section, SectionLabel, TimeSignature,
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
    let chord_chart = parse_chord_chart(music_raw)?;
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

/// Returns `true` when a lowercased, trimmed comment text looks
/// like the iReal Pro macro `prefix` — either the prefix is the
/// entire string, or the prefix is followed by a space / dot
/// (e.g. `d.c.` → matches `"d.c."`, `"d.c. al coda"`, but NOT
/// `"d.c.al"` or `"undefined"`). Used by both the parser's
/// `apply_comment` and the serializer's macro-suppression
/// heuristic so the two stay in sync.
pub(crate) fn matches_macro_prefix(text: &str, prefix: &str) -> bool {
    if !text.starts_with(prefix) {
        return false;
    }
    match text[prefix.len()..].chars().next() {
        None => true,
        Some(' ') => true,
        Some(c) if c.is_alphanumeric() => false,
        Some(_) => true,
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
    let mut state = ChartParseState::new();
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
            // Pause slash — no AST impact.
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
                    if let Some(ending) = Ending::new(digit_value as u8) {
                        state.queue_ending(ending);
                        rest = &after_n[d.len_utf8()..];
                        continue;
                    }
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
}

impl ChartParseState {
    fn new() -> Self {
        Self::default()
    }

    fn set_time_signature(&mut self, ts: TimeSignature) {
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
        let trimmed_lower = comment.trim().to_ascii_lowercase();
        // Detect the recognised musical-direction macros. The
        // matched symbol is set directly on `current_bar` (see
        // `queue_symbol`) — `<D.C.>` / `<D.S.>` / `<Fine>` label
        // the bar that contains the comment. The full verbatim
        // text is ALSO saved to `text_comment` so longer captions
        // like `<D.S. al 2nd ending>` survive the round-trip; the
        // renderer prefers the descriptive text when present, and
        // falls back to the canonical symbol when the bar carries
        // no text.
        //
        // Detection anchors at the START of the comment so common
        // English words that contain the macro substring
        // (`refine`, `define`, `Configuration`) do NOT trigger.
        // iReal Pro emits these directives at the head of the
        // comment by convention; treating them as a substring
        // match was a false-positive vector.
        let is_macro = if matches_macro_prefix(&trimmed_lower, "d.c.") {
            self.queue_symbol(MusicalSymbol::DaCapo);
            true
        } else if matches_macro_prefix(&trimmed_lower, "d.s.") {
            self.queue_symbol(MusicalSymbol::DalSegno);
            true
        } else if matches_macro_prefix(&trimmed_lower, "fine") {
            self.queue_symbol(MusicalSymbol::Fine);
            true
        } else {
            false
        };
        let trimmed = comment.trim();
        if trimmed.is_empty() {
            return;
        }
        // For a bare-macro comment (`<D.C.>`, `<D.S.>`, `<Fine>`)
        // the canonical symbol fully covers the semantics; saving
        // the bare text as `text_comment` would round-trip into a
        // duplicated comment after re-emission. Skip the
        // text_comment write in that case so:
        //
        //   parse(`<D.C.>`)             → bar.symbol = DaCapo
        //   parse(`<D.C. al coda>`)     → bar.symbol = DaCapo,
        //                                 text_comment = "D.C. al coda"
        if is_macro {
            let collapsed: String = trimmed
                .chars()
                .filter(|c| !matches!(c, '.' | ' '))
                .collect();
            let collapsed_lower = collapsed.to_ascii_lowercase();
            if matches!(collapsed_lower.as_str(), "dc" | "ds" | "fine") {
                return;
            }
        }
        let combined = match self.current_bar.text_comment.take() {
            Some(prev) => format!("{prev}; {trimmed}"),
            None => trimmed.to_owned(),
        };
        self.current_bar.text_comment = Some(combined);
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
        // the previous chord's `alternate` rather than as a new
        // chord on the bar. Falls back to a regular push if there
        // is no previous chord (URL malformed — alt without primary).
        if self.in_alternate {
            if let Some(prev) = self.current_bar.chords.last_mut() {
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
        });
        Ok(())
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
    }

    fn finish_bar(&mut self) {
        let is_empty_placeholder = self.current_bar.chords.is_empty()
            && self.current_bar.ending.is_none()
            && self.current_bar.symbol.is_none()
            && !self.current_bar.repeat_previous
            && !self.current_bar.no_chord
            && self.current_bar.text_comment.is_none()
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

    // ---- Macro-prefix detection (anchored, not substring) ----------

    #[test]
    fn matches_macro_prefix_handles_dotted_form() {
        assert!(matches_macro_prefix("d.c.", "d.c."));
        assert!(matches_macro_prefix("d.c. al coda", "d.c."));
        assert!(matches_macro_prefix("d.s. al 2nd ending", "d.s."));
        // Bare macro followed by trailing punctuation.
        assert!(matches_macro_prefix("fine", "fine"));
        assert!(matches_macro_prefix("fine.", "fine"));
    }

    #[test]
    fn matches_macro_prefix_rejects_english_substrings() {
        // The regression these tests guard against: a substring
        // `lower.contains("fine")` happily matched `refine`,
        // `define`, `D.S. defining`, …, leading to spurious
        // `MusicalSymbol::Fine` on the bar.
        assert!(!matches_macro_prefix("refine", "fine"));
        assert!(!matches_macro_prefix("define", "fine"));
        assert!(!matches_macro_prefix("undefined", "fine"));
        assert!(!matches_macro_prefix("13 measure lead break", "fine"));
        // Dotted-form prefixes inside compound text must not fire.
        assert!(!matches_macro_prefix("a d.c. directive", "d.c."));
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
    fn text_comment_populates_when_not_a_macro() {
        // `<13 measure lead break>` is a free-form caption — should
        // land in `text_comment`, NOT trigger any macro symbol.
        let url = "irealbook://Test=A==Style=C=44=[*A<13 measure lead break>C|D|]";
        let song = parse(url).expect("parse");
        let bar0 = &song.sections[0].bars[0];
        assert_eq!(bar0.text_comment.as_deref(), Some("13 measure lead break"));
        assert!(
            bar0.symbol.is_none(),
            "non-macro caption must not set symbol"
        );
    }

    #[test]
    fn text_comment_with_dc_macro_sets_both_symbol_and_text() {
        let url = "irealbook://Test=A==Style=C=44=[*A<D.C. al coda>C|D|]";
        let song = parse(url).expect("parse");
        let bar0 = &song.sections[0].bars[0];
        assert_eq!(bar0.text_comment.as_deref(), Some("D.C. al coda"));
        assert_eq!(bar0.symbol, Some(MusicalSymbol::DaCapo));
    }

    #[test]
    fn bare_macro_skips_text_comment_to_avoid_round_trip_dup() {
        // `<D.C.>` → symbol set, text_comment NOT set. A subsequent
        // serialize re-emits `<D.C.>` (covered by symbol), so saving
        // the text would round-trip into a duplicated entry.
        let url = "irealbook://Test=A==Style=C=44=[*A<D.C.>C|D|]";
        let song = parse(url).expect("parse");
        let bar0 = &song.sections[0].bars[0];
        assert_eq!(bar0.symbol, Some(MusicalSymbol::DaCapo));
        assert!(bar0.text_comment.is_none());
    }

    #[test]
    fn refine_caption_does_not_trigger_fine_macro() {
        // Regression: substring match treated `refine` as the Fine
        // macro. Anchored detection must reject it.
        let url = "irealbook://Test=A==Style=C=44=[*A<refine the chord>C|D|]";
        let song = parse(url).expect("parse");
        let bar0 = &song.sections[0].bars[0];
        assert_eq!(bar0.text_comment.as_deref(), Some("refine the chord"));
        assert!(
            bar0.symbol.is_none(),
            "`refine` must NOT set MusicalSymbol::Fine"
        );
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
        assert_eq!(bar0.ending.map(|e| e.number()), Some(2));
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
}
