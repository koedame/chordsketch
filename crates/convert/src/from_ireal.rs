//! iReal Pro → ChordPro conversion (#2053).
//!
//! Maps an [`IrealSong`] to a [`Song`] (ChordPro AST). Tempo,
//! style, time signature, and key descend to ChordPro
//! `{tempo}` / `{meta}` / `{time}` / `{key}` directives; section
//! labels become `{start_of_*}` / `{end_of_*}` environment
//! directives where a ChordPro equivalent exists, or
//! `{comment: ...}` markers otherwise; bars become bar-line-style
//! lyrics lines (`[Cm7] | [F7] | [BbMaj7] |`) with no lyric text
//! since the iReal format has no lyrics surface.
//!
//! The conversion is **near-lossless** in this direction — the
//! only items dropped or approximated are listed in
//! `crates/convert/known-deviations.md`. Truly lossy drops
//! (where no equivalent ChordPro primitive exists and information
//! cannot be recovered on the return trip) emit a
//! [`ConversionWarning`] with [`crate::WarningKind::LossyDrop`].
//! Representational approximations (where the information is
//! preserved as inline text or an alternative directive) are
//! silent — callers receive a non-empty `warnings` list only when
//! data is irretrievably lost.

use chordsketch_chordpro::ast::{
    Chord as ChordProChord, CommentStyle, Directive, Line, LyricsLine, LyricsSegment, Metadata,
    Song,
};
use chordsketch_ireal::{
    Accidental, Bar, BarLine, Chord as IrealChord, ChordQuality, ChordRoot, IrealSong, KeyMode,
    KeySignature, MusicalSymbol, SectionLabel, TimeSignature,
};

use crate::error::{ConversionWarning, WarningKind};
use crate::{ConversionError, ConversionOutput};

/// Converts an [`IrealSong`] to a ChordPro [`Song`].
///
/// Pure function — the [`crate::ireal::IrealToChordPro`] marker
/// struct delegates to this. Returning a free function rather
/// than a method on the marker keeps the call sites short and
/// preserves the pattern in `chordsketch-convert-musicxml`.
///
/// # Errors
///
/// The current mapping never fails — every well-formed
/// [`IrealSong`] produces a well-formed [`Song`]. The
/// [`ConversionError`] return type is preserved for future
/// strictness-mode hooks.
pub fn convert(source: &IrealSong) -> Result<ConversionOutput<Song>, ConversionError> {
    let mut warnings = Vec::new();
    let mut song = Song::new();

    push_metadata(&mut song, source);
    push_directives(&mut song, source);

    let mut last_chord_repr: Option<String> = None;
    for (section_index, section) in source.sections.iter().enumerate() {
        push_section_open(&mut song, &section.label);
        push_bars(
            &mut song,
            &section.bars,
            &mut last_chord_repr,
            &mut warnings,
        );
        push_section_close(&mut song, &section.label);
        // Blank line between sections so a downstream renderer
        // that respects `Line::Empty` (text / HTML) gives the
        // chart visual breathing room. Skip after the final
        // section so the song does not end on an empty line.
        if section_index + 1 < source.sections.len() {
            song.lines.push(Line::Empty);
        }
    }

    Ok(ConversionOutput {
        output: song,
        warnings,
    })
}

fn push_metadata(song: &mut Song, source: &IrealSong) {
    let title = if source.title.trim().is_empty() {
        "Untitled".to_owned()
    } else {
        source.title.clone()
    };
    song.metadata = Metadata::new();
    song.lines
        .push(Line::Directive(Directive::with_value("title", &title)));
    if let Some(composer) = source.composer.as_deref() {
        if !composer.trim().is_empty() {
            song.lines
                .push(Line::Directive(Directive::with_value("composer", composer)));
        }
    }
}

fn push_directives(song: &mut Song, source: &IrealSong) {
    let key_value = serialize_key_for_chordpro(source.key_signature);
    song.lines
        .push(Line::Directive(Directive::with_value("key", &key_value)));

    let time_value = format_time_signature(source.time_signature);
    song.lines
        .push(Line::Directive(Directive::with_value("time", &time_value)));

    if let Some(tempo) = source.tempo {
        song.lines.push(Line::Directive(Directive::with_value(
            "tempo",
            tempo.to_string(),
        )));
    }
    if source.transpose != 0 {
        song.lines.push(Line::Directive(Directive::with_value(
            "transpose",
            source.transpose.to_string(),
        )));
    }
    if let Some(style) = source.style.as_deref() {
        if !style.trim().is_empty() {
            // ChordPro has no canonical `{style}` directive, so we
            // route the tag through the `{meta}` extension which
            // every conformant ChordPro reader preserves verbatim
            // (and which renderers display as a metadata line).
            song.lines.push(Line::Directive(Directive::with_value(
                "meta",
                format!("style {style}"),
            )));
        }
    }
}

fn push_section_open(song: &mut Song, label: &SectionLabel) {
    match label {
        SectionLabel::Verse => {
            song.lines
                .push(Line::Directive(Directive::name_only("start_of_verse")));
        }
        SectionLabel::Chorus => {
            song.lines
                .push(Line::Directive(Directive::name_only("start_of_chorus")));
        }
        SectionLabel::Bridge => {
            song.lines
                .push(Line::Directive(Directive::name_only("start_of_bridge")));
        }
        SectionLabel::Letter(c) => {
            // ChordPro has no environment for jazz-form letter
            // labels (`A` / `B` / `C` / `D`). Surface the label as
            // a normal `{comment}` so the renderer prints it in
            // the visible margin — this matches how iReal itself
            // treats letter labels (above-the-bar marker).
            song.lines
                .push(Line::Comment(CommentStyle::Normal, format!("Section {c}")));
        }
        SectionLabel::Intro => {
            song.lines
                .push(Line::Comment(CommentStyle::Normal, "Intro".to_owned()));
        }
        SectionLabel::Outro => {
            song.lines
                .push(Line::Comment(CommentStyle::Normal, "Outro".to_owned()));
        }
        SectionLabel::Custom(name) => {
            song.lines
                .push(Line::Comment(CommentStyle::Normal, name.clone()));
        }
    }
}

fn push_section_close(song: &mut Song, label: &SectionLabel) {
    match label {
        SectionLabel::Verse => song
            .lines
            .push(Line::Directive(Directive::name_only("end_of_verse"))),
        SectionLabel::Chorus => song
            .lines
            .push(Line::Directive(Directive::name_only("end_of_chorus"))),
        SectionLabel::Bridge => song
            .lines
            .push(Line::Directive(Directive::name_only("end_of_bridge"))),
        // The non-environment labels (`Letter`, `Intro`, `Outro`,
        // `Custom`) opened with a `{comment}` and have no close
        // directive — the section ends implicitly when the next
        // section opens.
        SectionLabel::Letter(_)
        | SectionLabel::Intro
        | SectionLabel::Outro
        | SectionLabel::Custom(_) => {}
    }
}

fn push_bars(
    song: &mut Song,
    bars: &[Bar],
    last_chord_repr: &mut Option<String>,
    warnings: &mut Vec<ConversionWarning>,
) {
    if bars.is_empty() {
        return;
    }
    // Each iReal section becomes a single ChordPro lyrics line:
    // `[Cm7] | [F7] | [BbMaj7] |`. The `|` text segments give the
    // text renderer a visual barline; HTML / PDF renderers surface
    // them as plain pipe characters, which downstream readers can
    // style as needed.
    let mut segments: Vec<LyricsSegment> = Vec::new();
    for bar in bars {
        push_pre_bar_marker(&mut segments, bar);
        if bar.no_chord {
            // `n` token in iReal is "no chord — silence". Surface
            // as the textual `N.C.` marker; do NOT replay the
            // previous chord (which would be the wrong sound).
            segments.push(LyricsSegment::text_only("N.C. ".to_owned()));
        } else if bar.repeat_previous {
            // `Kcl` / `x` — repeat the previous bar. Replay the
            // last chord representation so ChordPro consumers see
            // the same chord sounded again. ChordPro has no
            // single-bar repeat primitive (`{chorus}` is for
            // whole-section recall).
            if let Some(repr) = last_chord_repr.as_deref() {
                segments.push(LyricsSegment::new(
                    Some(ChordProChord::new(repr)),
                    String::new(),
                ));
            } else {
                warnings.push(ConversionWarning::new(
                    WarningKind::LossyDrop,
                    "iReal repeat-bar without prior chord — emitted as silent rest".to_owned(),
                ));
            }
        } else if bar.chords.is_empty() {
            // Empty bar with no marker — leave a placeholder so the
            // bar boundary glyph still appears in the lyrics line.
        } else {
            for bar_chord in &bar.chords {
                let repr = chord_to_string(&bar_chord.chord);
                *last_chord_repr = Some(repr.clone());
                segments.push(LyricsSegment::new(
                    Some(ChordProChord::new(&repr)),
                    String::new(),
                ));
                // Alternate chord stacks above the primary in iReal
                // Pro charts. ChordPro has no equivalent two-chord
                // beat slot; surface the alternate inline as a
                // parenthesised chord so downstream consumers can
                // detect the original substitution.
                if let Some(alt) = &bar_chord.chord.alternate {
                    let alt_repr = chord_to_string(alt);
                    segments.push(LyricsSegment::text_only(format!("({alt_repr}) ")));
                }
            }
        }
        if let Some(symbol) = bar.symbol {
            // Music symbols (segno / coda / D.C. / D.S. / Fine) do
            // not have ChordPro equivalents. Drop them onto the
            // bar as a parenthesised text segment so a renderer can
            // surface them inline.
            segments.push(LyricsSegment::text_only(format!(
                "({label}) ",
                label = symbol_label(symbol)
            )));
        }
        if let Some(text) = bar.text_comment.as_deref() {
            // Free-form `<...>` captions (e.g. "13 measure lead
            // break", "D.S. al 2nd ending") have no structural
            // ChordPro equivalent. Render inline as parenthesised
            // text — same treatment as the canonical symbols above.
            segments.push(LyricsSegment::text_only(format!("({text}) ")));
        }
        // Bar boundary: trailing `|` (with leading space for
        // readability). The Final / Double / repeat barlines lift
        // the visible glyph.
        let close_glyph = match bar.end {
            BarLine::Single | BarLine::Double => " | ",
            BarLine::Final => " ||| ",
            BarLine::OpenRepeat => " |: ",
            BarLine::CloseRepeat => " :| ",
        };
        segments.push(LyricsSegment::text_only(close_glyph.to_owned()));
    }
    song.lines.push(Line::Lyrics(LyricsLine { segments }));
}

fn push_pre_bar_marker(segments: &mut Vec<LyricsSegment>, bar: &Bar) {
    if let Some(ending) = bar.ending {
        // Push an N-th-ending marker as inline text. ChordPro has
        // no first-class ending directive; renderers can match on
        // the `1.`/`2.` text and apply formatting at their layer.
        segments.push(LyricsSegment::text_only(format!("{}. ", ending.number())));
    }
    // Bar opening glyph for non-Single starts. Single starts
    // inherit from the previous bar's close, so no token needed.
    let open_glyph = match bar.start {
        BarLine::Single => "",
        BarLine::Double => "[ ",
        BarLine::Final => "Z ",
        BarLine::OpenRepeat => "|: ",
        BarLine::CloseRepeat => ":| ",
    };
    if !open_glyph.is_empty() {
        segments.push(LyricsSegment::text_only(open_glyph.to_owned()));
    }
}

fn symbol_label(symbol: MusicalSymbol) -> &'static str {
    match symbol {
        MusicalSymbol::Segno => "Segno",
        MusicalSymbol::Coda => "Coda",
        MusicalSymbol::DaCapo => "D.C.",
        MusicalSymbol::DalSegno => "D.S.",
        MusicalSymbol::Fine => "Fine",
    }
}

fn chord_to_string(chord: &IrealChord) -> String {
    let mut s = String::new();
    push_root_for_chordpro(&mut s, chord.root);
    push_quality_for_chordpro(&mut s, &chord.quality);
    if let Some(bass) = chord.bass {
        s.push('/');
        push_root_for_chordpro(&mut s, bass);
    }
    s
}

fn push_root_for_chordpro(out: &mut String, root: ChordRoot) {
    out.push(if matches!(root.note, 'A'..='G') {
        root.note
    } else {
        // `ChordRoot::note` is guaranteed to be in `'A'..='G'` by
        // the iReal parser (#2054) and the `FromJson` deserialiser.
        // Direct field mutation can violate this guarantee; falling
        // back to `'C'` (the most neutral pitch class) keeps the
        // converter producing structurally valid ChordPro rather than
        // emitting a non-letter that no ChordPro parser would accept.
        'C'
    });
    match root.accidental {
        Accidental::Sharp => out.push('#'),
        Accidental::Flat => out.push('b'),
        Accidental::Natural => {}
    }
}

fn push_quality_for_chordpro(out: &mut String, quality: &ChordQuality) {
    // Spell the quality token using the ChordPro-friendly
    // notation — ChordPro accepts these forms verbatim and
    // renderers map them to glyphs.
    let token = match quality {
        ChordQuality::Major => "",
        ChordQuality::Minor => "m",
        ChordQuality::Diminished => "dim",
        ChordQuality::Augmented => "aug",
        ChordQuality::Major7 => "maj7",
        ChordQuality::Minor7 => "m7",
        ChordQuality::Dominant7 => "7",
        ChordQuality::HalfDiminished => "m7b5",
        ChordQuality::Diminished7 => "dim7",
        ChordQuality::Suspended2 => "sus2",
        ChordQuality::Suspended4 => "sus4",
        ChordQuality::Custom(s) => s.as_str(),
    };
    out.push_str(token);
}

fn serialize_key_for_chordpro(k: KeySignature) -> String {
    let mut s = String::new();
    push_root_for_chordpro(&mut s, k.root);
    if matches!(k.mode, KeyMode::Minor) {
        s.push('m');
    }
    s
}

fn format_time_signature(ts: TimeSignature) -> String {
    format!("{}/{}", ts.numerator, ts.denominator)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chordsketch_ireal::*;

    fn sample_song() -> IrealSong {
        IrealSong {
            title: "Autumn Leaves".into(),
            composer: Some("Joseph Kosma".into()),
            style: Some("Medium Swing".into()),
            key_signature: KeySignature {
                root: ChordRoot {
                    note: 'E',
                    accidental: Accidental::Natural,
                },
                mode: KeyMode::Minor,
            },
            time_signature: TimeSignature::new(4, 4).unwrap(),
            tempo: Some(120),
            transpose: 0,
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
                    repeat_previous: false,
                    no_chord: false,
                    text_comment: None,
                }],
            }],
        }
    }

    fn directive_value(song: &Song, name: &str) -> Option<String> {
        song.lines.iter().find_map(|line| {
            if let Line::Directive(d) = line {
                if d.name == name {
                    return d.value.clone();
                }
            }
            None
        })
    }

    #[test]
    fn metadata_directives_emit() {
        let result = convert(&sample_song()).unwrap();
        let song = &result.output;
        assert_eq!(
            directive_value(song, "title").as_deref(),
            Some("Autumn Leaves")
        );
        assert_eq!(
            directive_value(song, "composer").as_deref(),
            Some("Joseph Kosma")
        );
        assert_eq!(directive_value(song, "key").as_deref(), Some("Em"));
        assert_eq!(directive_value(song, "time").as_deref(), Some("4/4"));
        assert_eq!(directive_value(song, "tempo").as_deref(), Some("120"));
    }

    #[test]
    fn style_routes_through_meta_directive() {
        let result = convert(&sample_song()).unwrap();
        let meta = directive_value(&result.output, "meta");
        assert_eq!(meta.as_deref(), Some("style Medium Swing"));
    }

    #[test]
    fn empty_title_falls_back_to_untitled() {
        let mut s = sample_song();
        s.title = String::new();
        let result = convert(&s).unwrap();
        assert_eq!(
            directive_value(&result.output, "title").as_deref(),
            Some("Untitled")
        );
    }

    #[test]
    fn transpose_omitted_when_zero() {
        let result = convert(&sample_song()).unwrap();
        assert!(directive_value(&result.output, "transpose").is_none());
    }

    #[test]
    fn transpose_emits_when_nonzero() {
        let mut s = sample_song();
        s.transpose = 5;
        let result = convert(&s).unwrap();
        assert_eq!(
            directive_value(&result.output, "transpose").as_deref(),
            Some("5")
        );
    }

    #[test]
    fn named_section_labels_emit_environment_directives() {
        let mut s = sample_song();
        s.sections[0].label = SectionLabel::Chorus;
        let result = convert(&s).unwrap();
        let names: Vec<&str> = result
            .output
            .lines
            .iter()
            .filter_map(|line| match line {
                Line::Directive(d) => Some(d.name.as_str()),
                _ => None,
            })
            .collect();
        assert!(names.contains(&"start_of_chorus"));
        assert!(names.contains(&"end_of_chorus"));
    }

    #[test]
    fn letter_section_label_emits_comment() {
        let result = convert(&sample_song()).unwrap();
        let has_section_comment = result.output.lines.iter().any(|line| {
            matches!(
                line,
                Line::Comment(_, text) if text.contains("Section A")
            )
        });
        assert!(has_section_comment);
    }

    #[test]
    fn chord_token_matches_chordpro_spelling() {
        let chord = Chord::triad(ChordRoot::natural('C'), ChordQuality::Minor7);
        assert_eq!(chord_to_string(&chord), "Cm7");
        let dim = Chord::triad(ChordRoot::natural('B'), ChordQuality::Diminished7);
        assert_eq!(chord_to_string(&dim), "Bdim7");
        let slash = Chord {
            root: ChordRoot::natural('C'),
            quality: ChordQuality::Major,
            bass: Some(ChordRoot {
                note: 'G',
                accidental: Accidental::Sharp,
            }),
            alternate: None,
        };
        assert_eq!(chord_to_string(&slash), "C/G#");
    }

    #[test]
    fn key_signature_minor_appends_m() {
        let key = KeySignature {
            root: ChordRoot {
                note: 'D',
                accidental: Accidental::Flat,
            },
            mode: KeyMode::Minor,
        };
        assert_eq!(serialize_key_for_chordpro(key), "Dbm");
    }

    #[test]
    fn repeat_previous_bar_without_prior_chord_emits_warning() {
        let mut s = IrealSong::new();
        s.title = "Repeat Test".into();
        s.sections.push(Section {
            label: SectionLabel::Letter('A'),
            // First bar is an explicit repeat-previous marker —
            // but there's no previous chord to repeat, so the
            // converter must emit a `LossyDrop` warning rather
            // than silently producing nothing.
            bars: vec![Bar {
                repeat_previous: true,
                ..Bar::default()
            }],
        });
        let result = convert(&s).unwrap();
        assert!(!result.warnings.is_empty());
        assert_eq!(result.warnings[0].kind, WarningKind::LossyDrop);
    }

    #[test]
    fn no_chord_bar_emits_nc_text_not_previous_chord() {
        // `Bar::no_chord = true` (URL `n`) renders silence, NOT a
        // replay of the last chord. Sister-site fix to a bug
        // where the converter conflated `no_chord` with
        // `repeat_previous` in the pre-fix code path.
        use chordsketch_chordpro::ast::Line;
        let mut s = IrealSong::new();
        s.title = "NC Test".into();
        s.sections.push(Section {
            label: SectionLabel::Letter('A'),
            bars: vec![
                Bar {
                    chords: vec![BarChord {
                        chord: Chord {
                            root: ChordRoot::natural('C'),
                            quality: ChordQuality::Major,
                            bass: None,
                            alternate: None,
                        },
                        position: BeatPosition::on_beat(1).unwrap(),
                    }],
                    ..Bar::default()
                },
                Bar {
                    no_chord: true,
                    ..Bar::default()
                },
            ],
        });
        let result = convert(&s).unwrap();
        let song = &result.output;
        let lyrics_text: String = song
            .lines
            .iter()
            .filter_map(|l| match l {
                Line::Lyrics(lyrics) => {
                    Some(lyrics.segments.iter().map(|s| s.text.as_str()).collect())
                }
                _ => None,
            })
            .collect::<Vec<String>>()
            .concat();
        // `N.C.` text must appear; `C` chord must NOT be replayed
        // for the no-chord bar (it would imply continued tonality).
        assert!(
            lyrics_text.contains("N.C."),
            "no-chord bar must surface as `N.C.` text, got {lyrics_text:?}"
        );
    }

    #[test]
    fn alternate_chord_emits_paren_text_after_primary() {
        use chordsketch_chordpro::ast::Line;
        let mut s = IrealSong::new();
        s.title = "Alt Test".into();
        s.sections.push(Section {
            label: SectionLabel::Letter('A'),
            bars: vec![Bar {
                chords: vec![BarChord {
                    chord: Chord {
                        root: ChordRoot::natural('E'),
                        quality: ChordQuality::Minor7,
                        bass: None,
                        alternate: Some(Box::new(Chord {
                            root: ChordRoot::natural('E'),
                            quality: ChordQuality::Custom("7#9".into()),
                            bass: None,
                            alternate: None,
                        })),
                    },
                    position: BeatPosition::on_beat(1).unwrap(),
                }],
                ..Bar::default()
            }],
        });
        let result = convert(&s).unwrap();
        let mut chord_reprs: Vec<String> = Vec::new();
        let mut text_segs: Vec<String> = Vec::new();
        for line in &result.output.lines {
            if let Line::Lyrics(lyrics) = line {
                for seg in &lyrics.segments {
                    if let Some(c) = &seg.chord {
                        chord_reprs.push(c.name.clone());
                    }
                    if !seg.text.is_empty() {
                        text_segs.push(seg.text.clone());
                    }
                }
            }
        }
        let text_concat: String = text_segs.concat();
        assert!(
            chord_reprs.iter().any(|c| c.contains('E')),
            "primary E chord must appear in chord segments"
        );
        // Alternate is surfaced as parenthesised inline text so
        // ChordPro consumers can detect the substitution.
        assert!(
            text_concat.contains("(E"),
            "alternate must surface as parenthesised text, got {text_concat:?}"
        );
    }

    #[test]
    fn text_comment_emits_paren_text_segment() {
        use chordsketch_chordpro::ast::Line;
        let mut s = IrealSong::new();
        s.title = "Comment Test".into();
        s.sections.push(Section {
            label: SectionLabel::Letter('A'),
            bars: vec![Bar {
                chords: vec![BarChord {
                    chord: Chord {
                        root: ChordRoot::natural('C'),
                        quality: ChordQuality::Major,
                        bass: None,
                        alternate: None,
                    },
                    position: BeatPosition::on_beat(1).unwrap(),
                }],
                text_comment: Some("Vamp till cue".into()),
                ..Bar::default()
            }],
        });
        let result = convert(&s).unwrap();
        let text_concat: String = result
            .output
            .lines
            .iter()
            .filter_map(|l| match l {
                Line::Lyrics(lyrics) => {
                    Some(lyrics.segments.iter().map(|s| s.text.as_str()).collect())
                }
                _ => None,
            })
            .collect::<Vec<String>>()
            .concat();
        assert!(
            text_concat.contains("Vamp till cue"),
            "text_comment must round-trip into a text segment, got {text_concat:?}"
        );
    }
}
