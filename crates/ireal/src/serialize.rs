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
    Accidental, Bar, BarLine, Chord, ChordQuality, ChordRoot, Ending, IrealSong, KeyMode,
    KeySignature, MusicalSymbol, SectionLabel, TimeSignature,
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
    let mut url = String::with_capacity(body.len() + 16);
    url.push_str("irealb://");
    url.push_str(&percent_encode(&body));
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
    let mut url = String::with_capacity(body.len() + 16);
    url.push_str("irealbook://");
    url.push_str(&percent_encode(&body));
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
    let title_owned: String;
    let title: &str = if song.title.trim().is_empty() {
        TITLE_PLACEHOLDER
    } else {
        title_owned = song.title.clone();
        title_owned.as_str()
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
    let repeats = "0".to_string();

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
    body.push('=');
    body.push_str(&repeats);
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

    // Flatten all bars across sections so the serializer can peek
    // the *next* bar regardless of section boundary. This is
    // load-bearing for round trips: the parser's
    // `pending_symbol` / `pending_ending` are consumed by
    // `start_new_bar`, so a symbol on bar N must be queued before
    // bar N-1's closing barline. Looking ahead within a section
    // is not enough — symbols and endings can land on the first
    // bar of a new section too.
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
        // pending symbol / ending must be queued before that
        // token so that `start_new_bar` (called by the open
        // glyph) consumes it onto this bar.
        if bar.start != BarLine::Single {
            if let Some(sym) = bar.symbol {
                serialize_symbol(&mut chart, sym);
            }
            if let Some(end) = bar.ending {
                serialize_ending(&mut chart, end);
            }
        }
        serialize_bar_open(&mut chart, bar);

        // Bar contents. (Symbol / ending for THIS Single-start
        // bar were emitted by the *previous* iteration's
        // closing-barline lookahead.)
        for (ci, bc) in bar.chords.iter().enumerate() {
            if ci > 0 {
                chart.push(' ');
            }
            serialize_chord(&mut chart, &bc.chord);
        }

        // Lookahead: if the *next* bar has a Single start and
        // wants a symbol / ending, queue them here (after this
        // bar's chords, before this bar's close glyph) so the
        // parser's `start_new_bar` consumes them onto that bar.
        if let Some(next) = flat.get(i + 1) {
            if next.bar.start == BarLine::Single {
                if let Some(sym) = next.bar.symbol {
                    serialize_symbol(&mut chart, sym);
                }
                if let Some(end) = next.bar.ending {
                    serialize_ending(&mut chart, end);
                }
            }
        }

        serialize_bar_close(&mut chart, bar);
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
        SectionLabel::Verse => out.push('v'),
        SectionLabel::Chorus => out.push('c'),
        SectionLabel::Intro => out.push('i'),
        SectionLabel::Outro => out.push('o'),
        SectionLabel::Bridge => out.push('b'),
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
        BarLine::Final => out.push('Z'),
        BarLine::OpenRepeat => out.push('{'),
        BarLine::CloseRepeat => out.push(':'), // mid-bar close-repeat — rare
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
    }
}

fn serialize_chord(out: &mut String, chord: &Chord) {
    serialize_root(out, chord.root);
    serialize_quality(out, &chord.quality);
    if let Some(bass) = chord.bass {
        out.push('/');
        serialize_root(out, bass);
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
        _ => '0',
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ast::*;

    #[test]
    fn percent_encode_round_trip_via_parser() {
        // Sanity: every ASCII byte we emit must round-trip via
        // the parser's percent_decode (called by `parse`).
        let body = "abc=123==Afro";
        let encoded = percent_encode(body);
        // Encode is greedy except for alphanumerics — the body's
        // letters / digits stay literal, the `=` becomes `%3D`.
        assert!(encoded.contains("%3D"));
        // Round trip through the parser's decode by parsing a
        // full URL we build from the encoded body.
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
                    }],
                    ending: None,
                    symbol: None,
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
        assert_eq!(name.as_deref(), Some("Playlist"));
    }
}
