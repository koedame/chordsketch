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
    Accidental, Bar, BarLine, Chord, ChordQuality, ChordRoot, ChordSize, Ending, IrealSong,
    KeyMode, KeySignature, MusicalSymbol, SectionLabel, TimeSignature,
};
use crate::parser::{MUSIC_PREFIX, matches_macro_prefix};

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
        // already triggers a macro symbol on re-parse, so we can
        // skip emitting a redundant `<D.C.>` / `<D.S.>` /
        // `<Fine>` pseudo-comment.
        // Mirror `apply_comment`'s anchored macro detection: the
        // suppression must agree with what the parser would
        // re-derive on round-trip. A naive substring `contains`
        // here flagged ordinary words like `refine` / `define`,
        // dropping a perfectly legitimate `bar.symbol` because the
        // text_comment happened to share a substring with a
        // recognised macro.
        let text_carries_macro = |b: &Bar| {
            b.text_comment
                .as_deref()
                .map(|t| {
                    let lower = t.trim().to_ascii_lowercase();
                    matches_macro_prefix(&lower, "d.c.")
                        || matches_macro_prefix(&lower, "d.s.")
                        || matches_macro_prefix(&lower, "fine")
                        || matches_macro_prefix(&lower, "break")
                })
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
            serialize_chord(&mut chart, &bc.chord);
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

    // The parser strips `MUSIC_PREFIX` after split; the
    // serializer prepends it before applying obfusc50 + assembly.
    let scrambled = obfusc50_apply(&chart);
    let mut music = String::with_capacity(MUSIC_PREFIX.len() + scrambled.len());
    music.push_str(MUSIC_PREFIX);
    music.push_str(&scrambled);
    music
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
    out.push(char::from(b'0' + ending.number()));
}

fn serialize_symbol(out: &mut String, symbol: MusicalSymbol) {
    match symbol {
        MusicalSymbol::Segno => out.push('S'),
        MusicalSymbol::Coda => out.push('Q'),
        MusicalSymbol::DaCapo => out.push_str("<D.C.>"),
        MusicalSymbol::DalSegno => out.push_str("<D.S.>"),
        MusicalSymbol::Fine => out.push_str("<Fine>"),
        MusicalSymbol::Fermata => out.push('f'),
        MusicalSymbol::Break => out.push_str("<Break>"),
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
                    }],
                    ending: None,
                    symbol: None,
                    repeat_previous: false,
                    no_chord: false,
                    text_comment: None,
                    system_break_space: 0,
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
                }],
                ending: None,
                symbol: None,
                repeat_previous: false,
                no_chord: false,
                text_comment: None,
                system_break_space: 0,
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
                    }],
                    ending: None,
                    symbol: Some(MusicalSymbol::Fine),
                    repeat_previous: false,
                    no_chord: false,
                    text_comment: None,
                    system_break_space: 0,
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
                    }],
                    ending: None,
                    symbol: Some(MusicalSymbol::Break),
                    repeat_previous: false,
                    no_chord: false,
                    text_comment: None,
                    system_break_space: 0,
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
                    }],
                    ending: None,
                    symbol: Some(MusicalSymbol::DaCapo),
                    repeat_previous: false,
                    no_chord: false,
                    text_comment: None,
                    system_break_space: 0,
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
            .any(|b| b.symbol == Some(MusicalSymbol::DaCapo));
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
                    }],
                    ending: None,
                    symbol: Some(MusicalSymbol::DalSegno),
                    repeat_previous: false,
                    no_chord: false,
                    text_comment: None,
                    system_break_space: 0,
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
            .any(|b| b.symbol == Some(MusicalSymbol::DalSegno));
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
                    }],
                    ending: None,
                    symbol: Some(MusicalSymbol::Fermata),
                    repeat_previous: false,
                    no_chord: false,
                    text_comment: None,
                    system_break_space: 0,
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
                        }],
                        system_break_space: 2,
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
                        }],
                        system_break_space: 2,
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
                        }],
                        ..Default::default()
                    },
                    Bar {
                        start: BarLine::Single,
                        end: BarLine::Final,
                        repeat_previous: true,
                        system_break_space: 1,
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
                    }],
                    system_break_space: 1,
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
}
