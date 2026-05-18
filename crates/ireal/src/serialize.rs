//! `IrealSong` → `irealb://` URL serializer.
//!
//! Produces a URL that, when fed back through
//! [`crate::parse`], yields an [`IrealSong`] equal to the
//! original. Output is **not** byte-identical to the URL the
//! iReal app emitted: the parser drops format tokens with no AST
//! representation (e.g. `XyQ` spacers, `Y+` vertical spacers, the
//! `*X*` closing-`*` sentinel), so the serializer omits them too.
//! AST round-trip is the load-bearing property; URL byte-level
//! round-trip is not.
//!
//! See `crates/ireal/FORMAT.md` for the full grammar and the list
//! of features the parser preserves vs drops.

use crate::ast::{
    Accidental, Bar, BarChordKind, BarLine, BeatGrouping, Chord, ChordQuality, ChordRoot,
    ChordSize, Ending, IrealSong, KeyMode, KeySignature, MusicalSymbol, SectionLabel,
    TimeSignature,
};
use crate::parser::MUSIC_PREFIX;

/// Serializes a single song to an `irealb://` URL.
///
/// The output is the URL form iReal Pro accepts on import. The
/// serializer is the inverse of [`crate::parse`] over the subset
/// of the format the AST models — see `FORMAT.md` for the full
/// grammar.
///
/// # Example
///
/// ```
/// use chordsketch_ireal::{IrealSong, irealb_serialize, parse};
///
/// let song = IrealSong::new();
/// let url = irealb_serialize(&song);
/// assert!(url.starts_with("irealb://"));
/// // Round-trip parses cleanly.
/// let _ = parse(&url).unwrap();
/// ```
#[must_use]
pub fn irealb_serialize(song: &IrealSong) -> String {
    let body = serialize_song_body(song);
    // Compute the encoded form first so the URL buffer can be sized
    // from the actual encoded length rather than the raw body length
    // (percent_encode expands non-alphanumeric bytes to 3 chars each).
    let encoded = percent_encode(&body);
    let mut url = String::with_capacity(encoded.len() + 9);
    url.push_str("irealb://");
    url.push_str(&encoded);
    url
}

/// Serializes a multi-song collection plus an optional playlist
/// name to an `irealbook://` URL.
///
/// Mirrors the iReal app's collection format: songs separated by
/// `===`, with the playlist name as the trailing segment when
/// `name` is `Some`.
#[must_use]
pub fn irealbook_serialize(songs: &[IrealSong], name: Option<&str>) -> String {
    let mut body = String::new();
    for (i, song) in songs.iter().enumerate() {
        if i > 0 {
            body.push_str("===");
        }
        body.push_str(&serialize_song_body(song));
    }
    if let Some(n) = name {
        body.push_str("===");
        body.push_str(n);
    }
    let encoded = percent_encode(&body);
    let mut url = String::with_capacity(encoded.len() + 12);
    url.push_str("irealbook://");
    url.push_str(&encoded);
    url
}

/// Serializes a single song to the **open-protocol** `irealbook://`
/// plain-text URL (#2425).
///
/// Produces the 6-field body documented at
/// <https://www.irealpro.com/ireal-pro-custom-chord-chart-protocol>:
///
/// ```text
/// Title=Composer=Style=Key=TimeSig=Music
/// ```
///
/// Music is plain text (no `MUSIC_PREFIX` sentinel, no `obfusc50`
/// scrambling); TimeSig is the spec's packed-digit form (`44`, `34`,
/// `68`, `128`). The result is percent-encoded for the spec's
/// reserved characters (`=`, space, `{`, `}`, `[`, `]`, `<`, `>`,
/// `,`, `#`, `^`), the `%` sigil, every non-ASCII byte
/// (`>= 0x80`) per RFC 3986, and the HTML-attribute hazards
/// (`"`, `'`, `&`) so the URL is safe to embed inside a quoted
/// `href` attribute.
///
/// The output round-trips back through [`crate::parse`] over the
/// 6-field-`irealbook://` parser arm, with one documented loss:
///
/// # Round-trip limitations
///
/// - **`tempo` and `transpose` are dropped.** The 6-field spec
///   format has no fields for them; only the 7..=9-field `irealb://`
///   export shape carries those values. Use [`irealb_serialize`] if
///   tempo / transpose round-trip matters.
/// - **`=` characters in field values cannot be represented.** The
///   parser splits the decoded body on `=` after URL decoding, so a
///   title containing `=` will fracture the field count. Callers
///   that handle untrusted input should sanitize `=` out of field
///   values before invoking this function (the iReal Pro app does
///   not accept `=` in titles either).
///
/// # HTML embedding
///
/// The percent-encoded output covers the `"`, `'`, `&`, `<`, `>`
/// HTML hazards, so the URL is safe inside a double-quoted or
/// single-quoted `href` attribute. Unquoted `href` attributes
/// still require additional escaping by the consumer (per
/// [WHATWG §13.1.2.3](https://html.spec.whatwg.org/#attributes-2)
/// unquoted attributes have a different escape grammar).
///
/// This is distinct from [`irealb_serialize`] / [`irealbook_serialize`]
/// which target the iReal Pro **export** format (the obfuscated
/// `irealb://` URL the app emits) — those are the inverse of the
/// app's clipboard / email export, while this function is the
/// inverse of the spec's "embed a custom chart in a website" path.
///
/// # Example
///
/// ```
/// use chordsketch_ireal::{IrealSong, parse, serialize_open_protocol};
///
/// let mut song = IrealSong::new();
/// song.title = "Open Protocol Test".to_string();
/// let url = serialize_open_protocol(&song);
/// assert!(url.starts_with("irealbook://"));
/// // Round-trips back to a single-song AST via the 6-field parser arm.
/// let parsed = parse(&url).expect("round trip");
/// assert_eq!(parsed.title, song.title);
/// ```
#[must_use]
pub fn serialize_open_protocol(song: &IrealSong) -> String {
    let body = serialize_open_protocol_body(song);
    let encoded = percent_encode_open_protocol(&body);
    let mut url = String::with_capacity(encoded.len() + 12);
    url.push_str("irealbook://");
    url.push_str(&encoded);
    url
}

/// Serializes a multi-song collection plus an optional playlist
/// name to an open-protocol `irealbook://` URL (#2425).
///
/// Joins each song's 6-field body with a **single** `=` separator
/// (NOT the `===` triple-separator the iReal app uses for its own
/// `irealbook://` export — see [`irealbook_serialize`] for that
/// shape). When `name` is `Some`, it is appended after the final
/// song with a single `=` separator.
///
/// # Round-trip limitation
///
/// The open-protocol single-`=` collection shape is NOT consumed
/// by [`crate::parse_collection`], which expects the iReal app's
/// `===`-separated collection format. The single-`=` form is the
/// shape the spec's worked example uses for embedding in HTML; use
/// [`irealbook_serialize`] when you need a collection that
/// round-trips back through this library.
#[must_use]
pub fn serialize_open_protocol_collection(songs: &[IrealSong], name: Option<&str>) -> String {
    let mut body = String::new();
    for (i, song) in songs.iter().enumerate() {
        if i > 0 {
            body.push('=');
        }
        body.push_str(&serialize_open_protocol_body(song));
    }
    if let Some(n) = name {
        body.push('=');
        body.push_str(n);
    }
    let encoded = percent_encode_open_protocol(&body);
    let mut url = String::with_capacity(encoded.len() + 12);
    url.push_str("irealbook://");
    url.push_str(&encoded);
    url
}

/// Assembles the 6-field open-protocol body (without percent-encoding).
///
/// Shape: `Title=Composer=Style=Key=TimeSig=Music`, where
/// `TimeSig` is the packed-digit form (`44`, `34`, `68`, `128`) and
/// `Music` is plain-text chord chart with no `MUSIC_PREFIX` sentinel
/// and no `obfusc50` scrambling. Empty / `None` metadata fields use
/// the same placeholders as the `irealb://` export path so a
/// 6-field count is preserved.
fn serialize_open_protocol_body(song: &IrealSong) -> String {
    let title: &str = if song.title.trim().is_empty() {
        TITLE_PLACEHOLDER
    } else {
        &song.title
    };
    let composer = match song.composer.as_deref() {
        Some(s) if !s.trim().is_empty() => s,
        _ => COMPOSER_PLACEHOLDER,
    };
    let style = match song.style.as_deref() {
        Some(s) if !s.trim().is_empty() => s,
        _ => STYLE_PLACEHOLDER,
    };
    let key = serialize_key(song.key_signature);
    let timesig = serialize_time_signature_packed(song.time_signature);
    let music = serialize_open_protocol_music(song);
    let mut body = String::with_capacity(
        title.len() + composer.len() + style.len() + key.len() + timesig.len() + music.len() + 5,
    );
    body.push_str(title);
    body.push('=');
    body.push_str(composer);
    body.push('=');
    body.push_str(style);
    body.push('=');
    body.push_str(&key);
    body.push('=');
    body.push_str(&timesig);
    body.push('=');
    body.push_str(&music);
    body
}

/// Serializes the chord chart to plain text for the open-protocol
/// field 6 — no `MUSIC_PREFIX` sentinel, no `obfusc50` scrambling.
///
/// The chord stream keeps the leading `T<numerator><denominator>`
/// time-signature directive that [`serialize_chord_chart`] emits.
/// That is intentional: the open-protocol body's field 5 also
/// carries the time signature, but a chart with no bars would
/// otherwise emit an empty field 6 and the parser's
/// `filter(|s| !s.is_empty())` would collapse 6 fields down to 5,
/// breaking round-trip. The parser's 6-field arm reads the
/// leading `T..` token as an inline override that must agree with
/// field 5 — so emitting both is structurally safe.
fn serialize_open_protocol_music(song: &IrealSong) -> String {
    serialize_chord_chart(song)
}

/// Packed-digit time signature for the open-protocol field 5.
///
/// Two-digit shapes (`44`, `34`, `68`) for numerator < 10;
/// three-digit (`128`) for numerator >= 10. Mirrors the parser's
/// [`parse_time_signature`] grammar so the result round-trips
/// back into an equal [`TimeSignature`]. The leading `T` glyph the
/// chord-stream embedded form uses is intentionally absent — the
/// open-protocol body has its own dedicated time-signature field.
///
/// Out-of-range numerator / denominator (the public `pub` fields
/// allow this) fall back to the spec's two-digit default `44`.
/// Using `to_string` rather than the `b'0' + n` shortcut avoids a
/// debug-mode arithmetic overflow if a caller hand-constructed a
/// `TimeSignature` with values outside [`TimeSignature::new`]'s
/// validated range (numerator 1..=12, denominator ∈ {2,4,8}).
fn serialize_time_signature_packed(ts: TimeSignature) -> String {
    // Validate against the constructor's contract. A direct
    // public-field mutation that lands outside the validated set
    // produces a chart the parser would reject anyway, so emitting
    // the canonical default here is symmetric with the parser's
    // 4/4 fallback and avoids a debug-mode panic in `b'0' + n` for
    // n >= 206. Documented in `ast.rs` §"Public-field mutation contract".
    let (num, den) = match TimeSignature::new(ts.numerator, ts.denominator) {
        Some(valid) => (valid.numerator, valid.denominator),
        None => (4, 4),
    };
    format!("{num}{den}")
}

/// Percent-encodes for the open-protocol URL body. Encodes:
///
/// 1. The spec's reserved set — `=`, space, `{`, `}`, `[`, `]`,
///    `<`, `>`, `,`, `#`, `^` — per the worked example at
///    <https://www.irealpro.com/ireal-pro-custom-chord-chart-protocol>.
/// 2. The percent sigil `%` itself. Without this, a literal `%` in
///    a title round-trips as a percent escape: `"100% fun"` would
///    decode-back to either a different ASCII character (`%41`
///    → `A`) or a parse error. Encoding `%` is the only way the
///    scheme can be self-describing.
/// 3. Every byte `>= 0x80` (every UTF-8 continuation / lead byte).
///    Browsers and the iReal Pro app's URL handlers both expect
///    `irealbook://` URLs to be ASCII per RFC 3986; passing
///    raw UTF-8 through unencoded corrupts non-ASCII titles,
///    composers, and styles on parser round-trip.
/// 4. The HTML-attribute hazard set `"`, `'`, `&` so the encoded
///    URL is safe to drop into a double- or single-quoted `href`
///    attribute without an additional HTML-escape pass at the
///    caller.
///
/// Encoding the high-bit set rather than the full
/// `is_unreserved` complement keeps the output readable when
/// pasted into chat / email surfaces while still being a valid
/// URL byte sequence. Chord-chart punctuation outside the spec
/// reserved set (`|`, `*`, `:`, `/`, `+`, `-`, `.`) is pure-ASCII
/// and passes through unchanged because both the spec and
/// `decodeURIComponent` accept it verbatim.
///
/// Note: this function intentionally encodes `=` INSIDE field
/// content as `%3D` in addition to the `=` separators added by
/// [`serialize_open_protocol_body`]. After `percent_decode` on the
/// parser side, a content `=` is indistinguishable from a separator
/// `=` (both decode to the same byte before split), so the spec's
/// URL layout cannot represent `=` inside a field value without a
/// pre-validation pass. Callers MUST sanitize `=` out of fields
/// before serializing — `serialize_open_protocol_body` upper-bounds
/// this exposure by emitting placeholders for empty fields, but
/// cannot detect a deliberate `=` in a non-empty field.
fn percent_encode_open_protocol(input: &str) -> String {
    // Worst-case allocation: every byte expands to `%XX` (3 chars).
    // Chord-chart bodies often contain many `[`, `<`, `>`, `=`,
    // space bytes, so `input.len() * 3` avoids repeated
    // reallocations on the hot path.
    let mut out = String::with_capacity(input.len() * 3);
    for b in input.bytes() {
        let must_encode = b >= 0x80
            || matches!(
                b,
                b'=' | b' '
                    | b'{'
                    | b'}'
                    | b'['
                    | b']'
                    | b'<'
                    | b'>'
                    | b','
                    | b'#'
                    | b'^'
                    | b'%'
                    | b'"'
                    | b'\''
                    | b'&'
            );
        if must_encode {
            out.push('%');
            out.push(hex_upper(b >> 4));
            out.push(hex_upper(b & 0x0f));
        } else {
            // Safe ASCII byte — passes through verbatim.
            out.push(b as char);
        }
    }
    out
}

/// Placeholder strings used when a model field is empty / `None`.
///
/// The iReal format relies on `=` as a field separator with the
/// parser's `filter(empty)` pass collapsing duplicate separators
/// — so a literally empty field shrinks the part count below
/// the documented `7..=9` range, breaking round-trip parses.
/// Emitting a known placeholder for `None` / empty preserves the
/// field count on serialize and produces output the parser can
/// re-ingest.
///
/// Round-trip caveat: a song with a `None` composer round-trips to
/// `Some("Composer Unknown")` (not back to `None`); same for
/// style and an empty title. Authors who care about the
/// `None` ↔ `None` distinction should set the field to a
/// meaningful value before serializing. This matches iReal's own
/// behaviour — its own export from a fresh song uses these same
/// placeholder strings.
const TITLE_PLACEHOLDER: &str = "Untitled";
const COMPOSER_PLACEHOLDER: &str = "Composer Unknown";
const STYLE_PLACEHOLDER: &str = "Medium Swing";

fn serialize_song_body(song: &IrealSong) -> String {
    let title: &str = if song.title.trim().is_empty() {
        TITLE_PLACEHOLDER
    } else {
        &song.title
    };
    let composer = match song.composer.as_deref() {
        Some(s) if !s.trim().is_empty() => s,
        _ => COMPOSER_PLACEHOLDER,
    };
    let style = match song.style.as_deref() {
        Some(s) if !s.trim().is_empty() => s,
        _ => STYLE_PLACEHOLDER,
    };
    let key = serialize_key(song.key_signature);
    let music = serialize_music(song);
    // iReal stores `0` to mean "no tempo recorded", and
    // `parse_song` filters Some(0) back to `None`. Emitting `"0"`
    // for `None` preserves the round trip.
    let bpm = song.tempo.unwrap_or(0).to_string();

    // Use the 7-part shape (Title=Composer=Style=Key=Music=BPM=Repeats)
    // when transpose is zero, mirroring iReal's omission of an
    // empty transpose field. The parser accepts both shapes.
    let mut body = String::new();
    body.push_str(title);
    body.push('=');
    body.push_str(composer);
    body.push_str("==");
    body.push_str(style);
    body.push('=');
    body.push_str(&key);
    body.push_str("==");
    if song.transpose != 0 {
        body.push_str(&song.transpose.to_string());
        body.push('=');
    }
    body.push_str(&music);
    body.push_str("==");
    body.push_str(&bpm);
    body.push_str("=0");
    body
}

fn serialize_key(k: KeySignature) -> String {
    let mut s = String::new();
    s.push(if matches!(k.root.note, 'A'..='G') {
        k.root.note
    } else {
        'C'
    });
    match k.root.accidental {
        Accidental::Sharp => s.push('#'),
        Accidental::Flat => s.push('b'),
        Accidental::Natural => {}
    }
    if matches!(k.mode, KeyMode::Minor) {
        s.push('-');
    }
    s
}

fn serialize_music(song: &IrealSong) -> String {
    let chart = serialize_chord_chart(song);
    // The parser strips `MUSIC_PREFIX` after split; the
    // serializer prepends it before applying obfusc50 + assembly.
    let scrambled = obfusc50_apply(&chart);
    let mut music = String::with_capacity(MUSIC_PREFIX.len() + scrambled.len());
    music.push_str(MUSIC_PREFIX);
    music.push_str(&scrambled);
    music
}

/// Produces the plain-text chord chart body (no `MUSIC_PREFIX`
/// sentinel, no `obfusc50` scrambling). This is the chord-stream
/// stage shared by the `irealb://` export pipeline ([`serialize_music`]
/// wraps it with prefix + scrambling) and the open-protocol
/// `irealbook://` plain-text path ([`serialize_open_protocol_music`]
/// uses it verbatim).
fn serialize_chord_chart(song: &IrealSong) -> String {
    let mut chart = String::new();
    serialize_time_signature(&mut chart, song.time_signature);
    // Running chord-size state. Mirrors the parser's
    // `ChartParseState::current_chord_size`: a chord whose size
    // differs from the running state emits an `s` / `l` marker
    // immediately before the chord and updates the running state.
    // Persists across bar boundaries so the spec's "all following
    // chord symbols will be narrower until `l`" semantics survive
    // round-trip without re-emitting a marker on every chord.
    let mut current_size = ChordSize::Default;

    // Compound-time beat-grouping running state (#2449). The
    // parser stamps every bar with the active grouping, so a
    // verbatim round-trip would emit `<a+b>` on every bar — but
    // the spec only emits the override once per change. Tracking
    // the previously-emitted grouping lets the serializer emit a
    // `<a+b>` token only when the grouping differs from the prior
    // bar, matching how the iReal Pro player consumes the
    // directive ("remains until the opposite is used").
    let mut current_grouping: Option<BeatGrouping> = None;

    // Flatten all bars across sections so the serializer can peek
    // the *next* bar regardless of section boundary. This is
    // load-bearing for round trips: the parser's `pending_symbol`
    // is consumed by `start_new_bar`, so a symbol on bar N must
    // be queued before bar N-1's closing barline. Endings, in
    // contrast, are written by the parser onto `current_bar`
    // immediately, so they are emitted AFTER the previous bar's
    // close glyph (see the post-`serialize_bar_close` block below).
    // Looking ahead within a section is not enough — symbols /
    // endings can land on the first bar of a new section too.
    struct FlatBar<'a> {
        section_label: Option<&'a SectionLabel>,
        bar: &'a Bar,
    }
    let mut flat: Vec<FlatBar<'_>> =
        Vec::with_capacity(song.sections.iter().map(|s| s.bars.len()).sum());
    for section in &song.sections {
        for (i, bar) in section.bars.iter().enumerate() {
            flat.push(FlatBar {
                section_label: if i == 0 { Some(&section.label) } else { None },
                bar,
            });
        }
    }

    for i in 0..flat.len() {
        let entry = &flat[i];
        let bar = entry.bar;

        // Emit the section label before any bar content. The
        // parser consumes `pending_section_label` in
        // `finish_bar`, so the label queued before this bar's
        // closing `|` lands the bar in the new section — exactly
        // what we want for the section's first bar.
        if let Some(label) = entry.section_label {
            serialize_section_label(&mut chart, label);
        }

        // Non-Single starts (`[`, `{`, `Z`) emit a token; the
        // ending marker must appear before that token so that the
        // bar carries it. Symbols are emitted INSIDE the bar's
        // content area now (after the open glyph), so the parser's
        // `queue_symbol` lands them on `current_bar` rather than
        // a phantom previous bar.
        if bar.start != BarLine::Single {
            if let Some(end) = bar.ending {
                serialize_ending(&mut chart, end);
            }
        }
        // A repeat-previous bar collapses to the `Kcl` token. The
        // parser handles `Kcl` as `finish_bar` + `start_new_bar` +
        // mark the new bar with `repeat_previous = true`. After the
        // `Kcl` token, the bar's right-edge barline (`|`, `Z`, `]`,
        // `}`) still needs to be emitted so that a non-Single end
        // round-trips. The next-bar symbol lookahead applies to
        // single-start neighbours just like any other bar.
        // Helper closure: detect whether a bar's text_comment
        // already encodes a structured macro symbol on re-parse,
        // so we can skip emitting a redundant `<D.C.>` /
        // `<D.S.>` / `<Fine>` pseudo-comment.
        //
        // Routes through the same exact-phrase classifier the
        // parser uses (`classify_macro_comment`) so the
        // serializer's "is this redundant?" decision agrees
        // bit-for-bit with the parser's "did the comment land in
        // bar.symbol?" decision. A previous prefix-match heuristic
        // diverged from the parser after #2427 introduced
        // exact-match classification — that asymmetry would have
        // silently dropped a `bar.symbol` set on a bar whose
        // `text_comment` looked like (but did not exact-match) a
        // macro phrase (e.g. symbol = DaCapo(AlCoda) +
        // text_comment = "D.C. on Cue"). Sister-site discipline
        // per `.claude/rules/fix-propagation.md`.
        let text_carries_macro = |b: &Bar| {
            b.text_comment
                .as_deref()
                .map(|t| crate::parser::classify_macro_comment(t.trim()).is_some())
                .unwrap_or(false)
        };

        if bar.repeat_previous {
            chart.push_str("Kcl");
            // Vertical-space hint sits AFTER the `Kcl` token so the
            // parser's `Y`-counting branch stamps `system_break_space`
            // on the bar that `Kcl` just opened, not on the preceding
            // empty-placeholder bar (which the parser drops, losing the
            // hint). Clamped to 3 to mirror the parser's saturating cap.
            if bar.system_break_space > 0 {
                let count = bar.system_break_space.min(3);
                for _ in 0..count {
                    chart.push('Y');
                }
            }
            if !text_carries_macro(bar) {
                if let Some(sym) = bar.symbol {
                    serialize_symbol(&mut chart, sym);
                }
            }
            if let Some(text) = &bar.text_comment {
                emit_text_comment(&mut chart, text);
            }
            serialize_bar_close(&mut chart, bar);
            if let Some(next) = flat.get(i + 1) {
                if next.bar.start == BarLine::Single {
                    if let Some(end) = next.bar.ending {
                        serialize_ending(&mut chart, end);
                    }
                }
            }
            continue;
        }

        serialize_bar_open(&mut chart, bar);

        // Vertical-space hint sits AFTER the bar-open glyph (`[`, `{`,
        // or nothing for Single) so the parser's `Y`-counting branch
        // stamps `system_break_space` on the bar that `serialize_bar_open`
        // just started, not on the preceding empty-placeholder bar (which
        // the parser drops, losing the hint). Clamped to 3 to mirror the
        // parser's saturating cap; values past the cap are absorbed
        // silently (matches the parser's behaviour for AST-constructed
        // values past the documented range).
        if bar.system_break_space > 0 {
            let count = bar.system_break_space.min(3);
            for _ in 0..count {
                chart.push('Y');
            }
        }

        // Symbol for THIS bar, emitted INSIDE the bar's content
        // area so the parser's `queue_symbol` (which now sets
        // `current_bar.symbol` directly) lands it on this bar.
        // Skip when the bar's own text_comment will carry an
        // equivalent macro substring on re-parse.
        if !text_carries_macro(bar) {
            if let Some(sym) = bar.symbol {
                serialize_symbol(&mut chart, sym);
            }
        }

        if bar.no_chord {
            // `n` is the iReal Pro "No Chord" marker — paints `N.C.`
            // in the bar's centre. Emit before any chord content so
            // the parser's `n`-handler hits before chord parsing.
            chart.push('n');
        }

        // Emit `<a+b>` compound-time grouping (#2449) only when
        // the bar's grouping differs from the previously-emitted
        // state. The parser stamps every bar from the override
        // forward with the running grouping, so a verbatim re-emit
        // would duplicate the directive on every bar; only the
        // change point carries the token. The transitions:
        //
        //   None → None             — no emit (no override either side).
        //   Some(g) → Some(g)       — no emit (override unchanged).
        //   None → Some(g)          — emit `<a+b>` for `g`.
        //   Some(g) → Some(h≠g)     — emit `<a+b>` for `h`.
        //   Some(g) → None          — internal state advances to
        //                             None but emits NO token. The
        //                             iReal Pro URL grammar has no
        //                             "reset grouping" sigil; the
        //                             only way to clear a running
        //                             grouping is to change the
        //                             time signature (a `T..`
        //                             token mid-chart resets it
        //                             on the parser side too).
        //                             A hand-constructed AST that
        //                             clears the override without a
        //                             meter change will therefore
        //                             produce a URL where the
        //                             grouping persists on round
        //                             trip; this is a known
        //                             format limitation, not a
        //                             serializer bug.
        if bar.beat_grouping_override != current_grouping {
            if let Some(grouping) = &bar.beat_grouping_override {
                chart.push('<');
                let mut first = true;
                for part in grouping.parts() {
                    if !first {
                        chart.push('+');
                    }
                    first = false;
                    chart.push_str(&part.get().to_string());
                }
                chart.push('>');
            }
            current_grouping = bar.beat_grouping_override.clone();
        }

        // Bar contents.
        for (ci, bc) in bar.chords.iter().enumerate() {
            if ci > 0 {
                chart.push(' ');
            }
            if bc.size != current_size {
                // Emit the size-mode transition marker immediately
                // before the chord. Inside a bar the space separator
                // above guarantees the marker can never be absorbed
                // into the previous chord's quality string; at bar
                // boundaries the right-edge barline glyph provides
                // the same isolation.
                chart.push(match bc.size {
                    ChordSize::Small => 's',
                    ChordSize::Default => 'l',
                });
                current_size = bc.size;
            }
            match bc.kind {
                BarChordKind::Played => serialize_chord(&mut chart, &bc.chord),
                // Pause-slash — the snapshot chord in `bc.chord` is
                // not emitted; the `p` token tells the iReal Pro
                // player to hold the previous chord at this beat.
                BarChordKind::SlashRepeat => chart.push('p'),
            }
        }

        if let Some(text) = &bar.text_comment {
            // Free-form text comment renders below the bar's right
            // barline. The `<...>` form is what the parser's
            // `apply_comment` consumes. Use the `>`-stripping
            // helper so the regular-bar path inherits the same
            // round-trip protection as the `repeat_previous`
            // branch above (sister-site parity per
            // `.claude/rules/fix-propagation.md`).
            emit_text_comment(&mut chart, text);
        }

        serialize_bar_close(&mut chart, bar);

        if let Some(next) = flat.get(i + 1) {
            if next.bar.start == BarLine::Single {
                if let Some(end) = next.bar.ending {
                    serialize_ending(&mut chart, end);
                }
            }
        }
    }
    chart
}

fn serialize_time_signature(out: &mut String, ts: TimeSignature) {
    if ts.numerator == 0 || ts.denominator == 0 {
        return;
    }
    out.push('T');
    if ts.numerator >= 10 {
        // Two-digit numerator (e.g. 12/8 → T128).
        out.push_str(&ts.numerator.to_string());
        out.push_str(&ts.denominator.to_string());
    } else {
        out.push(char::from(b'0' + ts.numerator));
        out.push(char::from(b'0' + ts.denominator));
    }
}

fn serialize_section_label(out: &mut String, label: &SectionLabel) {
    out.push('*');
    match label {
        SectionLabel::Letter(c) => out.push(*c),
        // The iReal Pro spec emits `*V` uppercase for Verse and
        // `*i` lowercase for Intro (#2432, #2450). Round-trip
        // through the parser's case-insensitive handling.
        SectionLabel::Verse => out.push('V'),
        SectionLabel::Intro => out.push('i'),
        SectionLabel::Custom(s) => {
            // The parser only consumes a single char after `*`,
            // so multi-char custom labels would not round-trip
            // cleanly. Emit the first char and accept the
            // truncation — this mirrors the parser's input contract.
            if let Some(c) = s.chars().next() {
                out.push(c);
            }
        }
    }
}

fn serialize_bar_open(out: &mut String, bar: &Bar) {
    match bar.start {
        BarLine::Single => {} // bar's left edge inherits from the previous bar
        BarLine::Double => out.push('['),
        // `Final` and `CloseRepeat` as a bar *start* never arise from
        // parser-produced ASTs (the parser's `start_new_bar` only sets
        // start to `OpenRepeat` or `Double`). These arms exist so the
        // match is exhaustive; the emitted glyphs are best-effort for
        // manually-constructed ASTs and do not guarantee a round-trip.
        BarLine::Final => out.push('Z'),
        BarLine::OpenRepeat => out.push('{'),
        BarLine::CloseRepeat => out.push('}'),
    }
}

fn serialize_bar_close(out: &mut String, bar: &Bar) {
    match bar.end {
        BarLine::Single => out.push('|'),
        BarLine::Double => out.push(']'),
        BarLine::Final => out.push('Z'),
        BarLine::OpenRepeat => out.push('|'), // unreachable in practice
        BarLine::CloseRepeat => out.push('}'),
    }
}

fn serialize_ending(out: &mut String, ending: Ending) {
    out.push('N');
    let digit = match ending {
        Ending::Numbered(n) => n.get(),
        Ending::Untitled => 0,
    };
    out.push(char::from(b'0' + digit));
}

fn serialize_symbol(out: &mut String, symbol: MusicalSymbol) {
    match symbol {
        MusicalSymbol::Segno => out.push('S'),
        MusicalSymbol::Coda => out.push('Q'),
        MusicalSymbol::Fermata => out.push('f'),
        // The D.C. / D.S. / Fine / Break family round-trips through
        // `canonical_text` — the same table powers the renderer's
        // text-directive paint and the convert-crate's ChordPro
        // label, per `.claude/rules/renderer-parity.md`.
        sym @ (MusicalSymbol::DaCapo(_)
        | MusicalSymbol::DalSegno(_)
        | MusicalSymbol::Fine
        | MusicalSymbol::Break) => {
            let text = sym
                .canonical_text()
                .expect("D.C./D.S./Fine/Break always have canonical text");
            out.push('<');
            out.push_str(&text);
            out.push('>');
        }
    }
}

/// Emit a `<...>` comment, stripping the `>` delimiter character
/// from the body. The iReal Pro chord stream uses `<` / `>` as
/// the comment-block delimiters and the parser's `find('>')`
/// would terminate prematurely on the first inner `>`,
/// truncating the round-trip. `<` is safe inside the body — the
/// parser captures up to the FIRST closing `>`, so a leading `<`
/// stays inside the comment text. The replacement is intentional
/// rather than rejecting outright: callers that constructed an
/// AST manually (per the public-field contract in `ast.rs`)
/// shouldn't have their chart silently fail to serialize, but
/// they will lose any `>` characters they typed.
fn emit_text_comment(out: &mut String, text: &str) {
    out.push('<');
    for ch in text.chars() {
        if ch == '>' {
            continue;
        }
        out.push(ch);
    }
    out.push('>');
}

fn serialize_chord(out: &mut String, chord: &Chord) {
    serialize_root(out, chord.root);
    serialize_quality(out, &chord.quality);
    if let Some(bass) = chord.bass {
        out.push('/');
        serialize_root(out, bass);
    }
    if let Some(alt) = &chord.alternate {
        out.push('(');
        serialize_chord(out, alt);
        out.push(')');
    }
}

fn serialize_root(out: &mut String, root: ChordRoot) {
    out.push(if matches!(root.note, 'A'..='G') {
        root.note
    } else {
        'C'
    });
    match root.accidental {
        Accidental::Sharp => out.push('#'),
        Accidental::Flat => out.push('b'),
        Accidental::Natural => {}
    }
}

fn serialize_quality(out: &mut String, quality: &ChordQuality) {
    let token = match quality {
        ChordQuality::Major => "",
        ChordQuality::Minor => "-",
        ChordQuality::Diminished => "o",
        ChordQuality::Augmented => "+",
        ChordQuality::Major7 => "^7",
        ChordQuality::Minor7 => "-7",
        ChordQuality::Dominant7 => "7",
        ChordQuality::HalfDiminished => "h7",
        ChordQuality::Diminished7 => "o7",
        ChordQuality::Suspended2 => "sus2",
        ChordQuality::Suspended4 => "sus",
        ChordQuality::Custom(s) => s.as_str(),
    };
    out.push_str(token);
}

/// Applies the iReal obfusc50 permutation. The permutation is
/// self-inverse, so this same function both scrambles (when called
/// on a clean chord chart, as the serializer does) and unscrambles
/// (as the parser does internally).
///
/// Mirrors the parser's `unscramble` byte-for-byte so AST round
/// trips are guaranteed: serialize emits a chord chart, scrambles
/// it, parse reverses the scramble, and the resulting AST equals
/// the source. The "tail < 2 chars" carve-out is preserved
/// identically.
fn obfusc50_apply(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while chars.len() - i > 50 {
        let chunk_end = i + 50;
        let remaining_after = chars.len() - chunk_end;
        if remaining_after < 2 {
            out.extend(&chars[i..chunk_end]);
        } else {
            out.push_str(&obfusc50_chunk(&chars[i..chunk_end]));
        }
        i = chunk_end;
    }
    out.extend(&chars[i..]);
    out
}

fn obfusc50_chunk(chunk: &[char]) -> String {
    debug_assert_eq!(chunk.len(), 50, "obfusc50 chunk must be exactly 50 chars");
    let mut buf: [char; 50] = ['\0'; 50];
    buf.copy_from_slice(chunk);
    for k in 0..5 {
        let opp = 49 - k;
        buf.swap(k, opp);
    }
    for k in 10..24 {
        let opp = 49 - k;
        buf.swap(k, opp);
    }
    buf.iter().collect()
}

/// Percent-encodes a string for use in an `irealb://` / `irealbook://`
/// URL body.
///
/// Encodes everything outside the iReal-allowed set (matching
/// what `decodeURIComponent` would round-trip). The iReal app
/// emits a fairly aggressive encoding — virtually every printable
/// ASCII character that is not an alphanumeric is percent-escaped.
/// We mirror that behaviour: only `A-Z`, `a-z`, `0-9` pass
/// through; everything else, including space, `=`, and the
/// chord-chart punctuation, is percent-escaped.
///
/// Note: `=` *as a body field separator* is preserved by the
/// caller's body construction (the encoder is only invoked on
/// the assembled body which already contains `=`-separated
/// fields). To preserve them, we encode every character to its
/// percent form; the caller passes the body verbatim and the
/// resulting URL re-decodes byte-for-byte.
fn percent_encode(input: &str) -> String {
    let mut out = String::with_capacity(input.len() * 3);
    for b in input.bytes() {
        if b.is_ascii_alphanumeric() {
            out.push(b as char);
        } else {
            out.push('%');
            out.push(hex_upper(b >> 4));
            out.push(hex_upper(b & 0x0f));
        }
    }
    out
}

fn hex_upper(nibble: u8) -> char {
    match nibble {
        0..=9 => char::from(b'0' + nibble),
        10..=15 => char::from(b'A' + nibble - 10),
        // nibble comes from `b >> 4` or `b & 0x0f` on a u8, so the
        // value is always 0..=15. Silently returning '0' here would
        // produce wrong hex output rather than surfacing the bug.
        _ => unreachable!("nibble is always 0..=15"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ast::*;

    #[test]
    fn percent_encode_encodes_non_alphanumeric() {
        // Sanity: only A-Za-z0-9 pass through; everything else is
        // %XX-escaped. The full decode round-trip is verified by the
        // integration tests that call `parse(irealb_serialize(…))`.
        let body = "abc=123==Afro";
        let encoded = percent_encode(body);
        // `=` is non-alphanumeric → encoded as %3D.
        assert_eq!(
            encoded, "abc%3D123%3D%3DAfro",
            "only alphanumerics should pass through unencoded"
        );
        // No raw `=` survives encoding.
        assert!(
            !encoded.contains('='),
            "raw `=` must not appear in percent-encoded output"
        );
        // Alphanumeric letters and digits are preserved verbatim.
        assert!(
            encoded.contains("abc"),
            "alphanumeric letters must pass through"
        );
        assert!(encoded.contains("123"), "digits must pass through");
        assert!(
            encoded.contains("Afro"),
            "alphanumeric run must pass through"
        );
    }

    #[test]
    fn obfusc50_apply_is_self_inverse() {
        let original =
            "abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxabcdefghijklmnopqrstuvwxyz";
        let scrambled = obfusc50_apply(original);
        let unscrambled = obfusc50_apply(&scrambled);
        assert_eq!(unscrambled, original);
    }

    #[test]
    fn empty_song_round_trips_via_placeholders() {
        // An "empty" `IrealSong::new()` has empty title and `None`
        // composer / style. The serializer fills those slots with
        // placeholder strings (TITLE_PLACEHOLDER etc.) so the
        // emitted URL has the documented `7..=9` field count.
        // Round-trip therefore replaces empty / None with the
        // placeholders — call sites that need lossless round-trip
        // must set these fields explicitly.
        let song = IrealSong::new();
        let url = irealb_serialize(&song);
        assert!(url.starts_with("irealb://"));
        let parsed = crate::parse(&url).expect("parse round trip");
        assert_eq!(parsed.title, TITLE_PLACEHOLDER);
        assert_eq!(parsed.composer.as_deref(), Some(COMPOSER_PLACEHOLDER));
        assert_eq!(parsed.style.as_deref(), Some(STYLE_PLACEHOLDER));
        assert_eq!(parsed.key_signature, song.key_signature);
        assert_eq!(parsed.time_signature, song.time_signature);
    }

    #[test]
    fn populated_song_round_trips() {
        let song = IrealSong {
            title: "Round Trip Test".into(),
            composer: Some("Tester".into()),
            style: Some("Medium Swing".into()),
            key_signature: KeySignature {
                root: ChordRoot {
                    note: 'D',
                    accidental: Accidental::Flat,
                },
                mode: KeyMode::Minor,
            },
            time_signature: TimeSignature::new(3, 4).unwrap(),
            tempo: Some(140),
            transpose: 2,
            sections: vec![Section {
                label: SectionLabel::Letter('A'),
                bars: vec![Bar {
                    start: BarLine::Double,
                    end: BarLine::Final,
                    chords: vec![BarChord {
                        chord: Chord::triad(ChordRoot::natural('C'), ChordQuality::Minor7),
                        position: BeatPosition::on_beat(1).unwrap(),
                        size: ChordSize::Default,
                        kind: BarChordKind::Played,
                    }],
                    ending: None,
                    symbol: None,
                    repeat_previous: false,
                    no_chord: false,
                    text_comment: None,
                    system_break_space: 0,
                    beat_grouping_override: None,
                }],
            }],
        };
        let url = irealb_serialize(&song);
        let parsed = crate::parse(&url).expect("parse round trip");
        assert_eq!(parsed.title, song.title);
        assert_eq!(parsed.composer, song.composer);
        assert_eq!(parsed.style, song.style);
        assert_eq!(parsed.key_signature, song.key_signature);
        assert_eq!(parsed.time_signature, song.time_signature);
        assert_eq!(parsed.tempo, song.tempo);
        assert_eq!(parsed.transpose, song.transpose);
        // Sections might collapse / shift around the section-marker
        // greediness; assert chord content survived.
        let total_chords: usize = parsed
            .sections
            .iter()
            .flat_map(|s| s.bars.iter())
            .map(|b| b.chords.len())
            .sum();
        assert_eq!(total_chords, 1, "exactly one chord round-trips");
    }

    #[test]
    fn time_signature_12_8_round_trips() {
        // Exercises the two-digit numerator branch in
        // `serialize_time_signature` (numerator >= 10 → T128).
        let mut song = IrealSong::new();
        song.title = "12/8 Test".into();
        song.composer = Some("T".into());
        song.style = Some("Medium Swing".into());
        song.time_signature = TimeSignature::new(12, 8).unwrap();
        let url = irealb_serialize(&song);
        let parsed = crate::parse(&url).expect("round trip");
        assert_eq!(parsed.time_signature, song.time_signature);
    }

    #[test]
    fn custom_section_label_round_trips() {
        // Exercises `SectionLabel::Custom` in `serialize_section_label`.
        // The parser's `label_for` produces `Custom` for any char that
        // is not one of the named variants. We use 'x' here (a lower-
        // case letter not in the named set) so the round-trip lands back
        // in `Custom("x")`.
        let mut song = IrealSong::new();
        song.title = "Custom Label".into();
        song.composer = Some("T".into());
        song.style = Some("Medium Swing".into());
        song.sections = vec![Section {
            label: SectionLabel::Custom("x".into()),
            bars: vec![Bar {
                start: BarLine::Double,
                end: BarLine::Final,
                chords: vec![BarChord {
                    chord: Chord::triad(ChordRoot::natural('C'), ChordQuality::Major),
                    position: BeatPosition::on_beat(1).unwrap(),
                    size: ChordSize::Default,
                    kind: BarChordKind::Played,
                }],
                ending: None,
                symbol: None,
                repeat_previous: false,
                no_chord: false,
                text_comment: None,
                system_break_space: 0,
                beat_grouping_override: None,
            }],
        }];
        let url = irealb_serialize(&song);
        let parsed = crate::parse(&url).expect("round trip");
        let total_chords: usize = parsed
            .sections
            .iter()
            .flat_map(|s| s.bars.iter())
            .map(|b| b.chords.len())
            .sum();
        assert_eq!(
            total_chords, 1,
            "chord must survive Custom label round trip"
        );
    }

    #[test]
    fn musical_symbol_fine_round_trips() {
        // Exercises `MusicalSymbol::Fine` in `serialize_symbol`.
        // Fine is on a non-Single-start bar, so it's emitted before
        // the open `[` glyph; the parser queues it and applies it
        // to the same bar.
        let song = IrealSong {
            title: "Fine Test".into(),
            composer: Some("T".into()),
            style: Some("Medium Swing".into()),
            sections: vec![Section {
                label: SectionLabel::Letter('A'),
                bars: vec![Bar {
                    start: BarLine::Double,
                    end: BarLine::Final,
                    chords: vec![BarChord {
                        chord: Chord::triad(ChordRoot::natural('C'), ChordQuality::Major),
                        position: BeatPosition::on_beat(1).unwrap(),
                        size: ChordSize::Default,
                        kind: BarChordKind::Played,
                    }],
                    ending: None,
                    symbol: Some(MusicalSymbol::Fine),
                    repeat_previous: false,
                    no_chord: false,
                    text_comment: None,
                    system_break_space: 0,
                    beat_grouping_override: None,
                }],
            }],
            ..Default::default()
        };
        let url = irealb_serialize(&song);
        let parsed = crate::parse(&url).expect("round trip");
        let found_fine = parsed
            .sections
            .iter()
            .flat_map(|s| s.bars.iter())
            .any(|b| b.symbol == Some(MusicalSymbol::Fine));
        assert!(found_fine, "Fine symbol must survive the round trip");
    }

    #[test]
    fn musical_symbol_break_round_trips() {
        // Exercises `MusicalSymbol::Break` in `serialize_symbol`:
        // `Break` must serialise to `<Break>` and parse back to
        // `symbol = MusicalSymbol::Break` with no `text_comment`.
        let song = IrealSong {
            title: "Break Test".into(),
            composer: Some("T".into()),
            style: Some("Medium Swing".into()),
            sections: vec![Section {
                label: SectionLabel::Letter('A'),
                bars: vec![Bar {
                    start: BarLine::Double,
                    end: BarLine::Final,
                    chords: vec![BarChord {
                        chord: Chord::triad(ChordRoot::natural('C'), ChordQuality::Major),
                        position: BeatPosition::on_beat(1).unwrap(),
                        size: ChordSize::Default,
                        kind: BarChordKind::Played,
                    }],
                    ending: None,
                    symbol: Some(MusicalSymbol::Break),
                    repeat_previous: false,
                    no_chord: false,
                    text_comment: None,
                    system_break_space: 0,
                    beat_grouping_override: None,
                }],
            }],
            ..Default::default()
        };
        let url = irealb_serialize(&song);
        // `irealb_serialize` produces a percent-encoded `irealb://` URL, so
        // `<` → `%3C` and `>` → `%3E`. The plain `<Break>` form would only
        // appear in a non-encoded `irealbook://` URL.
        assert!(
            url.contains("%3CBreak%3E"),
            "serialised URL must contain the percent-encoded <Break> token: {url}"
        );
        let parsed = crate::parse(&url).expect("round trip");
        let found_break = parsed
            .sections
            .iter()
            .flat_map(|s| s.bars.iter())
            .any(|b| b.symbol == Some(MusicalSymbol::Break));
        assert!(found_break, "Break symbol must survive the round trip");
    }

    #[test]
    fn untitled_ending_round_trips() {
        // Spec token `N0` ("no text Ending") must survive the URL
        // round trip: `Ending::Untitled` → `N0` → `Ending::Untitled`.
        // The pre-#2436 parser fell through on `N0` and dropped
        // the bracket, breaking the round-trip property.
        let song = IrealSong {
            title: "N0 Round Trip".into(),
            composer: Some("T".into()),
            style: Some("Medium Swing".into()),
            sections: vec![Section {
                label: SectionLabel::Letter('A'),
                bars: vec![Bar {
                    start: BarLine::Double,
                    end: BarLine::Final,
                    chords: vec![BarChord {
                        chord: Chord::triad(ChordRoot::natural('C'), ChordQuality::Major),
                        position: BeatPosition::on_beat(1).unwrap(),
                        size: ChordSize::Default,
                        kind: BarChordKind::Played,
                    }],
                    ending: Some(Ending::Untitled),
                    symbol: None,
                    repeat_previous: false,
                    no_chord: false,
                    text_comment: None,
                    system_break_space: 0,
                    beat_grouping_override: None,
                }],
            }],
            ..Default::default()
        };
        let url = irealb_serialize(&song);
        let parsed = crate::parse(&url).expect("round trip");
        let endings: Vec<_> = parsed
            .sections
            .iter()
            .flat_map(|s| s.bars.iter())
            .filter_map(|b| b.ending)
            .collect();
        assert_eq!(
            endings,
            vec![Ending::Untitled],
            "N0 untitled ending must survive the URL round trip"
        );
    }

    #[test]
    fn musical_symbol_da_capo_round_trips() {
        // Exercises `MusicalSymbol::DaCapo` in `serialize_symbol`.
        let song = IrealSong {
            title: "DC Test".into(),
            composer: Some("T".into()),
            style: Some("Medium Swing".into()),
            sections: vec![Section {
                label: SectionLabel::Letter('A'),
                bars: vec![Bar {
                    start: BarLine::Double,
                    end: BarLine::Final,
                    chords: vec![BarChord {
                        chord: Chord::triad(ChordRoot::natural('G'), ChordQuality::Dominant7),
                        position: BeatPosition::on_beat(1).unwrap(),
                        size: ChordSize::Default,
                        kind: BarChordKind::Played,
                    }],
                    ending: None,
                    symbol: Some(MusicalSymbol::DaCapo(crate::ast::JumpTarget::Unspecified)),
                    repeat_previous: false,
                    no_chord: false,
                    text_comment: None,
                    system_break_space: 0,
                    beat_grouping_override: None,
                }],
            }],
            ..Default::default()
        };
        let url = irealb_serialize(&song);
        let parsed = crate::parse(&url).expect("round trip");
        let found =
            parsed.sections.iter().flat_map(|s| s.bars.iter()).any(|b| {
                b.symbol == Some(MusicalSymbol::DaCapo(crate::ast::JumpTarget::Unspecified))
            });
        assert!(found, "DaCapo symbol must survive the round trip");
    }

    #[test]
    fn musical_symbol_dal_segno_round_trips() {
        // Exercises `MusicalSymbol::DalSegno` in `serialize_symbol`.
        let song = IrealSong {
            title: "DS Test".into(),
            composer: Some("T".into()),
            style: Some("Medium Swing".into()),
            sections: vec![Section {
                label: SectionLabel::Letter('A'),
                bars: vec![Bar {
                    start: BarLine::Double,
                    end: BarLine::Final,
                    chords: vec![BarChord {
                        chord: Chord::triad(ChordRoot::natural('F'), ChordQuality::Major),
                        position: BeatPosition::on_beat(1).unwrap(),
                        size: ChordSize::Default,
                        kind: BarChordKind::Played,
                    }],
                    ending: None,
                    symbol: Some(MusicalSymbol::DalSegno(crate::ast::JumpTarget::Unspecified)),
                    repeat_previous: false,
                    no_chord: false,
                    text_comment: None,
                    system_break_space: 0,
                    beat_grouping_override: None,
                }],
            }],
            ..Default::default()
        };
        let url = irealb_serialize(&song);
        let parsed = crate::parse(&url).expect("round trip");
        let found = parsed.sections.iter().flat_map(|s| s.bars.iter()).any(|b| {
            b.symbol == Some(MusicalSymbol::DalSegno(crate::ast::JumpTarget::Unspecified))
        });
        assert!(found, "DalSegno symbol must survive the round trip");
    }

    #[test]
    fn musical_symbol_fermata_round_trips() {
        // Exercises `MusicalSymbol::Fermata` in `serialize_symbol`.
        // Serialised as a single `f` glyph attached to the bar;
        // re-parsed via the `f` token branch in `parse_chord_chart`.
        let song = IrealSong {
            title: "Fermata Test".into(),
            composer: Some("T".into()),
            style: Some("Medium Swing".into()),
            sections: vec![Section {
                label: SectionLabel::Letter('A'),
                bars: vec![Bar {
                    start: BarLine::Double,
                    end: BarLine::Final,
                    chords: vec![BarChord {
                        chord: Chord::triad(ChordRoot::natural('G'), ChordQuality::Dominant7),
                        position: BeatPosition::on_beat(1).unwrap(),
                        size: ChordSize::Default,
                        kind: BarChordKind::Played,
                    }],
                    ending: None,
                    symbol: Some(MusicalSymbol::Fermata),
                    repeat_previous: false,
                    no_chord: false,
                    text_comment: None,
                    system_break_space: 0,
                    beat_grouping_override: None,
                }],
            }],
            ..Default::default()
        };
        let url = irealb_serialize(&song);
        let parsed = crate::parse(&url).expect("round trip");
        let found = parsed
            .sections
            .iter()
            .flat_map(|s| s.bars.iter())
            .any(|b| b.symbol == Some(MusicalSymbol::Fermata));
        assert!(found, "Fermata symbol must survive the round trip");
    }

    #[test]
    fn obfusc50_apply_remaining_after_less_than_2() {
        // Exercises the `remaining_after < 2` carve-out: when the tail
        // after a 50-char chunk is only 1 char, that chunk is appended
        // unscrambled (matching the upstream JS quirk in `unscramble`).
        // A 101-char string has 1 char remaining after the second
        // chunk boundary at position 100, triggering the carve-out
        // for the chunk at position 50..100.
        let original: String = (0..101)
            .map(|i| char::from(b'a' + (i as u8 % 26)))
            .collect();
        let scrambled = obfusc50_apply(&original);
        let unscrambled = obfusc50_apply(&scrambled);
        assert_eq!(
            unscrambled, original,
            "obfusc50_apply must be self-inverse even with remaining_after < 2"
        );
    }

    #[test]
    fn collection_round_trips() {
        let song1 = IrealSong {
            title: "First".into(),
            composer: Some("Composer A".into()),
            style: Some("Bossa Nova".into()),
            tempo: Some(120),
            ..Default::default()
        };
        let song2 = IrealSong {
            title: "Second".into(),
            composer: Some("Composer B".into()),
            style: Some("Up Tempo Swing".into()),
            tempo: Some(180),
            ..Default::default()
        };
        let url = irealbook_serialize(&[song1.clone(), song2.clone()], Some("Playlist"));
        assert!(url.starts_with("irealbook://"));
        let (parsed, name) = crate::parse_collection(&url).expect("parse collection");
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].title, song1.title);
        assert_eq!(parsed[0].composer, song1.composer);
        assert_eq!(parsed[0].style, song1.style);
        assert_eq!(parsed[0].tempo, song1.tempo);
        assert_eq!(parsed[1].title, song2.title);
        assert_eq!(parsed[1].composer, song2.composer);
        assert_eq!(parsed[1].style, song2.style);
        assert_eq!(parsed[1].tempo, song2.tempo);
        assert_eq!(name.as_deref(), Some("Playlist"));
    }

    /// Round-trip regression: a `text_comment` containing the
    /// reserved `>` delimiter must not corrupt the chord stream.
    /// `emit_text_comment` strips the inner `>` so re-parsing
    /// captures the rest of the caption rather than truncating at
    /// the first `>`.
    #[test]
    fn text_comment_with_inner_gt_round_trips_on_regular_bar() {
        let song = IrealSong {
            title: "GT Regular".into(),
            composer: Some("T".into()),
            style: Some("Medium Swing".into()),
            sections: vec![Section {
                label: SectionLabel::Letter('A'),
                bars: vec![Bar {
                    start: BarLine::Double,
                    end: BarLine::Final,
                    chords: vec![BarChord {
                        chord: Chord::triad(ChordRoot::natural('C'), ChordQuality::Major),
                        position: BeatPosition::on_beat(1).unwrap(),
                        size: ChordSize::Default,
                        kind: BarChordKind::Played,
                    }],
                    text_comment: Some("see > here".into()),
                    ..Default::default()
                }],
            }],
            ..Default::default()
        };
        let url = irealb_serialize(&song);
        let parsed = crate::parse(&url).expect("round trip must succeed");
        let got = parsed.sections[0].bars[0]
            .text_comment
            .as_deref()
            .unwrap_or("");
        assert!(
            !got.contains('>'),
            "stripped `>` must not survive into parsed comment, got {got:?}"
        );
        // The stripped form preserves the rest of the caption.
        assert_eq!(got, "see  here");
    }

    /// Sister-site coverage for the `Kcl` (repeat-previous) branch.
    /// Locks in the existing fix that already routes through
    /// `emit_text_comment`.
    #[test]
    fn text_comment_with_inner_gt_round_trips_on_kcl_bar() {
        let song = IrealSong {
            title: "GT Kcl".into(),
            composer: Some("T".into()),
            style: Some("Medium Swing".into()),
            sections: vec![Section {
                label: SectionLabel::Letter('A'),
                bars: vec![
                    Bar {
                        start: BarLine::Double,
                        end: BarLine::Single,
                        chords: vec![BarChord {
                            chord: Chord::triad(ChordRoot::natural('C'), ChordQuality::Major),
                            position: BeatPosition::on_beat(1).unwrap(),
                            size: ChordSize::Default,
                            kind: BarChordKind::Played,
                        }],
                        ..Default::default()
                    },
                    Bar {
                        start: BarLine::Single,
                        end: BarLine::Final,
                        repeat_previous: true,
                        text_comment: Some("rit. > slow".into()),
                        ..Default::default()
                    },
                ],
            }],
            ..Default::default()
        };
        let url = irealb_serialize(&song);
        let parsed = crate::parse(&url).expect("round trip must succeed");
        let got = parsed.sections[0].bars[1]
            .text_comment
            .as_deref()
            .unwrap_or("");
        assert!(!got.contains('>'));
    }

    /// A `text_comment` whose body contains "refine" (substring
    /// match for the old `lower.contains("fine")` bug) must NOT
    /// suppress an explicit `bar.symbol` on round trip — both
    /// fields survive.
    #[test]
    fn refine_caption_with_explicit_fine_symbol_round_trips_both() {
        let song = IrealSong {
            title: "Refine".into(),
            composer: Some("T".into()),
            style: Some("Medium Swing".into()),
            sections: vec![Section {
                label: SectionLabel::Letter('A'),
                bars: vec![Bar {
                    start: BarLine::Double,
                    end: BarLine::Final,
                    chords: vec![BarChord {
                        chord: Chord::triad(ChordRoot::natural('C'), ChordQuality::Major),
                        position: BeatPosition::on_beat(1).unwrap(),
                        size: ChordSize::Default,
                        kind: BarChordKind::Played,
                    }],
                    symbol: Some(MusicalSymbol::Fine),
                    text_comment: Some("refine the chord".into()),
                    ..Default::default()
                }],
            }],
            ..Default::default()
        };
        let url = irealb_serialize(&song);
        let parsed = crate::parse(&url).expect("round trip must succeed");
        let bar = &parsed.sections[0].bars[0];
        assert_eq!(
            bar.text_comment.as_deref(),
            Some("refine the chord"),
            "text_comment must survive verbatim"
        );
        assert_eq!(
            bar.symbol,
            Some(MusicalSymbol::Fine),
            "explicit Fine symbol must NOT be suppressed by an English-word substring"
        );
    }

    // ---- Section-label round-trip (#2432, #2450) -------------------

    fn single_bar_song(label: SectionLabel) -> IrealSong {
        IrealSong {
            title: "T".into(),
            composer: Some("c".into()),
            style: Some("Medium Swing".into()),
            sections: vec![Section {
                label,
                bars: vec![Bar {
                    start: BarLine::Double,
                    end: BarLine::Final,
                    chords: vec![BarChord {
                        chord: Chord::triad(ChordRoot::natural('C'), ChordQuality::Major),
                        position: BeatPosition::on_beat(1).unwrap(),
                        size: ChordSize::Default,
                        kind: BarChordKind::Played,
                    }],
                    ..Default::default()
                }],
            }],
            ..Default::default()
        }
    }

    #[test]
    fn verse_label_round_trips_via_url() {
        // Serializer emits `*V` uppercase per spec; parser accepts
        // both cases. Round-trip preserves `Verse`.
        let song = single_bar_song(SectionLabel::Verse);
        let url = irealb_serialize(&song);
        assert!(
            url.contains("%2AV") || url.contains("*V"),
            "URL must encode `*V` uppercase, got {url}"
        );
        let parsed = crate::parse(&url).expect("round trip");
        assert_eq!(parsed.sections[0].label, SectionLabel::Verse);
    }

    #[test]
    fn intro_label_round_trips_via_url() {
        let song = single_bar_song(SectionLabel::Intro);
        let url = irealb_serialize(&song);
        let parsed = crate::parse(&url).expect("round trip");
        assert_eq!(parsed.sections[0].label, SectionLabel::Intro);
    }

    /// `Custom("Chorus")` → URL is lossy: the iReal `*X` token only
    /// carries one character. Locks the documented behaviour from
    /// `crates/convert/known-deviations.md` §"URL-cycle lossiness
    /// for multi-character custom labels" — `Custom("Chorus")`
    /// truncates to `*C` and re-parses as `Letter('C')`. This test
    /// asserts the actual behaviour so a silent change to the
    /// truncation rule is caught.
    #[test]
    fn multi_char_custom_label_truncates_to_letter_on_url_round_trip() {
        let song = single_bar_song(SectionLabel::Custom("Chorus".into()));
        let url = irealb_serialize(&song);
        let parsed = crate::parse(&url).expect("round trip");
        // First-char-only emission means re-parse sees `*C` →
        // `Letter('C')`, NOT `Custom("Chorus")`.
        assert_eq!(parsed.sections[0].label, SectionLabel::Letter('C'));
    }

    // ---- Vertical-space hint round-trip ----------------------------

    #[test]
    fn system_break_space_round_trips_via_url() {
        // A bar with `system_break_space = 2` must serialise into a
        // `YY` token that the parser re-counts to `2` on the way back.
        let song = IrealSong {
            title: "Vertical Space".into(),
            composer: Some("T".into()),
            style: Some("Medium Swing".into()),
            sections: vec![Section {
                label: SectionLabel::Letter('A'),
                bars: vec![
                    Bar {
                        start: BarLine::Double,
                        end: BarLine::Single,
                        chords: vec![BarChord {
                            chord: Chord::triad(ChordRoot::natural('C'), ChordQuality::Major),
                            position: BeatPosition::on_beat(1).unwrap(),
                            size: ChordSize::Default,
                            kind: BarChordKind::Played,
                        }],
                        ..Default::default()
                    },
                    Bar {
                        start: BarLine::Single,
                        end: BarLine::Final,
                        chords: vec![BarChord {
                            chord: Chord::triad(ChordRoot::natural('D'), ChordQuality::Major),
                            position: BeatPosition::on_beat(1).unwrap(),
                            size: ChordSize::Default,
                            kind: BarChordKind::Played,
                        }],
                        system_break_space: 2,
                        beat_grouping_override: None,
                        ..Default::default()
                    },
                ],
            }],
            ..Default::default()
        };
        let url = irealb_serialize(&song);
        let parsed = crate::parse(&url).expect("round trip");
        let bar1 = &parsed.sections[0].bars[1];
        assert_eq!(
            bar1.system_break_space, 2,
            "system_break_space must survive serialise → parse"
        );
        // Chord on the labelled bar must also survive.
        assert_eq!(bar1.chords[0].chord.root.note, 'D');
    }

    /// A `Double`-start bar with `system_break_space = 2` must survive
    /// the serialise → parse round-trip. The Y tokens must appear AFTER
    /// the `[` bar-open glyph; if emitted before it, the parser drops
    /// the hint on the empty-placeholder bar and the field becomes 0.
    #[test]
    fn system_break_space_on_double_start_bar_round_trips() {
        let song = IrealSong {
            title: "Y Double".into(),
            composer: Some("T".into()),
            style: Some("Medium Swing".into()),
            sections: vec![Section {
                label: SectionLabel::Letter('A'),
                bars: vec![
                    Bar {
                        start: BarLine::Double,
                        end: BarLine::Single,
                        chords: vec![BarChord {
                            chord: Chord::triad(ChordRoot::natural('C'), ChordQuality::Major),
                            position: BeatPosition::on_beat(1).unwrap(),
                            size: ChordSize::Default,
                            kind: BarChordKind::Played,
                        }],
                        ..Default::default()
                    },
                    Bar {
                        start: BarLine::Double,
                        end: BarLine::Final,
                        chords: vec![BarChord {
                            chord: Chord::triad(ChordRoot::natural('D'), ChordQuality::Major),
                            position: BeatPosition::on_beat(1).unwrap(),
                            size: ChordSize::Default,
                            kind: BarChordKind::Played,
                        }],
                        system_break_space: 2,
                        beat_grouping_override: None,
                        ..Default::default()
                    },
                ],
            }],
            ..Default::default()
        };
        let url = irealb_serialize(&song);
        let parsed = crate::parse(&url).expect("round trip");
        let bar1 = parsed
            .sections
            .iter()
            .flat_map(|s| s.bars.iter())
            .find(|b| {
                b.start == BarLine::Double && b.chords.iter().any(|c| c.chord.root.note == 'D')
            })
            .expect("double-start D bar must survive");
        assert_eq!(
            bar1.system_break_space, 2,
            "system_break_space must survive on a Double-start bar"
        );
    }

    /// A `repeat_previous` bar with `system_break_space = 1` must
    /// survive serialise → parse. Y must appear AFTER `Kcl`; if
    /// emitted before it, the hint is lost on the empty-placeholder bar.
    #[test]
    fn system_break_space_on_repeat_previous_bar_round_trips() {
        let song = IrealSong {
            title: "Y Kcl".into(),
            composer: Some("T".into()),
            style: Some("Medium Swing".into()),
            sections: vec![Section {
                label: SectionLabel::Letter('A'),
                bars: vec![
                    Bar {
                        start: BarLine::Double,
                        end: BarLine::Single,
                        chords: vec![BarChord {
                            chord: Chord::triad(ChordRoot::natural('C'), ChordQuality::Major),
                            position: BeatPosition::on_beat(1).unwrap(),
                            size: ChordSize::Default,
                            kind: BarChordKind::Played,
                        }],
                        ..Default::default()
                    },
                    Bar {
                        start: BarLine::Single,
                        end: BarLine::Final,
                        repeat_previous: true,
                        system_break_space: 1,
                        beat_grouping_override: None,
                        ..Default::default()
                    },
                ],
            }],
            ..Default::default()
        };
        let url = irealb_serialize(&song);
        let parsed = crate::parse(&url).expect("round trip");
        let repeat_bar = parsed
            .sections
            .iter()
            .flat_map(|s| s.bars.iter())
            .find(|b| b.repeat_previous)
            .expect("repeat_previous bar must survive");
        assert_eq!(
            repeat_bar.system_break_space, 1,
            "system_break_space must survive on a repeat_previous bar"
        );
    }

    /// An `OpenRepeat`-start bar takes the same `finish_bar +
    /// start_new_bar` path as `Double` at the `{` glyph. The hint
    /// must therefore land on the new bar, not the dropped empty
    /// placeholder.
    #[test]
    fn system_break_space_on_open_repeat_start_bar_round_trips() {
        let song = IrealSong {
            title: "Y Open Repeat".into(),
            composer: Some("T".into()),
            style: Some("Medium Swing".into()),
            sections: vec![Section {
                label: SectionLabel::Letter('A'),
                bars: vec![Bar {
                    start: BarLine::OpenRepeat,
                    end: BarLine::CloseRepeat,
                    chords: vec![BarChord {
                        chord: Chord::triad(ChordRoot::natural('F'), ChordQuality::Major),
                        position: BeatPosition::on_beat(1).unwrap(),
                        size: ChordSize::Default,
                        kind: BarChordKind::Played,
                    }],
                    system_break_space: 1,
                    beat_grouping_override: None,
                    ..Default::default()
                }],
            }],
            ..Default::default()
        };
        let url = irealb_serialize(&song);
        let parsed = crate::parse(&url).expect("round trip");
        let bar0 = parsed
            .sections
            .iter()
            .flat_map(|s| s.bars.iter())
            .find(|b| b.start == BarLine::OpenRepeat)
            .expect("open-repeat bar must survive");
        assert_eq!(
            bar0.system_break_space, 1,
            "system_break_space must survive on an OpenRepeat-start bar"
        );
        assert_eq!(bar0.chords[0].chord.root.note, 'F');
    }

    /// Single-char custom labels round-trip cleanly when the char is
    /// outside the named-variant vocabulary (`v` / `V` / `i` / `I`)
    /// and outside the uppercase-letter `Letter(c)` range.
    #[test]
    fn single_char_lowercase_custom_round_trips_via_url() {
        let song = single_bar_song(SectionLabel::Custom("x".into()));
        let url = irealb_serialize(&song);
        let parsed = crate::parse(&url).expect("round trip");
        assert_eq!(
            parsed.sections[0].label,
            SectionLabel::Custom("x".into()),
            "single-char `Custom(\"x\")` must round-trip identity"
        );
    }

    /// Pause-slash chords (`BarChordKind::SlashRepeat`) emit `p` in
    /// the URL and re-parse back into a `SlashRepeat` BarChord whose
    /// `chord` snapshot matches the preceding chord. Round-trip
    /// guarantee from the chord level all the way back to the chord
    /// level — without it, a chart authored in Rust then exported to
    /// iReal Pro would lose its slash semantics.
    #[test]
    fn slash_repeat_round_trips_via_url() {
        let c7 = Chord::triad(ChordRoot::natural('C'), ChordQuality::Dominant7);
        let f7 = Chord::triad(ChordRoot::natural('F'), ChordQuality::Dominant7);
        let song = IrealSong {
            title: "Slash Repeat".into(),
            composer: Some("T".into()),
            style: Some("Medium Swing".into()),
            sections: vec![Section {
                label: SectionLabel::Letter('A'),
                bars: vec![Bar {
                    chords: vec![
                        BarChord {
                            chord: c7.clone(),
                            position: BeatPosition::on_beat(1).unwrap(),
                            size: ChordSize::Default,
                            kind: BarChordKind::Played,
                        },
                        BarChord {
                            chord: c7.clone(),
                            position: BeatPosition::on_beat(2).unwrap(),
                            size: ChordSize::Default,
                            kind: BarChordKind::SlashRepeat,
                        },
                        BarChord {
                            chord: c7.clone(),
                            position: BeatPosition::on_beat(3).unwrap(),
                            size: ChordSize::Default,
                            kind: BarChordKind::SlashRepeat,
                        },
                        BarChord {
                            chord: f7.clone(),
                            position: BeatPosition::on_beat(4).unwrap(),
                            size: ChordSize::Default,
                            kind: BarChordKind::Played,
                        },
                    ],
                    ..Default::default()
                }],
            }],
            ..Default::default()
        };
        let url = irealb_serialize(&song);
        let parsed = crate::parse(&url).expect("round trip");
        let bar0 = &parsed.sections[0].bars[0];
        assert_eq!(
            bar0.chords.len(),
            4,
            "expected 4 chord entries, got {bar0:?}"
        );
        assert_eq!(bar0.chords[0].kind, BarChordKind::Played);
        assert_eq!(bar0.chords[0].chord.root.note, 'C');
        assert_eq!(bar0.chords[1].kind, BarChordKind::SlashRepeat);
        // Snapshot is the preceding C7, not F7 — even though the
        // serialised URL embeds the `p` between C7 and F7, the
        // parser resolves the snapshot from the chord that came
        // BEFORE the `p`, not the one after.
        assert_eq!(bar0.chords[1].chord.root.note, 'C');
        assert_eq!(bar0.chords[2].kind, BarChordKind::SlashRepeat);
        assert_eq!(bar0.chords[2].chord.root.note, 'C');
        assert_eq!(bar0.chords[3].kind, BarChordKind::Played);
        assert_eq!(bar0.chords[3].chord.root.note, 'F');
    }

    /// Compound-time grouping serialisation (#2449): the serializer emits
    /// `<a+b>` only at change points, not once per inherited bar.
    ///
    /// The parser stamps every bar from the override forward with the
    /// running grouping (3 bars in this fixture: bars 1, 2, 3). The
    /// serializer must emit the token exactly once (bar 1's change point)
    /// and suppress it on bars 2 and 3. Verifying idempotency
    /// (`parse → serialize → parse` preserves the grouping) confirms
    /// both the emission logic and the re-parse path for the `T54`-seeded
    /// music body the serializer produces.
    #[test]
    fn compound_time_grouping_emits_token_once_per_change_point() {
        // 5/4 song: bar 0 has no override; bars 1–3 inherit `<3+2>`.
        // irealbook:// (6-field) is used for the source so the header
        // time signature seeds the parser correctly.
        let source = "irealbook://Test=A==Style=C=54=[*AC|<3+2>D|E|F|]";
        let song = crate::parse(source).expect("parse source");
        let serialized = irealb_serialize(&song);
        // `<3+2>` is percent-encoded as `%3C3%2B2%3E` in the irealb:// URL.
        let encoded_token = "%3C3%2B2%3E";
        let count = serialized.matches(encoded_token).count();
        assert_eq!(
            count, 1,
            "expected exactly one `<3+2>` token in the serialized URL, \
             got {count}: {serialized:?}"
        );
        // Idempotency: re-parse the serialized URL and check grouping survives.
        let reparsed = crate::parse(&serialized).expect("re-parse");
        let bars = &reparsed.sections[0].bars;
        assert!(
            bars[0].beat_grouping_override.is_none(),
            "bar 0 predates the override and must have none"
        );
        for (i, bar) in bars.iter().enumerate().skip(1) {
            let g = bar
                .beat_grouping_override
                .as_ref()
                .unwrap_or_else(|| panic!("bar {i} must inherit the 3+2 grouping after re-parse"));
            assert_eq!(
                g.sum(),
                5,
                "bar {i} grouping sum must be 5 (3+2), got {:?}",
                g.parts()
            );
        }
    }

    // -----------------------------------------------------------------
    // Open-protocol (#2425) — plain-text irealbook:// URL serializer
    // -----------------------------------------------------------------

    fn populated_open_protocol_song() -> IrealSong {
        IrealSong {
            title: "A Walkin Thing".into(),
            composer: Some("Carter Benny".into()),
            style: Some("Medium Swing".into()),
            key_signature: KeySignature {
                root: ChordRoot::natural('C'),
                mode: KeyMode::Major,
            },
            time_signature: TimeSignature::new(4, 4).unwrap(),
            tempo: None,
            transpose: 0,
            sections: vec![Section {
                label: SectionLabel::Letter('A'),
                bars: vec![
                    Bar {
                        start: BarLine::Double,
                        end: BarLine::Single,
                        chords: vec![BarChord {
                            chord: Chord::triad(ChordRoot::natural('C'), ChordQuality::Major),
                            position: BeatPosition::on_beat(1).unwrap(),
                            size: ChordSize::Default,
                            kind: BarChordKind::Played,
                        }],
                        ending: None,
                        symbol: None,
                        repeat_previous: false,
                        no_chord: false,
                        text_comment: None,
                        system_break_space: 0,
                        beat_grouping_override: None,
                    },
                    Bar {
                        end: BarLine::Final,
                        chords: vec![BarChord {
                            chord: Chord::triad(ChordRoot::natural('G'), ChordQuality::Dominant7),
                            position: BeatPosition::on_beat(1).unwrap(),
                            size: ChordSize::Default,
                            kind: BarChordKind::Played,
                        }],
                        ..Bar::new()
                    },
                ],
            }],
        }
    }

    #[test]
    fn serialize_open_protocol_uses_irealbook_prefix() {
        // The open-protocol scheme is `irealbook://` (not the
        // obfuscated `irealb://` export form).
        let url = serialize_open_protocol(&populated_open_protocol_song());
        assert!(
            url.starts_with("irealbook://"),
            "expected irealbook:// prefix, got: {url}"
        );
    }

    #[test]
    fn serialize_open_protocol_round_trips_via_parse() {
        // Single-song round-trip is the load-bearing property —
        // every field that fits the 6-field shape must reappear in
        // the parsed AST. Tempo / transpose are intentionally NOT
        // present in the open-protocol body (only the 7-field
        // `irealb://` shape carries them), so the parsed song will
        // default those fields back to `None` / `0` regardless of
        // what the original song carried — verified separately.
        let song = populated_open_protocol_song();
        let url = serialize_open_protocol(&song);
        let parsed = crate::parse(&url).expect("round trip");
        assert_eq!(parsed.title, song.title);
        assert_eq!(parsed.composer, song.composer);
        assert_eq!(parsed.style, song.style);
        assert_eq!(parsed.key_signature, song.key_signature);
        assert_eq!(parsed.time_signature, song.time_signature);
        assert_eq!(parsed.sections.len(), song.sections.len());
    }

    #[test]
    fn serialize_open_protocol_percent_encodes_reserved_chars_only() {
        // Verify the exact reserved-set spec: only =, space, {, }, [, ],
        // <, >, ,, #, ^ get percent-encoded. Alphanumerics and other
        // chord-chart punctuation (|, /, -, +, etc.) pass through
        // verbatim so the URL stays readable.
        let song = populated_open_protocol_song();
        let url = serialize_open_protocol(&song);
        let body = url
            .strip_prefix("irealbook://")
            .expect("prefix already verified above");
        // Title contains spaces — they must be encoded as %20.
        assert!(
            body.contains("A%20Walkin%20Thing"),
            "title spaces should encode to %20: {body}"
        );
        // Field separators `=` between the 6 fields must be encoded
        // as %3D so the browser can drop the URL into an href.
        assert!(
            body.contains("%3D"),
            "field separators should encode to %3D: {body}"
        );
        // Bar-grouping characters `[` and `|` — `[` is in the reserved
        // set, `|` is not.
        assert!(body.contains("%5B"), "[ should encode to %5B: {body}");
        assert!(
            !body.contains("%7C"),
            "| should pass through unencoded (not in reserved set): {body}"
        );
        // No raw reserved char survives the encoding pass.
        for forbidden in [' ', '=', '{', '}', '[', ']', '<', '>', ',', '#', '^'] {
            assert!(
                !body.contains(forbidden),
                "raw `{forbidden}` must NOT appear in encoded body: {body}"
            );
        }
    }

    #[test]
    fn serialize_open_protocol_emits_six_fields_after_decode() {
        // After URL-decoding, the body MUST split into exactly 6
        // non-empty fields per the spec
        // (`Title=Composer=Style=Key=TimeSig=Music`). Asserts the
        // field count directly so a future regression that adds or
        // drops a field fails this test rather than silently routing
        // through a different parser arm.
        let song = populated_open_protocol_song();
        let url = serialize_open_protocol(&song);
        let body = url.strip_prefix("irealbook://").expect("prefix");
        // Count `%3D` occurrences (encoded `=` separators). For a
        // 6-field body there are exactly 5 separators.
        let separator_count = body.matches("%3D").count();
        assert_eq!(
            separator_count, 5,
            "6-field body must have exactly 5 `=` separators (encoded as %3D), got {separator_count} in {body}"
        );
        // Sanity: also verify the parser routes successfully through
        // the 6-field arm.
        let parsed = crate::parse(&url).expect("must route to 6-field parser arm");
        assert_eq!(parsed.title, song.title);
    }

    #[test]
    fn serialize_open_protocol_drops_tempo_and_transpose() {
        // The 6-field spec format has no tempo/transpose fields.
        // The serializer silently discards them and the parser
        // defaults them back. This test locks the documented
        // round-trip limitation so a future change that smuggles
        // these into the body fails loudly.
        let mut song = populated_open_protocol_song();
        song.tempo = Some(180);
        song.transpose = -2;
        let url = serialize_open_protocol(&song);
        let parsed = crate::parse(&url).expect("round trip");
        assert_eq!(
            parsed.tempo, None,
            "tempo must be dropped on open-protocol round trip"
        );
        assert_eq!(
            parsed.transpose, 0,
            "transpose must be dropped on open-protocol round trip"
        );
    }

    #[test]
    fn serialize_open_protocol_preserves_non_ascii_metadata() {
        // Multi-byte UTF-8 titles/composers/styles must round-trip
        // through the URL byte-for-byte. The percent-encoder MUST
        // encode every byte `>= 0x80` (RFC 3986); a raw
        // `out.push(b as char)` would reinterpret continuation
        // bytes as Latin-1 codepoints and corrupt the string on
        // decode. Regression test for the security-review finding.
        let mut song = populated_open_protocol_song();
        song.title = "東京の歌".into();
        song.composer = Some("José García".into());
        song.style = Some("Bossa Nova — café".into());
        let url = serialize_open_protocol(&song);
        let parsed = crate::parse(&url).expect("non-ASCII round trip");
        assert_eq!(parsed.title, "東京の歌");
        assert_eq!(parsed.composer.as_deref(), Some("José García"));
        assert_eq!(parsed.style.as_deref(), Some("Bossa Nova — café"));
    }

    #[test]
    fn serialize_open_protocol_encodes_percent_sign() {
        // A literal `%` in a field would otherwise be misinterpreted
        // as the percent-escape sigil on decode (`100%41` → `100A`).
        // The encoder MUST escape `%` to `%25` for the scheme to be
        // self-describing. Regression test for the security-review
        // finding.
        let mut song = populated_open_protocol_song();
        song.title = "100% fun".into();
        let url = serialize_open_protocol(&song);
        let parsed = crate::parse(&url).expect("`%` round trip");
        assert_eq!(parsed.title, "100% fun");
    }

    #[test]
    fn serialize_open_protocol_empty_song_round_trips() {
        // An empty song (default key/TS, no sections, no metadata)
        // is the smallest input the serializer must handle without
        // collapsing fields below the 6-field minimum. Verify the
        // resulting URL parses cleanly back to an equivalent AST.
        let song = IrealSong::new();
        let url = serialize_open_protocol(&song);
        let parsed = crate::parse(&url).expect("empty-song round trip");
        assert_eq!(parsed.key_signature, song.key_signature);
        assert_eq!(parsed.time_signature, song.time_signature);
    }

    #[test]
    fn serialize_open_protocol_macro_phrases_round_trip() {
        // Sister-site coverage for #2427: every D.C. / D.S. spec
        // phrase + the bare forms + an overflow-ordinal (`AlEnding(11)`)
        // case must survive the open-protocol round trip. Any drift
        // between `MusicalSymbol::canonical_text` and the parser's
        // `classify_macro_comment` surfaces here. Mirrors the
        // identical sister-site test for the `irealb_serialize`
        // (obfuscated) path below.
        use crate::ast::JumpTarget;
        let nz = |n: u8| std::num::NonZeroU8::new(n).expect("non-zero ordinal");
        let cases = [
            MusicalSymbol::DaCapo(JumpTarget::Unspecified),
            MusicalSymbol::DaCapo(JumpTarget::AlCoda),
            MusicalSymbol::DaCapo(JumpTarget::AlFine),
            MusicalSymbol::DaCapo(JumpTarget::AlEnding(nz(1))),
            MusicalSymbol::DaCapo(JumpTarget::AlEnding(nz(2))),
            MusicalSymbol::DaCapo(JumpTarget::AlEnding(nz(3))),
            MusicalSymbol::DalSegno(JumpTarget::Unspecified),
            MusicalSymbol::DalSegno(JumpTarget::AlCoda),
            MusicalSymbol::DalSegno(JumpTarget::AlFine),
            MusicalSymbol::DalSegno(JumpTarget::AlEnding(nz(1))),
            MusicalSymbol::DalSegno(JumpTarget::AlEnding(nz(2))),
            MusicalSymbol::DalSegno(JumpTarget::AlEnding(nz(3))),
            // Overflow path: exercises the teen-exception ordinal
            // and confirms the parser does not silently downcast to
            // a different variant on the round trip.
            MusicalSymbol::DaCapo(JumpTarget::AlEnding(nz(11))),
        ];
        for symbol in cases {
            let mut song = populated_open_protocol_song();
            song.sections[0].bars[0].symbol = Some(symbol);
            let url = serialize_open_protocol(&song);
            let parsed = crate::parse(&url).expect("macro phrase round trip");
            assert_eq!(
                parsed.sections[0].bars[0].symbol,
                Some(symbol),
                "macro {symbol:?} lost on open-protocol round trip"
            );
        }
    }

    #[test]
    fn irealb_serialize_macro_phrases_round_trip() {
        // Sister-site coverage for #2427 through the production
        // export format (obfuscated `irealb://`). The shared
        // `serialize_symbol` helper (`serialize.rs`) is exercised by
        // both export paths; this test isolates the obfusc50 +
        // MUSIC_PREFIX pipeline so a regression unique to the
        // obfuscation step fails here rather than slipping past the
        // open-protocol-only macro test.
        use crate::ast::JumpTarget;
        let nz = |n: u8| std::num::NonZeroU8::new(n).expect("non-zero ordinal");
        let cases = [
            MusicalSymbol::DaCapo(JumpTarget::AlCoda),
            MusicalSymbol::DaCapo(JumpTarget::AlFine),
            MusicalSymbol::DaCapo(JumpTarget::AlEnding(nz(3))),
            MusicalSymbol::DalSegno(JumpTarget::AlCoda),
            MusicalSymbol::DalSegno(JumpTarget::AlEnding(nz(2))),
        ];
        for symbol in cases {
            let mut song = populated_open_protocol_song();
            song.sections[0].bars[0].symbol = Some(symbol);
            let url = irealb_serialize(&song);
            let parsed = crate::parse(&url).expect("irealb round trip");
            let found = parsed
                .sections
                .iter()
                .flat_map(|s| s.bars.iter())
                .any(|b| b.symbol == Some(symbol));
            assert!(
                found,
                "macro {symbol:?} lost on irealb_serialize round trip"
            );
        }
    }

    #[test]
    fn serialize_open_protocol_collection_joins_with_single_equals() {
        // Per spec, the open-protocol multi-song body uses a single
        // `=` between songs (not the `===` triple separator of the
        // iReal app's `irealbook://` export). For N songs, that
        // produces exactly N*6 - 1 separators (6 fields per song,
        // joined with a single `=`).
        let song = populated_open_protocol_song();
        let url = serialize_open_protocol_collection(&[song.clone(), song], None);
        assert!(url.starts_with("irealbook://"));
        let body = url.strip_prefix("irealbook://").expect("prefix");
        // Two songs × 6 fields = 12 fields → 11 `=` separators.
        let separator_count = body.matches("%3D").count();
        assert_eq!(
            separator_count, 11,
            "two-song collection must have exactly 11 `=` separators (encoded as %3D), got {separator_count} in {body}"
        );
        // The `===` triple-separator pattern of the export form
        // must NOT appear (its encoded form would be `%3D%3D%3D`).
        assert!(
            !body.contains("%3D%3D%3D"),
            "single-= separator must not produce %3D%3D%3D: {body}"
        );
    }

    #[test]
    fn serialize_open_protocol_collection_appends_playlist_name() {
        let song = populated_open_protocol_song();
        let url =
            serialize_open_protocol_collection(std::slice::from_ref(&song), Some("My Playlist"));
        // The playlist name's space must be encoded.
        assert!(
            url.contains("My%20Playlist"),
            "playlist name must be encoded: {url}"
        );
    }

    #[test]
    fn serialize_time_signature_packed_covers_spec_cases() {
        // The packed-digit form maps each `TimeSignature` to the
        // exact field-5 string the spec's worked example uses.
        // Mirrors [`parse_time_signature`] so the round trip is
        // bit-stable.
        let cases = [
            (TimeSignature::new(4, 4).unwrap(), "44"),
            (TimeSignature::new(3, 4).unwrap(), "34"),
            (TimeSignature::new(6, 8).unwrap(), "68"),
            (TimeSignature::new(12, 8).unwrap(), "128"),
        ];
        for (ts, expected) in cases {
            assert_eq!(
                serialize_time_signature_packed(ts),
                expected,
                "time signature {ts:?} must serialize to `{expected}`"
            );
        }
    }

    #[test]
    fn serialize_open_protocol_non_ascii_metadata_round_trips() {
        // Regression for the non-ASCII byte corruption bug: when a
        // song's title or composer contains multi-byte UTF-8
        // characters, `percent_encode_open_protocol` must
        // individually percent-encode every byte > 0x7F so that
        // `percent_decode` in the parser reassembles the original
        // UTF-8 sequence. The earlier `b as char` cast for non-ASCII
        // bytes reinterpreted each raw byte as a Unicode code point,
        // splitting e.g. the two-byte UTF-8 sequence for `é`
        // (0xC3 0xA9) into U+00C3 (Ã) + U+00A9 (©), corrupting the
        // round-trip.
        let mut song = IrealSong::new();
        song.title = "Café au lait".into();
        song.composer = Some("Ólafur Arnalds".into());
        song.style = Some("Naïve Bossa".into());

        let url = serialize_open_protocol(&song);
        let parsed = crate::parse(&url).expect("non-ASCII round trip");
        assert_eq!(
            parsed.title, song.title,
            "title with accented chars must survive round trip"
        );
        assert_eq!(
            parsed.composer, song.composer,
            "composer with non-ASCII chars must survive round trip"
        );
        assert_eq!(
            parsed.style, song.style,
            "style with non-ASCII chars must survive round trip"
        );
    }
}
