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
//! There is no published spec for the iReal Pro URL format. The
//! nearest public reference is the open-source
//! [`pianosnake/ireal-reader`][1] JavaScript parser, which itself
//! cites [`ironss/accompaniser`][2] for the obfuscation
//! algorithm. The Rust port here implements the same algorithm
//! against the same shape of token grammar; round-trip golden
//! tests in `tests/parser.rs` verify the result against
//! known-good fixtures.
//!
//! [1]: https://github.com/pianosnake/ireal-reader
//! [2]: https://github.com/ironss/accompaniser
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
    Accidental, Bar, BarChord, BarLine, BeatPosition, Chord, ChordQuality, ChordRoot, Ending,
    IrealSong, KeyMode, KeySignature, MusicalSymbol, Section, SectionLabel, TimeSignature,
};
use std::fmt;

/// Bytes-after-`irealb://` magic that marks the start of the
/// chord-chart body. Every iReal Pro export prefixes the (still
/// scrambled) chord chart with this constant; the parser strips
/// it before invoking the obfusc50 unscramble.
const MUSIC_PREFIX: &str = "1r34LbKcu7";

/// Hard ceiling on the URL length the parser will accept. iReal
/// Pro exports rarely exceed a few hundred KB even for large
/// collections; the cap keeps an adversarial caller from forcing
/// a multi-gigabyte allocation through repeated `%XX` expansions.
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
    let body = percent_decode(body_encoded)?;
    if body.len() > MAX_INPUT_BYTES {
        return Err(ParseError::InputTooLarge(body.len()));
    }

    // Songs are separated by `===`. iReal also uses the trailing
    // segment after the final `===` as the playlist name when the
    // URL is `irealbook://`; mirror that convention.
    let mut parts: Vec<&str> = body.split("===").collect();

    // pianosnake treats the last `===` segment as the playlist
    // name only when there is more than one part. A single-song
    // `irealb://` URL has no `===` separator, so `parts` has just
    // one element and there is no name.
    let name = if parts.len() > 1 {
        Some(parts.pop().unwrap_or("").to_owned())
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
                    "expected 7..=9 parts, got {n}"
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
            // Treat as an empty bar (the SVG renderer paints a `W`
            // glyph for empty-chord bars; renderers can decide).
            state.finish_bar();
            state.start_new_bar();
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
            // "Repeat previous measure" — stays as-is in the
            // current bar (renderers paint a repeat glyph for the
            // empty-chord bar after we close it).
            rest = r;
            continue;
        }
        if let Some(r) = rest.strip_prefix('r') {
            // "Repeat previous two measures" — same as `x` for
            // structural purposes.
            rest = r;
            continue;
        }
        if let Some(r) = rest.strip_prefix('Y') {
            // Vertical spacer, no AST impact.
            rest = r;
            continue;
        }
        if let Some(r) = rest.strip_prefix('n') {
            // "No Chord" — skip; the AST has no NC variant.
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
    pending_ending: Option<Ending>,
    pending_symbol: Option<MusicalSymbol>,
    last_chord: Option<String>,
    time_signature: TimeSignature,
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

    fn queue_symbol(&mut self, sym: MusicalSymbol) {
        self.pending_symbol = Some(sym);
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

    fn queue_ending(&mut self, ending: Ending) {
        self.pending_ending = Some(ending);
    }

    fn apply_comment(&mut self, comment: &str) {
        let lower = comment.to_ascii_lowercase();
        if lower.contains("d.c.") {
            self.queue_symbol(MusicalSymbol::DaCapo);
        } else if lower.contains("d.s.") {
            self.queue_symbol(MusicalSymbol::DalSegno);
        } else if lower.contains("fine") {
            self.queue_symbol(MusicalSymbol::Fine);
        }
    }

    fn push_chord(&mut self, raw: &str) -> Result<(), ParseError> {
        let resolved = if let Some(after_w) = raw.strip_prefix('W') {
            // `W` is iReal's "invisible slash" — repeat the
            // previous root with this quality. If we have no
            // previous chord, fall back to treating the `W` as a
            // chord root spelling `C` (the JS reference does this
            // implicitly by leaving the `W` in the chord string).
            if let Some(last) = self.last_chord.clone() {
                format!("{}{}", last, after_w)
            } else {
                raw.to_owned()
            }
        } else {
            self.last_chord = Some(strip_slash_bass(raw).to_owned());
            raw.to_owned()
        };
        let chord = parse_chord(&resolved)?;
        let position = BeatPosition::on_beat(1).unwrap();
        self.current_bar.chords.push(BarChord { chord, position });
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
        if let Some(end) = self.pending_ending.take() {
            self.current_bar.ending = Some(end);
        }
        if let Some(sym) = self.pending_symbol.take() {
            self.current_bar.symbol = Some(sym);
        }
    }

    fn finish_bar(&mut self) {
        if self.current_bar.chords.is_empty()
            && self.current_bar.ending.is_none()
            && self.current_bar.symbol.is_none()
            && self.current_bar.start == BarLine::Single
            && self.current_bar.end == BarLine::Single
        {
            // Empty placeholder; drop it. iReal's lexer can leave
            // these between consecutive barlines.
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
    // Lower-case named markers come from iReal's "section name"
    // affordance; upper-case letters are the canonical jazz-form
    // labels. Match the names first so a future single-letter name
    // takes precedence over the catch-all `Letter` arm.
    match c {
        'i' => SectionLabel::Intro,
        'v' => SectionLabel::Verse,
        'c' => SectionLabel::Chorus,
        'b' => SectionLabel::Bridge,
        'o' => SectionLabel::Outro,
        'A'..='Z' => SectionLabel::Letter(c),
        other => SectionLabel::Custom(other.to_string()),
    }
}

fn strip_slash_bass(chord: &str) -> &str {
    chord.split('/').next().unwrap_or(chord)
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
    fn obfusc50_self_inverse_via_assertion() {
        // Sanity: applying it twice produces the input. (Already
        // covered by `obfusc50_is_self_inverse`; left here as a
        // regression marker if `obfusc50_swaps_documented_positions`
        // is later edited without restoring the symmetric carve-out.)
        let chunk: Vec<char> = "abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwx"
            .chars()
            .collect();
        let once = obfusc50(&chunk);
        let twice = obfusc50(&once.chars().collect::<Vec<_>>());
        assert_eq!(twice, chunk.iter().collect::<String>());
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
}
