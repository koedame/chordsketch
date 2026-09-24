//! The subset of a Guitar Pro 5 file the ChordPro importer keeps.
//!
//! The parser reads every structure in the file (it has to, because GP5 is a
//! sequential format with no offsets to jump by) but only stores what the
//! chord extractor needs: metadata, lyrics, measure headers, track names and
//! capos, and per beat its duration, whether it sounds, its chord diagram,
//! and any tempo change.

/// A parsed GP5 song.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Gp5Song {
    /// Score information (title, artist, ...).
    pub info: Info,
    /// Lyrics and the track they are attached to.
    pub lyrics: Lyrics,
    /// Initial tempo in quarter notes per minute.
    pub tempo: i32,
    /// Song-level key signature as a count of sharps (> 0) or flats (< 0).
    /// Measure headers carry the authoritative key with its mode; this is
    /// the fallback when the first header has none.
    pub key_fifths: i8,
    /// One header per measure, shared by every track.
    pub measure_headers: Vec<MeasureHeader>,
    /// The tracks, in file order.
    pub tracks: Vec<Track>,
}

/// Score information block.
#[derive(Debug, Clone, PartialEq, Default)]
pub(crate) struct Info {
    pub title: String,
    pub subtitle: String,
    pub artist: String,
    pub album: String,
    pub words: String,
    pub music: String,
    pub copyright: String,
}

/// The song's lyrics block.
#[derive(Debug, Clone, PartialEq, Default)]
pub(crate) struct Lyrics {
    /// 1-based index of the track the lyrics belong to; 0 when unassigned.
    pub track: i32,
    /// The five lyric lines. Each is laid over the track's beats starting
    /// at its own measure, so lines are parallel rows, not a sequence.
    pub lines: Vec<LyricLine>,
}

/// One of the five lyric lines.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct LyricLine {
    /// 1-based measure the line starts at.
    pub starting_measure: i32,
    /// Raw Guitar Pro lyric text (see `crate::lyrics` for the syntax).
    pub text: String,
}

/// Per-measure information shared by every track.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct MeasureHeader {
    /// Time signature numerator (beats per bar).
    pub numerator: u8,
    /// Time signature denominator (beat unit).
    pub denominator: u8,
    /// Section marker (rehearsal mark) that starts at this measure.
    pub marker: Option<String>,
    /// Key signature change at this measure: `(fifths, is_minor)`.
    pub key: Option<(i8, bool)>,
}

/// A track and its measures.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Track {
    /// Track name as shown in Guitar Pro.
    pub name: String,
    /// Capo fret; 0 when the track has no capo.
    pub capo: i32,
    /// One entry per measure header.
    pub measures: Vec<Measure>,
}

/// One track's content for one measure.
#[derive(Debug, Clone, PartialEq, Default)]
pub(crate) struct Measure {
    /// GP5 measures always have two voices.
    pub voices: [Vec<Beat>; 2],
}

/// One beat of a voice.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Beat {
    /// Duration in ticks (see [`TICKS_PER_QUARTER`]). Empty beats last 0.
    pub ticks: u64,
    /// True when the beat has at least one note and is not a rest.
    pub sounds: bool,
    /// Chord diagram attached to the beat.
    pub chord: Option<ChordDiagram>,
    /// Tempo change from the beat's mix table, in quarter notes per minute.
    pub tempo: Option<i32>,
}

/// A chord diagram's naming information.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ChordDiagram {
    /// The name typed or generated in Guitar Pro; may be empty.
    pub name: String,
    /// Structured spelling, present for new-format diagrams.
    pub spelling: Option<ChordSpelling>,
}

/// Structured chord spelling from a new-format diagram.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ChordSpelling {
    /// Spell accidentals as sharps (true) or flats (false).
    pub sharp: bool,
    /// Root pitch class, 0 = C .. 11 = B. Other values mean "no root".
    pub root: i32,
    /// Chord type code (0 = major, 1 = dominant seventh, ...).
    pub kind: u8,
    /// Bass pitch class, 0 = C .. 11 = B.
    pub bass: i32,
}

/// Ticks per quarter note.
///
/// Chosen so every duration GP5 can express is a whole number of ticks: the
/// base 960 covers whole notes down to 64ths and their dots, and the extra
/// factors 3² · 5 · 7 · 11 · 13 cover every tuplet GP5 writes (3, 5, 6, 7,
/// 9, 10, 11, 12, 13), including dotted notes inside a tuplet.
pub(crate) const TICKS_PER_QUARTER: u64 = 960 * 45_045 * 2;
