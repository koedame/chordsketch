//! Builds a ChordPro [`Song`] from a parsed GP5 file.
//!
//! The chord track supplies chords, the lyrics track supplies syllables, and
//! any track may carry a tempo change. Every item is placed on a common time
//! line (measure, tick), so the lyrics can live on a different track from
//! the chords — the usual layout of a vocal melody plus a rhythm guitar.
//!
//! ChordPro lines are broken
//!
//! - at every section marker, key change and tempo change;
//! - where the lyric text has a line break — at the start of the measure
//!   when the new line's first syllable is the measure's first syllable, so
//!   a chord struck on the rest before a pickup stays with its words;
//! - every four measures when the line has no lyrics, or when the lyrics
//!   have no line breaks at all (never inside a hyphenated word).

use std::collections::BTreeMap;

use chordsketch_chordpro::ast::{Chord, Directive, Line, LyricsLine, LyricsSegment, Song};
use chordsketch_convert::{ConversionWarning, WarningKind};

use crate::chord_name::{self, Resolved};
use crate::error::GpError;
use crate::gp5::structs::{Gp5Song, TICKS_PER_QUARTER};
use crate::lyrics::{self, Syllable};

/// Measures per line when the importer chooses the line breaks.
const MEASURES_PER_LINE: usize = 4;

/// Highest capo fret the importer writes to `{capo}`.
const MAX_CAPO: i32 = 24;

/// What happens at one point in time.
#[derive(Default)]
struct Event {
    chord: Option<String>,
    syllable: Option<Syllable>,
    tempo: Option<i32>,
}

/// Converts a parsed song. `track` is the 1-based chord track to use, or
/// `None` for the first track that has chord diagrams.
pub(crate) fn to_song(
    gp: &Gp5Song,
    track: Option<usize>,
) -> Result<(Song, Vec<ConversionWarning>), GpError> {
    let mut warnings = Vec::new();
    let chord_track = select_track(gp, track, &mut warnings)?;

    let starts = measure_starts(gp);
    let mut events: BTreeMap<(usize, u64), Event> = BTreeMap::new();
    let capo = chord_track.map_or(0, |t| capo_of(gp, t, &mut warnings));
    let key = gp
        .measure_headers
        .first()
        .and_then(|h| h.key)
        .unwrap_or((gp.key_fifths, false));
    let prefer_flat = key.0 < 0;

    if let Some(t) = chord_track {
        collect_chords(
            gp,
            t,
            &starts,
            capo,
            prefer_flat,
            &mut events,
            &mut warnings,
        );
    }
    collect_tempos(gp, &starts, &mut events);
    let line_mode = collect_lyrics(gp, &starts, &mut events, &mut warnings);

    // A tempo change on the very first beat is the song's real tempo.
    let mut tempo = gp.tempo;
    if let Some(first) = events.get_mut(&(0, 0))
        && let Some(t) = first.tempo.take()
    {
        tempo = t;
    }

    let mut song = Song::new();
    write_metadata(gp, &mut song, key, tempo, capo, &mut warnings);

    let mut body = Body::new(line_mode);
    let mut current_key = key;
    let mut current_tempo = tempo;
    for (m, header) in gp.measure_headers.iter().enumerate() {
        if let Some(label) = &header.marker {
            body.start_section(label.trim());
        }
        if m > 0
            && let Some(k) = header.key
            && k != current_key
        {
            current_key = k;
            if let Some(name) = key_name(k) {
                body.directive("key", &name);
            }
        }
        let measure_events: Vec<&Event> =
            events.range((m, 0)..(m + 1, 0)).map(|(_, e)| e).collect();
        let first_syllable = measure_events.iter().find_map(|e| e.syllable.as_ref());
        let measure_starts_line = first_syllable.is_some_and(|s| s.starts_line);
        body.enter_measure(m, measure_starts_line);
        let mut seen_syllable = false;
        for event in measure_events {
            if let Some(t) = event.tempo
                && t != current_tempo
            {
                current_tempo = t;
                body.directive("tempo", &t.to_string());
            }
            if let Some(s) = &event.syllable {
                if s.starts_line && seen_syllable {
                    body.break_line();
                }
                seen_syllable = true;
            }
            body.push(event.chord.as_deref(), event.syllable.as_ref());
        }
    }
    song.lines.extend(body.finish());
    Ok((song, warnings))
}

/// Picks the chord track: the requested one, or the first with chords, or
/// the first track. Returns its 0-based index, or `None` when the file has
/// no tracks.
fn select_track(
    gp: &Gp5Song,
    requested: Option<usize>,
    warnings: &mut Vec<ConversionWarning>,
) -> Result<Option<usize>, GpError> {
    let has_chords = |t: usize| {
        gp.tracks[t]
            .measures
            .iter()
            .flat_map(|m| m.voices.iter().flatten())
            .any(|b| b.chord.is_some())
    };
    let chosen = match requested {
        Some(n) => {
            if n == 0 || n > gp.tracks.len() {
                return Err(GpError::TrackOutOfRange {
                    requested: n,
                    tracks: gp.tracks.iter().map(|t| t.name.clone()).collect(),
                });
            }
            n - 1
        }
        None => match (0..gp.tracks.len()).find(|&t| has_chords(t)) {
            Some(t) => return Ok(Some(t)),
            None if gp.tracks.is_empty() => return Ok(None),
            None => 0,
        },
    };
    if !has_chords(chosen) {
        warnings.push(ConversionWarning::new(
            WarningKind::LossyDrop,
            format!(
                "track {} ({}) has no chord diagrams; the output has no chords",
                chosen + 1,
                gp.tracks[chosen].name
            ),
        ));
    }
    Ok(Some(chosen))
}

/// Absolute tick at which each measure starts, from the time signatures.
fn measure_starts(gp: &Gp5Song) -> Vec<u64> {
    let whole = TICKS_PER_QUARTER * 4;
    let mut starts = Vec::with_capacity(gp.measure_headers.len());
    let mut tick = 0;
    for header in &gp.measure_headers {
        starts.push(tick);
        tick += u64::from(header.numerator) * (whole / u64::from(header.denominator));
    }
    starts
}

fn capo_of(gp: &Gp5Song, track: usize, warnings: &mut Vec<ConversionWarning>) -> i8 {
    let capo = gp.tracks[track].capo;
    match i8::try_from(capo) {
        Ok(c) if (0..=MAX_CAPO).contains(&capo) => c,
        _ => {
            warnings.push(ConversionWarning::new(
                WarningKind::LossyDrop,
                format!("capo {capo} is outside 0..={MAX_CAPO}; ignored"),
            ));
            0
        }
    }
}

/// Places every sounding position of a voice: (measure, absolute tick, beat).
fn beat_positions<'a>(
    gp: &'a Gp5Song,
    track: usize,
    voice: usize,
    starts: &'a [u64],
) -> impl Iterator<Item = (usize, u64, &'a crate::gp5::structs::Beat)> + 'a {
    gp.tracks[track]
        .measures
        .iter()
        .enumerate()
        .flat_map(move |(m, measure)| {
            let mut tick = starts[m];
            measure.voices[voice].iter().map(move |beat| {
                let at = tick;
                tick += beat.ticks;
                (m, at, beat)
            })
        })
}

fn collect_chords(
    gp: &Gp5Song,
    track: usize,
    starts: &[u64],
    capo: i8,
    prefer_flat: bool,
    events: &mut BTreeMap<(usize, u64), Event>,
    warnings: &mut Vec<ConversionWarning>,
) {
    for voice in 0..2 {
        for (m, tick, beat) in beat_positions(gp, track, voice, starts) {
            let Some(diagram) = &beat.chord else { continue };
            let name = match chord_name::resolve(diagram) {
                Resolved::Named(name) => name,
                Resolved::Spelled { name, stored } => {
                    warnings.push(ConversionWarning::new(
                        WarningKind::Approximated,
                        format!(
                            "measure {}: {} spelled as \"{name}\" from its root and chord type",
                            m + 1,
                            describe_diagram(&stored)
                        ),
                    ));
                    name
                }
                Resolved::Unknown { stored } => {
                    warnings.push(ConversionWarning::new(
                        WarningKind::LossyDrop,
                        format!(
                            "measure {}: {} is not a chord name; omitted",
                            m + 1,
                            describe_diagram(&stored)
                        ),
                    ));
                    continue;
                }
            };
            let event = events.entry((m, tick)).or_default();
            // Voice 1 wins when both voices carry a chord at the same time.
            if event.chord.is_none() {
                event.chord = Some(chord_name::to_sounding(&name, capo, prefer_flat));
            }
        }
    }
}

fn describe_diagram(stored: &str) -> String {
    if stored.is_empty() {
        "unnamed chord diagram".to_string()
    } else {
        format!("chord diagram \"{stored}\"")
    }
}

/// Tempo is global in Guitar Pro, so a change on any track applies.
fn collect_tempos(gp: &Gp5Song, starts: &[u64], events: &mut BTreeMap<(usize, u64), Event>) {
    for track in 0..gp.tracks.len() {
        for voice in 0..2 {
            for (m, tick, beat) in beat_positions(gp, track, voice, starts) {
                if let Some(t) = beat.tempo {
                    events.entry((m, tick)).or_default().tempo.get_or_insert(t);
                }
            }
        }
    }
}

/// How the body breaks lines that carry lyrics.
#[derive(Clone, Copy, PartialEq, Eq)]
enum LineMode {
    /// Follow the line breaks in the lyric text.
    LyricBreaks,
    /// The lyrics have no line breaks; break every few measures.
    Measures,
}

/// Lays the lyric lines over the lyrics track and records each syllable.
fn collect_lyrics(
    gp: &Gp5Song,
    starts: &[u64],
    events: &mut BTreeMap<(usize, u64), Event>,
    warnings: &mut Vec<ConversionWarning>,
) -> LineMode {
    let used: Vec<(usize, &crate::gp5::structs::LyricLine)> = gp
        .lyrics
        .lines
        .iter()
        .enumerate()
        .filter(|(_, l)| !l.text.trim().is_empty())
        .collect();
    if used.is_empty() {
        return LineMode::Measures;
    }
    let track = match usize::try_from(gp.lyrics.track) {
        Ok(t) if (1..=gp.tracks.len()).contains(&t) => t - 1,
        _ => {
            warnings.push(ConversionWarning::new(
                WarningKind::LossyDrop,
                format!(
                    "the lyrics belong to track {}, which does not exist; lyrics dropped",
                    gp.lyrics.track
                ),
            ));
            return LineMode::Measures;
        }
    };
    let mode = if used.iter().any(|(_, l)| l.text.contains(['\n', '\r'])) {
        LineMode::LyricBreaks
    } else {
        LineMode::Measures
    };

    // Which lyric line placed a syllable at each position.
    let mut owner: BTreeMap<(usize, u64), usize> = BTreeMap::new();
    for (index, line) in used {
        let number = index + 1;
        let first = match usize::try_from(line.starting_measure) {
            Ok(s) if (1..=gp.measure_headers.len()).contains(&s) => s - 1,
            _ => {
                warnings.push(ConversionWarning::new(
                    WarningKind::LossyDrop,
                    format!(
                        "lyric line {number} starts at measure {}, which does not exist; dropped",
                        line.starting_measure
                    ),
                ));
                continue;
            }
        };
        let mut syllables = lyrics::syllables(&line.text).into_iter();
        let mut overlaps = 0;
        let beats =
            beat_positions(gp, track, 0, starts).filter(|(m, _, b)| *m >= first && b.sounds);
        for (m, tick, _) in beats {
            let Some(syllable) = syllables.next() else {
                break;
            };
            if syllable.text.is_empty() {
                continue;
            }
            match owner.get(&(m, tick)) {
                Some(_) => overlaps += 1,
                None => {
                    owner.insert((m, tick), number);
                    events.entry((m, tick)).or_default().syllable = Some(syllable);
                }
            }
        }
        let left = syllables.filter(|s| !s.text.is_empty()).count();
        if left > 0 {
            warnings.push(ConversionWarning::new(
                WarningKind::LossyDrop,
                format!("lyric line {number}: {left} syllable(s) had no note to sit on; dropped"),
            ));
        }
        if overlaps > 0 {
            warnings.push(ConversionWarning::new(
                WarningKind::LossyDrop,
                format!(
                    "lyric line {number} overlaps an earlier lyric line on {overlaps} note(s); \
                     its syllables there were dropped"
                ),
            ));
        }
    }
    mode
}

fn write_metadata(
    gp: &Gp5Song,
    song: &mut Song,
    key: (i8, bool),
    tempo: i32,
    capo: i8,
    warnings: &mut Vec<ConversionWarning>,
) {
    let info = &gp.info;
    let lines = &mut song.lines;
    let meta = &mut song.metadata;
    let directive = |lines: &mut Vec<Line>, name: &str, value: &str| {
        lines.push(Line::Directive(Directive::with_value(name, value)));
    };
    // `song_to_chordpro` prints the title and first artist from the
    // metadata itself; everything else is a directive line.
    if let Some(title) = non_empty(&info.title) {
        meta.title = Some(title.to_string());
    }
    if let Some(artist) = non_empty(&info.artist) {
        meta.artists.push(artist.to_string());
    }
    if let Some(subtitle) = non_empty(&info.subtitle) {
        meta.subtitles.push(subtitle.to_string());
        directive(lines, "subtitle", subtitle);
    }
    if let Some(album) = non_empty(&info.album) {
        meta.album = Some(album.to_string());
        directive(lines, "album", album);
    }
    if let Some(music) = non_empty(&info.music) {
        meta.composers.push(music.to_string());
        directive(lines, "composer", music);
    }
    if let Some(words) = non_empty(&info.words) {
        meta.lyricists.push(words.to_string());
        directive(lines, "lyricist", words);
    }
    if let Some(copyright) = non_empty(&info.copyright) {
        meta.copyright = Some(copyright.to_string());
        directive(lines, "copyright", copyright);
    }
    match key_name(key) {
        Some(name) => {
            meta.key = Some(name.clone());
            directive(lines, "key", &name);
        }
        None => warnings.push(ConversionWarning::new(
            WarningKind::LossyDrop,
            format!(
                "key signature with {} sharps/flats is not a key; ignored",
                key.0
            ),
        )),
    }
    if let Some(first) = gp.measure_headers.first() {
        let time = format!("{}/{}", first.numerator, first.denominator);
        meta.time = Some(time.clone());
        directive(lines, "time", &time);
    }
    if tempo > 0 {
        meta.tempo = Some(tempo.to_string());
        directive(lines, "tempo", &tempo.to_string());
    }
    if capo > 0 {
        meta.capo = Some(capo.to_string());
        directive(lines, "capo", &capo.to_string());
    }
    if !lines.is_empty() || meta.title.is_some() || !meta.artists.is_empty() {
        lines.push(Line::Empty);
    }
}

fn non_empty(s: &str) -> Option<&str> {
    Some(s.trim()).filter(|s| !s.is_empty())
}

/// Names a key signature: `(sharps or flats, is_minor)` → `G`, `Em`, ...
fn key_name((fifths, minor): (i8, bool)) -> Option<String> {
    const MAJOR: [&str; 15] = [
        "Cb", "Gb", "Db", "Ab", "Eb", "Bb", "F", "C", "G", "D", "A", "E", "B", "F#", "C#",
    ];
    const MINOR: [&str; 15] = [
        "Ab", "Eb", "Bb", "F", "C", "G", "D", "A", "E", "B", "F#", "C#", "G#", "D#", "A#",
    ];
    let index = usize::try_from(i16::from(fifths) + 7)
        .ok()
        .filter(|&i| i < 15)?;
    Some(if minor {
        format!("{}m", MINOR[index])
    } else {
        MAJOR[index].to_string()
    })
}

/// Section directives for a marker label.
fn section_directives(label: &str) -> (&'static str, &'static str) {
    let lower = label.to_lowercase();
    if lower.contains("bridge") {
        ("start_of_bridge", "end_of_bridge")
    } else if (lower.contains("chorus") || lower.contains("refrain")) && !lower.contains("pre") {
        ("start_of_chorus", "end_of_chorus")
    } else {
        ("start_of_verse", "end_of_verse")
    }
}

/// Accumulates the song body line by line.
struct Body {
    mode: LineMode,
    lines: Vec<Line>,
    segments: Vec<LyricsSegment>,
    /// Measure the current line started in.
    line_start: usize,
    /// The current line has at least one syllable.
    has_lyrics: bool,
    /// The last syllable continues into the next one.
    mid_word: bool,
    /// End directive of the open section.
    open_section: Option<&'static str>,
}

impl Body {
    fn new(mode: LineMode) -> Self {
        Self {
            mode,
            lines: Vec::new(),
            segments: Vec::new(),
            line_start: 0,
            has_lyrics: false,
            mid_word: false,
            open_section: None,
        }
    }

    fn start_section(&mut self, label: &str) {
        self.close_section();
        let (start, end) = section_directives(label);
        let directive = if label.is_empty() {
            Directive::name_only(start)
        } else {
            Directive::with_value(start, label)
        };
        self.lines.push(Line::Directive(directive));
        self.open_section = Some(end);
    }

    fn close_section(&mut self) {
        self.break_line();
        if let Some(end) = self.open_section.take() {
            self.lines.push(Line::Directive(Directive::name_only(end)));
            self.lines.push(Line::Empty);
        }
    }

    fn directive(&mut self, name: &str, value: &str) {
        self.break_line();
        self.lines
            .push(Line::Directive(Directive::with_value(name, value)));
    }

    /// Called at each measure boundary, before the measure's events.
    fn enter_measure(&mut self, measure: usize, starts_lyric_line: bool) {
        if self.segments.is_empty() {
            self.line_start = measure;
            return;
        }
        let by_count = measure - self.line_start >= MEASURES_PER_LINE
            && (!self.has_lyrics || self.mode == LineMode::Measures)
            && !self.mid_word;
        let by_lyrics = starts_lyric_line && self.mode == LineMode::LyricBreaks;
        if by_count || by_lyrics {
            self.break_line();
            self.line_start = measure;
        }
    }

    /// Adds what happens at one point in time.
    fn push(&mut self, chord: Option<&str>, syllable: Option<&Syllable>) {
        let text = match syllable {
            Some(s) if !s.text.is_empty() => {
                self.has_lyrics = true;
                self.mid_word = s.continues_word();
                match s.text.strip_suffix('-') {
                    Some(stem) => stem.to_string(),
                    None => format!("{} ", s.text),
                }
            }
            _ => String::new(),
        };
        match chord {
            Some(name) => self
                .segments
                .push(LyricsSegment::new(Some(Chord::new(name)), text)),
            None if text.is_empty() => {}
            // Text without a new chord continues the previous segment.
            None => match self.segments.last_mut() {
                Some(last) => last.text.push_str(&text),
                None => self.segments.push(LyricsSegment::text_only(text)),
            },
        }
    }

    fn break_line(&mut self) {
        if self.segments.is_empty() {
            return;
        }
        let mut segments = std::mem::take(&mut self.segments);
        if segments.iter().all(|s| s.text.is_empty()) {
            // A chord-only line: space the chords out.
            let last = segments.len() - 1;
            for segment in &mut segments[..last] {
                segment.text.push(' ');
            }
        } else if let Some(last) = segments.last_mut() {
            let trimmed = last.text.trim_end().len();
            last.text.truncate(trimmed);
        }
        let mut line = LyricsLine::new();
        line.segments = segments;
        self.lines.push(Line::Lyrics(line));
        self.has_lyrics = false;
        self.mid_word = false;
    }

    fn finish(mut self) -> Vec<Line> {
        self.close_section();
        self.break_line();
        while matches!(self.lines.last(), Some(Line::Empty)) {
            self.lines.pop();
        }
        self.lines
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn when_a_key_signature_is_named_major_and_minor_differ() {
        assert_eq!(key_name((1, false)).as_deref(), Some("G"));
        assert_eq!(key_name((1, true)).as_deref(), Some("Em"));
        assert_eq!(key_name((-3, false)).as_deref(), Some("Eb"));
        assert_eq!(key_name((-7, true)).as_deref(), Some("Abm"));
        assert_eq!(key_name((7, false)).as_deref(), Some("C#"));
        assert_eq!(key_name((8, false)), None);
        assert_eq!(key_name((-8, true)), None);
    }

    #[test]
    fn when_a_marker_is_named_the_section_kind_follows_the_name() {
        assert_eq!(section_directives("Chorus 2").0, "start_of_chorus");
        assert_eq!(section_directives("Refrain").0, "start_of_chorus");
        assert_eq!(section_directives("Pre-Chorus").0, "start_of_verse");
        assert_eq!(section_directives("Bridge").0, "start_of_bridge");
        assert_eq!(section_directives("Intro").0, "start_of_verse");
    }
}
