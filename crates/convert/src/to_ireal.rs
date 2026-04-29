//! ChordPro → iReal Pro conversion (#2061).
//!
//! Maps a ChordPro [`Song`] to an [`IrealSong`]. iReal Pro has no
//! lyrics surface, so this direction is **lossy** — every dropped
//! piece of information surfaces as a [`ConversionWarning`] in the
//! [`ConversionOutput`] so the caller can choose to log it,
//! suppress it, or promote it to an error.
//!
//! Documented drops live in `crates/convert/known-deviations.md`;
//! the runtime warnings in this module are the load-bearing
//! contract: **never silently lose data**.

use chordsketch_chordpro::ast::{DirectiveKind, Line, LyricsLine, Song};
use chordsketch_ireal::{
    Accidental, Bar, BarChord, BarLine, BeatPosition, Chord as IrealChord, ChordQuality, ChordRoot,
    IrealSong, KeyMode, KeySignature, Section, SectionLabel, TimeSignature,
};

use crate::error::{ConversionWarning, WarningKind};
use crate::{ConversionError, ConversionOutput};

/// Converts a ChordPro [`Song`] to an [`IrealSong`].
///
/// Pure function — the [`crate::ireal::ChordProToIreal`] marker
/// struct delegates to this. Returns
/// [`ConversionOutput::warnings`] populated with one entry per
/// dropped or approximated item; the main `output` is the
/// best-effort iReal AST.
///
/// # Errors
///
/// The current mapping never returns `Err` — every well-formed
/// [`Song`] produces a (possibly warning-laden) [`IrealSong`].
/// The [`ConversionError`] return type is preserved so future
/// strictness-mode hooks can introduce
/// [`ConversionError::InvalidSource`] without a breaking change.
pub fn convert(source: &Song) -> Result<ConversionOutput<IrealSong>, ConversionError> {
    let mut warnings = Vec::new();
    let mut ireal = IrealSong::new();

    populate_metadata(&mut ireal, source, &mut warnings);
    populate_extras_from_directives(&mut ireal, source);
    populate_sections(&mut ireal, source, &mut warnings);
    push_unsupported_warnings(&mut warnings, source);

    Ok(ConversionOutput {
        output: ireal,
        warnings,
    })
}

fn populate_metadata(ireal: &mut IrealSong, source: &Song, warnings: &mut Vec<ConversionWarning>) {
    if let Some(title) = source.metadata.title.as_deref() {
        if !title.trim().is_empty() {
            ireal.title = title.to_owned();
        }
    }
    if let Some(composer) = source.metadata.composers.first() {
        if !composer.trim().is_empty() {
            ireal.composer = Some(composer.clone());
        }
    }
    if let Some(key_str) = source.metadata.key.as_deref() {
        if let Some(ks) = parse_chordpro_key(key_str) {
            ireal.key_signature = ks;
        }
    }
    if let Some(time_str) = source.metadata.time.as_deref() {
        if let Some(ts) = parse_chordpro_time(time_str) {
            ireal.time_signature = ts;
        }
    }
    if let Some(tempo_str) = source.metadata.tempo.as_deref() {
        if let Ok(n) = tempo_str.parse::<u16>() {
            if n > 0 {
                ireal.tempo = Some(n);
            }
        }
    }
    // Surface dropped metadata categories iReal cannot represent.
    if !source.metadata.subtitles.is_empty() {
        warnings.push(ConversionWarning::new(
            WarningKind::LossyDrop,
            "subtitle dropped — iReal has no subtitle field",
        ));
    }
    if !source.metadata.artists.is_empty() {
        warnings.push(ConversionWarning::new(
            WarningKind::LossyDrop,
            "artist dropped — iReal does not separate composer / artist",
        ));
    }
    if !source.metadata.lyricists.is_empty() {
        warnings.push(ConversionWarning::new(
            WarningKind::LossyDrop,
            "lyricist dropped — iReal has no lyricist field",
        ));
    }
    if source.metadata.album.is_some() {
        warnings.push(ConversionWarning::new(
            WarningKind::LossyDrop,
            "album dropped — iReal has no album field",
        ));
    }
    if source.metadata.year.is_some() {
        warnings.push(ConversionWarning::new(
            WarningKind::LossyDrop,
            "year dropped — iReal has no year field",
        ));
    }
    if source.metadata.copyright.is_some() {
        warnings.push(ConversionWarning::new(
            WarningKind::LossyDrop,
            "copyright dropped — iReal has no copyright field",
        ));
    }
    if !source.metadata.tags.is_empty() {
        warnings.push(ConversionWarning::new(
            WarningKind::LossyDrop,
            "tags dropped — iReal has no tag field",
        ));
    }
}

fn populate_extras_from_directives(ireal: &mut IrealSong, source: &Song) {
    // The iReal-specific style tag is round-tripped via
    // `{meta: style <name>}`, mirroring what `from_ireal` emits.
    // Other `{meta}` lines (e.g. arbitrary key-value pairs) are
    // recorded as a single `LossyDrop` warning above; here we
    // only consume the `style` flavour.
    for line in &source.lines {
        if let Line::Directive(d) = line {
            if d.name == "meta" {
                if let Some(value) = d.value.as_deref() {
                    if let Some(rest) = value.strip_prefix("style ") {
                        let trimmed = rest.trim();
                        if !trimmed.is_empty() {
                            ireal.style = Some(trimmed.to_owned());
                        }
                    }
                }
            }
            // Some ChordPro files set `{transpose: N}`. iReal
            // stores transpose in `[-11, 11]`; clamp out-of-range
            // values silently — the parser does the same.
            if d.kind == DirectiveKind::Transpose {
                if let Some(value) = d.value.as_deref() {
                    if let Ok(n) = value.parse::<i8>() {
                        ireal.transpose = n.clamp(-11, 11);
                    }
                }
            }
        }
    }
}

fn populate_sections(ireal: &mut IrealSong, source: &Song, warnings: &mut Vec<ConversionWarning>) {
    let mut sections: Vec<Section> = Vec::new();
    let mut current: Option<Section> = None;
    let mut has_default_section = false;
    let mut had_lyric_text = false;
    let mut had_comment = false;

    for line in &source.lines {
        match line {
            Line::Directive(d) => match d.kind {
                DirectiveKind::StartOfVerse => {
                    push_current(&mut current, &mut sections);
                    current = Some(Section::new(SectionLabel::Verse));
                }
                DirectiveKind::StartOfChorus => {
                    push_current(&mut current, &mut sections);
                    current = Some(Section::new(SectionLabel::Chorus));
                }
                DirectiveKind::StartOfBridge => {
                    push_current(&mut current, &mut sections);
                    current = Some(Section::new(SectionLabel::Bridge));
                }
                DirectiveKind::EndOfVerse
                | DirectiveKind::EndOfChorus
                | DirectiveKind::EndOfBridge => {
                    push_current(&mut current, &mut sections);
                }
                _ => {
                    // Other directives (font, color, custom) drop
                    // silently here; the per-class warnings are
                    // surfaced once at the end via
                    // `push_unsupported_warnings`.
                }
            },
            Line::Lyrics(lyrics) => {
                let (bar, dropped_text) = build_bar_from_lyrics(lyrics);
                if dropped_text {
                    had_lyric_text = true;
                }
                if !bar.chords.is_empty() {
                    if current.is_none() {
                        current = Some(Section::new(SectionLabel::Letter('A')));
                        has_default_section = true;
                    }
                    if let Some(section) = current.as_mut() {
                        section.bars.push(bar);
                    }
                }
            }
            Line::Comment(_, _) => {
                had_comment = true;
            }
            Line::Empty => {}
        }
    }
    push_current(&mut current, &mut sections);

    if had_lyric_text {
        warnings.push(ConversionWarning::new(
            WarningKind::LossyDrop,
            "lyrics dropped — iReal Pro has no lyrics surface",
        ));
    }
    if had_comment {
        warnings.push(ConversionWarning::new(
            WarningKind::LossyDrop,
            "{comment} lines dropped — iReal Pro has no inline comment surface",
        ));
    }
    if has_default_section {
        warnings.push(ConversionWarning::new(
            WarningKind::Approximated,
            "no ChordPro section directive found; chords routed into a default `Section A`",
        ));
    }
    ireal.sections = sections;
}

fn push_current(current: &mut Option<Section>, sections: &mut Vec<Section>) {
    if let Some(section) = current.take() {
        if !section.bars.is_empty() {
            sections.push(section);
        }
    }
}

fn build_bar_from_lyrics(lyrics: &LyricsLine) -> (Bar, bool) {
    let mut bar = Bar::new();
    let mut dropped_lyric_text = false;
    for segment in &lyrics.segments {
        if !segment.text.trim().is_empty() {
            dropped_lyric_text = true;
        }
        if let Some(chord) = segment.chord.as_ref() {
            let parsed = parse_chordpro_chord(&chord.name);
            bar.chords.push(BarChord {
                chord: parsed,
                position: BeatPosition::on_beat(1).unwrap(),
            });
        }
    }
    bar.start = BarLine::Single;
    bar.end = BarLine::Single;
    (bar, dropped_lyric_text)
}

fn push_unsupported_warnings(warnings: &mut Vec<ConversionWarning>, source: &Song) {
    let mut had_font = false;
    let mut had_color = false;
    let mut had_capo = false;
    let mut had_chord_def = false;
    let mut had_other_meta = false;

    for line in &source.lines {
        if let Line::Directive(d) = line {
            match d.kind {
                DirectiveKind::TextFont
                | DirectiveKind::ChordFont
                | DirectiveKind::TabFont
                | DirectiveKind::TextSize
                | DirectiveKind::ChordSize
                | DirectiveKind::TabSize => {
                    had_font = true;
                }
                DirectiveKind::TextColour
                | DirectiveKind::ChordColour
                | DirectiveKind::TabColour => {
                    had_color = true;
                }
                DirectiveKind::Capo => {
                    had_capo = true;
                }
                DirectiveKind::Define => {
                    had_chord_def = true;
                }
                _ => {}
            }
            // `{meta}` directives that are not the iReal-style
            // pass-through (`meta: style ...`) become a single
            // aggregated warning so callers know not every meta
            // value round-trips.
            if d.name == "meta" {
                if let Some(value) = d.value.as_deref() {
                    if !value.trim().starts_with("style ") {
                        had_other_meta = true;
                    }
                }
            }
        }
    }

    if had_font {
        warnings.push(ConversionWarning::new(
            WarningKind::LossyDrop,
            "font / size directives dropped — iReal has no typography surface",
        ));
    }
    if had_color {
        warnings.push(ConversionWarning::new(
            WarningKind::LossyDrop,
            "colour directives dropped — iReal has no theming surface",
        ));
    }
    if had_capo {
        warnings.push(ConversionWarning::new(
            WarningKind::LossyDrop,
            "{capo} dropped — iReal has no capo surface",
        ));
    }
    if had_chord_def {
        warnings.push(ConversionWarning::new(
            WarningKind::LossyDrop,
            "{define} chord-shape directives dropped — iReal stores only chord names",
        ));
    }
    if had_other_meta {
        warnings.push(ConversionWarning::new(
            WarningKind::LossyDrop,
            "non-style {meta} directives dropped — only `meta: style …` round-trips to iReal",
        ));
    }
}

// ---------------------------------------------------------------------------
// Chord / key / time parsing
// ---------------------------------------------------------------------------

fn parse_chordpro_chord(name: &str) -> IrealChord {
    let mut chars = name.chars();
    let root_char = chars.next().unwrap_or('C');
    let mut iter = chars.clone();
    let (acc_consumed, root_acc) = match iter.next() {
        Some('#') => ('#'.len_utf8(), Accidental::Sharp),
        Some('b') => ('b'.len_utf8(), Accidental::Flat),
        _ => (0, Accidental::Natural),
    };
    let after_root = root_char.len_utf8() + acc_consumed;
    let body = &name[after_root..];
    let (quality_str, bass_str) = match body.find('/') {
        Some(idx) => (&body[..idx], Some(&body[idx + '/'.len_utf8()..])),
        None => (body, None),
    };
    let quality = parse_chordpro_quality(quality_str);
    let root = ChordRoot {
        note: if matches!(root_char, 'A'..='G') {
            root_char
        } else {
            'C'
        },
        accidental: root_acc,
    };
    let bass = bass_str.and_then(parse_bass);
    IrealChord {
        root,
        quality,
        bass,
    }
}

fn parse_bass(s: &str) -> Option<ChordRoot> {
    let mut chars = s.chars();
    let note = chars.next()?;
    if !matches!(note, 'A'..='G') {
        return None;
    }
    let acc = match chars.next() {
        Some('#') => Accidental::Sharp,
        Some('b') => Accidental::Flat,
        _ => Accidental::Natural,
    };
    Some(ChordRoot {
        note,
        accidental: acc,
    })
}

fn parse_chordpro_quality(token: &str) -> ChordQuality {
    match token {
        "" => ChordQuality::Major,
        "m" | "min" | "-" => ChordQuality::Minor,
        "dim" | "o" => ChordQuality::Diminished,
        "aug" | "+" => ChordQuality::Augmented,
        "maj7" | "M7" | "^7" => ChordQuality::Major7,
        "m7" | "min7" | "-7" => ChordQuality::Minor7,
        "7" => ChordQuality::Dominant7,
        "m7b5" | "h" | "h7" => ChordQuality::HalfDiminished,
        "dim7" | "o7" => ChordQuality::Diminished7,
        "sus2" => ChordQuality::Suspended2,
        "sus" | "sus4" => ChordQuality::Suspended4,
        other => ChordQuality::Custom(other.to_owned()),
    }
}

fn parse_chordpro_key(s: &str) -> Option<KeySignature> {
    let mut chars = s.chars();
    let note = chars.next()?;
    if !matches!(note, 'A'..='G') {
        return None;
    }
    let mut peek = chars.clone();
    let acc = match peek.next() {
        Some('#') => {
            chars.next();
            Accidental::Sharp
        }
        Some('b') => {
            chars.next();
            Accidental::Flat
        }
        _ => Accidental::Natural,
    };
    let rest: String = chars.collect();
    let mode = if rest.eq_ignore_ascii_case("m") || rest.eq_ignore_ascii_case("min") {
        KeyMode::Minor
    } else {
        KeyMode::Major
    };
    Some(KeySignature {
        root: ChordRoot {
            note,
            accidental: acc,
        },
        mode,
    })
}

fn parse_chordpro_time(s: &str) -> Option<TimeSignature> {
    let mut parts = s.split('/');
    let num_str = parts.next()?;
    let den_str = parts.next()?;
    let num: u8 = num_str.trim().parse().ok()?;
    let den: u8 = den_str.trim().parse().ok()?;
    TimeSignature::new(num, den)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chordsketch_chordpro::ast::{Chord as ChordProChord, Directive, LyricsSegment, Metadata};

    fn song_with_metadata(
        title: &str,
        composer: Option<&str>,
        key: Option<&str>,
        tempo: Option<&str>,
        time: Option<&str>,
    ) -> Song {
        let mut song = Song::new();
        song.metadata = Metadata {
            title: Some(title.to_owned()),
            composers: composer.into_iter().map(str::to_owned).collect(),
            key: key.map(str::to_owned),
            tempo: tempo.map(str::to_owned),
            time: time.map(str::to_owned),
            ..Metadata::new()
        };
        song
    }

    #[test]
    fn metadata_maps_to_ireal_fields() {
        let song = song_with_metadata(
            "Autumn Leaves",
            Some("Joseph Kosma"),
            Some("Em"),
            Some("120"),
            Some("4/4"),
        );
        let result = convert(&song).unwrap();
        let ir = &result.output;
        assert_eq!(ir.title, "Autumn Leaves");
        assert_eq!(ir.composer.as_deref(), Some("Joseph Kosma"));
        assert_eq!(ir.key_signature.root.note, 'E');
        assert_eq!(ir.key_signature.mode, KeyMode::Minor);
        assert_eq!(ir.time_signature.numerator, 4);
        assert_eq!(ir.tempo, Some(120));
    }

    #[test]
    fn meta_style_directive_routes_to_ireal_style() {
        let mut song = song_with_metadata("T", None, None, None, None);
        song.lines.push(Line::Directive(Directive::with_value(
            "meta",
            "style Bossa Nova",
        )));
        let ir = convert(&song).unwrap().output;
        assert_eq!(ir.style.as_deref(), Some("Bossa Nova"));
    }

    #[test]
    fn lyric_text_drop_emits_warning() {
        let mut song = song_with_metadata("T", None, None, None, None);
        let lyrics = LyricsLine {
            segments: vec![LyricsSegment::new(
                Some(ChordProChord::new("C")),
                "Hello world",
            )],
        };
        song.lines.push(Line::Lyrics(lyrics));
        let result = convert(&song).unwrap();
        assert!(
            result
                .warnings
                .iter()
                .any(|w| matches!(w.kind, WarningKind::LossyDrop) && w.message.contains("lyrics"))
        );
    }

    #[test]
    fn chord_segments_become_bars() {
        let mut song = song_with_metadata("T", None, None, None, None);
        song.lines
            .push(Line::Directive(Directive::name_only("start_of_verse")));
        song.lines.push(Line::Lyrics(LyricsLine {
            segments: vec![
                LyricsSegment::new(Some(ChordProChord::new("Cm7")), ""),
                LyricsSegment::new(Some(ChordProChord::new("F7")), ""),
            ],
        }));
        song.lines
            .push(Line::Directive(Directive::name_only("end_of_verse")));
        let ir = convert(&song).unwrap().output;
        assert_eq!(ir.sections.len(), 1);
        assert_eq!(ir.sections[0].label, SectionLabel::Verse);
        assert_eq!(ir.sections[0].bars.len(), 1);
        assert_eq!(ir.sections[0].bars[0].chords.len(), 2);
        assert_eq!(ir.sections[0].bars[0].chords[0].chord.root.note, 'C');
        assert_eq!(
            ir.sections[0].bars[0].chords[0].chord.quality,
            ChordQuality::Minor7
        );
    }

    #[test]
    fn lyrics_without_section_directive_routes_into_default_section_a() {
        let mut song = song_with_metadata("T", None, None, None, None);
        song.lines.push(Line::Lyrics(LyricsLine {
            segments: vec![LyricsSegment::new(Some(ChordProChord::new("C")), "")],
        }));
        let result = convert(&song).unwrap();
        assert_eq!(result.output.sections.len(), 1);
        assert_eq!(result.output.sections[0].label, SectionLabel::Letter('A'));
        // Default-section warning surfaced.
        assert!(
            result
                .warnings
                .iter()
                .any(|w| matches!(w.kind, WarningKind::Approximated))
        );
    }

    #[test]
    fn chord_parser_recognises_canonical_qualities() {
        assert_eq!(parse_chordpro_chord("C").quality, ChordQuality::Major);
        assert_eq!(parse_chordpro_chord("Cm").quality, ChordQuality::Minor);
        assert_eq!(parse_chordpro_chord("Cm7").quality, ChordQuality::Minor7);
        assert_eq!(parse_chordpro_chord("Cmaj7").quality, ChordQuality::Major7);
        assert_eq!(parse_chordpro_chord("C7").quality, ChordQuality::Dominant7);
        assert_eq!(
            parse_chordpro_chord("Cdim").quality,
            ChordQuality::Diminished
        );
        assert_eq!(
            parse_chordpro_chord("Cdim7").quality,
            ChordQuality::Diminished7
        );
        assert!(matches!(
            parse_chordpro_chord("C13b9").quality,
            ChordQuality::Custom(s) if s == "13b9"
        ));
    }

    #[test]
    fn slash_chord_parses_bass_note() {
        let c = parse_chordpro_chord("C/G#");
        assert_eq!(c.root.note, 'C');
        let bass = c.bass.unwrap();
        assert_eq!(bass.note, 'G');
        assert_eq!(bass.accidental, Accidental::Sharp);
    }

    #[test]
    fn key_parser_handles_minor_suffix() {
        let k = parse_chordpro_key("Dm").unwrap();
        assert_eq!(k.root.note, 'D');
        assert_eq!(k.mode, KeyMode::Minor);
        let k = parse_chordpro_key("F#").unwrap();
        assert_eq!(k.root.note, 'F');
        assert_eq!(k.root.accidental, Accidental::Sharp);
        assert_eq!(k.mode, KeyMode::Major);
    }

    #[test]
    fn time_parser_validates_ireal_range() {
        assert!(parse_chordpro_time("4/4").is_some());
        assert!(parse_chordpro_time("3/4").is_some());
        assert!(parse_chordpro_time("12/8").is_some());
        // 4/16 is rejected by `TimeSignature::new` (denominators
        // limited to 2 / 4 / 8).
        assert!(parse_chordpro_time("4/16").is_none());
    }

    #[test]
    fn font_directive_emits_lossy_warning() {
        let mut song = song_with_metadata("T", None, None, None, None);
        song.lines.push(Line::Directive(Directive::with_value(
            "textfont",
            "Helvetica",
        )));
        let result = convert(&song).unwrap();
        assert!(result.warnings.iter().any(|w| w.message.contains("font")));
    }

    #[test]
    fn capo_directive_emits_lossy_warning() {
        let mut song = song_with_metadata("T", None, None, None, None);
        song.lines
            .push(Line::Directive(Directive::with_value("capo", "3")));
        let result = convert(&song).unwrap();
        assert!(result.warnings.iter().any(|w| w.message.contains("capo")));
    }
}
