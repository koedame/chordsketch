//! Guitar Pro 5 (`.gp5`) binary parser.
//!
//! GP5 is a sequential little-endian format with no offsets or length
//! prefixes around its sections, so the parser has to step through every
//! structure in order — including the note effects, mix tables and RSE
//! settings the importer discards — to reach the next beat. The layout
//! follows the community documentation of the format (the alphaTab and
//! PyGuitarPro projects); the step order below mirrors it section by
//! section.
//!
//! Two revisions exist: 5.00 and 5.10. 5.10 adds the RSE master effect and
//! equaliser blocks, a "hide tempo" flag, and RSE effect names on tracks and
//! mix tables; 5.00 pads some structures differently. `Version` carries the
//! difference.

mod reader;
pub(crate) mod structs;

use crate::error::GpError;
use reader::Reader;
use structs::{
    Beat, ChordDiagram, ChordSpelling, Gp5Song, Info, LyricLine, Lyrics, Measure, MeasureHeader,
    TICKS_PER_QUARTER, Track,
};

/// The two GP5 revisions.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Version {
    V500,
    V510,
}

/// Version string of a Guitar Pro 5.00 file.
const VERSION_500: &str = "FICHIER GUITAR PRO v5.00";
/// Version string of a Guitar Pro 5.10 file.
const VERSION_510: &str = "FICHIER GUITAR PRO v5.10";

/// Parses a complete GP5 file.
pub(crate) fn parse(bytes: &[u8]) -> Result<Gp5Song, GpError> {
    let mut r = Reader::new(bytes);
    let version = read_version(&mut r)?;
    let info = read_info(&mut r)?;
    let lyrics = read_lyrics(&mut r)?;
    if version == Version::V510 {
        // RSE master effect: volume (i32), unknown (i32), 11-band equaliser.
        r.skip(4 + 4 + 11)?;
    }
    read_page_setup(&mut r)?;
    r.read_int_byte_size_string()?; // tempo name
    let tempo = r.read_i32()?;
    if version == Version::V510 {
        r.read_bool()?; // hide tempo
    }
    let key_fifths = r.read_i8()?;
    r.read_i32()?; // octave
    r.skip(64 * 12)?; // MIDI channels: 64 × (instrument i32, 6 × i8, 2 padding)
    r.skip(19 * 2)?; // direction signs (coda, segno, ...): 19 × i16
    r.read_i32()?; // master reverb
    let measure_count = r.read_count("measure count", 1)?;
    let track_count = r.read_count("track count", 1)?;

    let mut measure_headers = Vec::new();
    for index in 0..measure_count {
        let previous = measure_headers.last();
        let header = read_measure_header(&mut r, index, previous)?;
        measure_headers.push(header);
    }

    let mut tracks = Vec::new();
    let mut string_counts = Vec::new();
    for index in 0..track_count {
        let (track, strings) = read_track(&mut r, index, version)?;
        tracks.push(track);
        string_counts.push(strings);
    }
    r.skip(if version == Version::V500 { 2 } else { 1 })?;

    for _ in 0..measure_count {
        for (track, &strings) in tracks.iter_mut().zip(&string_counts) {
            let measure = read_measure(&mut r, strings, version)?;
            track.measures.push(measure);
        }
    }

    Ok(Gp5Song {
        info,
        lyrics,
        tempo,
        key_fifths,
        measure_headers,
        tracks,
    })
}

fn read_version(r: &mut Reader<'_>) -> Result<Version, GpError> {
    let version = r
        .read_byte_size_string(30)
        .map_err(|_| GpError::UnsupportedVersion {
            version: String::new(),
        })?;
    match version.as_str() {
        VERSION_500 => Ok(Version::V500),
        VERSION_510 => Ok(Version::V510),
        _ => Err(GpError::UnsupportedVersion { version }),
    }
}

fn read_info(r: &mut Reader<'_>) -> Result<Info, GpError> {
    let info = Info {
        title: r.read_int_byte_size_string()?,
        subtitle: r.read_int_byte_size_string()?,
        artist: r.read_int_byte_size_string()?,
        album: r.read_int_byte_size_string()?,
        words: r.read_int_byte_size_string()?,
        music: r.read_int_byte_size_string()?,
        copyright: r.read_int_byte_size_string()?,
    };
    r.read_int_byte_size_string()?; // tab (transcriber)
    r.read_int_byte_size_string()?; // instructions
    let notice_lines = r.read_count("notice line count", 4)?;
    for _ in 0..notice_lines {
        r.read_int_byte_size_string()?;
    }
    Ok(info)
}

fn read_lyrics(r: &mut Reader<'_>) -> Result<Lyrics, GpError> {
    let track = r.read_i32()?;
    let mut lines = Vec::with_capacity(5);
    for _ in 0..5 {
        let starting_measure = r.read_i32()?;
        let text = r.read_int_size_string()?;
        lines.push(LyricLine {
            starting_measure,
            text,
        });
    }
    Ok(Lyrics { track, lines })
}

fn read_page_setup(r: &mut Reader<'_>) -> Result<(), GpError> {
    // Page size (2 × i32), margins (4 × i32), score size proportion (i32),
    // header/footer flags (i16).
    r.skip(8 + 16 + 4 + 2)?;
    // Header/footer templates: title, subtitle, artist, album, words, music,
    // words & music, copyright (two lines), page number.
    for _ in 0..10 {
        r.read_int_byte_size_string()?;
    }
    Ok(())
}

fn read_measure_header(
    r: &mut Reader<'_>,
    index: usize,
    previous: Option<&MeasureHeader>,
) -> Result<MeasureHeader, GpError> {
    if index > 0 {
        r.skip(1)?; // padding between headers
    }
    let flags = r.read_u8()?;
    let numerator = if flags & 0x01 != 0 {
        read_time_signature_part(r, "numerator")?
    } else {
        previous.map_or(4, |p| p.numerator)
    };
    let denominator = if flags & 0x02 != 0 {
        read_time_signature_part(r, "denominator")?
    } else {
        previous.map_or(4, |p| p.denominator)
    };
    if flags & 0x08 != 0 {
        r.read_i8()?; // repeat close count
    }
    let marker = if flags & 0x20 != 0 {
        let title = r.read_int_byte_size_string()?;
        r.skip(4)?; // marker colour (RGB + padding)
        Some(title)
    } else {
        None
    };
    let key = if flags & 0x40 != 0 {
        let fifths = r.read_i8()?;
        let mode = r.read_i8()?;
        Some((fifths, mode == 1))
    } else {
        None
    };
    if flags & 0x10 != 0 {
        r.read_u8()?; // repeat alternative bitmask
    }
    if flags & 0x03 != 0 {
        r.skip(4)?; // beam grouping for the new time signature
    }
    if flags & 0x10 == 0 {
        r.skip(1)?; // padding in place of the repeat alternative
    }
    r.read_u8()?; // triplet feel
    Ok(MeasureHeader {
        numerator,
        denominator,
        marker,
        key,
    })
}

fn read_time_signature_part(r: &mut Reader<'_>, what: &str) -> Result<u8, GpError> {
    let offset = r.position();
    let value = r.read_i8()?;
    u8::try_from(value)
        .ok()
        .filter(|&v| v > 0)
        .ok_or_else(|| GpError::InvalidData {
            offset,
            message: format!("time signature {what} {value}"),
        })
}

/// Reads one track and returns it with its string count.
fn read_track(
    r: &mut Reader<'_>,
    index: usize,
    version: Version,
) -> Result<(Track, usize), GpError> {
    if index == 0 || version == Version::V500 {
        r.skip(1)?;
    }
    r.read_u8()?; // flags (percussion, 12-string, banjo, visible, solo, mute, RSE, tuning)
    let name = r.read_byte_size_string(40)?;
    let offset = r.position();
    let strings = r.read_i32()?;
    let strings = usize::try_from(strings)
        .ok()
        .filter(|&s| s <= 7)
        .ok_or_else(|| GpError::InvalidData {
            offset,
            message: format!("track string count {strings} (GP5 tracks have at most 7)"),
        })?;
    r.skip(7 * 4)?; // tuning of up to 7 strings
    r.skip(4 + 4 + 4)?; // MIDI port, channel, effect channel
    r.read_i32()?; // fret count
    let capo = r.read_i32()?;
    r.skip(4)?; // colour
    r.read_i16()?; // display flags
    r.skip(3)?; // RSE auto-accentuation, MIDI bank, humanise
    r.skip(3 * 4)?; // clef transposition (2 × i32) and an unknown i32
    r.skip(12)?; // unknown
    skip_rse_instrument(r, version)?;
    if version == Version::V510 {
        r.skip(4)?; // track equaliser (3 bands + gain)
        r.read_int_byte_size_string()?; // RSE effect name
        r.read_int_byte_size_string()?; // RSE effect category
    }
    let track = Track {
        name,
        capo,
        measures: Vec::new(),
    };
    Ok((track, strings))
}

fn skip_rse_instrument(r: &mut Reader<'_>, version: Version) -> Result<(), GpError> {
    r.skip(4 + 4 + 4)?; // instrument, unknown, sound bank
    match version {
        Version::V500 => r.skip(2 + 1), // effect number (i16) + padding
        Version::V510 => r.skip(4),     // effect number (i32)
    }
}

fn read_measure(r: &mut Reader<'_>, strings: usize, version: Version) -> Result<Measure, GpError> {
    let mut measure = Measure::default();
    for voice in &mut measure.voices {
        // Every beat is at least 5 bytes: flags, duration, string flags, and
        // the i16 display flags.
        let beats = r.read_count("beat count", 5)?;
        for _ in 0..beats {
            voice.push(read_beat(r, strings, version)?);
        }
    }
    // Line-break marker. Some writers omit it after the final measure, so
    // the end of the input stands for "no line break".
    if r.remaining() > 0 {
        r.read_u8()?;
    }
    Ok(measure)
}

fn read_beat(r: &mut Reader<'_>, strings: usize, version: Version) -> Result<Beat, GpError> {
    let flags = r.read_u8()?;
    // 0x00 = empty beat (takes no time), 0x02 = rest; absent = normal.
    let status = if flags & 0x40 != 0 {
        Some(r.read_u8()?)
    } else {
        None
    };
    let mut ticks = read_duration(r, flags)?;
    let chord = if flags & 0x02 != 0 {
        Some(read_chord(r)?)
    } else {
        None
    };
    if flags & 0x04 != 0 {
        r.read_int_byte_size_string()?; // free text above the beat
    }
    if flags & 0x08 != 0 {
        skip_beat_effects(r)?;
    }
    let tempo = if flags & 0x10 != 0 {
        read_mix_table_change(r, version)?
    } else {
        None
    };
    let notes = read_notes(r, strings)?;
    let display_flags = r.read_i16()?;
    if display_flags & 0x800 != 0 {
        r.read_u8()?; // secondary beam break
    }
    if status == Some(0x00) {
        ticks = 0;
    }
    Ok(Beat {
        ticks,
        sounds: status.is_none_or(|s| s != 0x00 && s != 0x02) && notes > 0,
        chord,
        tempo,
    })
}

/// Reads a beat duration and returns it in ticks.
fn read_duration(r: &mut Reader<'_>, flags: u8) -> Result<u64, GpError> {
    let offset = r.position();
    let value = r.read_i8()?;
    // -2 = whole, -1 = half, 0 = quarter, ... 4 = 64th.
    let whole = TICKS_PER_QUARTER * 4;
    let mut ticks = match value {
        -2..=4 => whole >> (value + 2),
        _ => {
            return Err(GpError::InvalidData {
                offset,
                message: format!("beat duration {value}"),
            });
        }
    };
    if flags & 0x01 != 0 {
        ticks = ticks * 3 / 2;
    }
    if flags & 0x20 != 0 {
        let enters = r.read_i32()?;
        let times = match enters {
            3 => 2,
            5..=7 => 4,
            9..=13 => 8,
            // Other tuplet values are not written by Guitar Pro; like the
            // reference readers, play the beat at its plain duration.
            _ => enters,
        };
        if enters > 0 {
            ticks = ticks * times.unsigned_abs() as u64 / enters.unsigned_abs() as u64;
        }
    }
    Ok(ticks)
}

fn read_chord(r: &mut Reader<'_>) -> Result<ChordDiagram, GpError> {
    let new_format = r.read_bool()?;
    if !new_format {
        let name = r.read_int_byte_size_string()?;
        let first_fret = r.read_i32()?;
        if first_fret != 0 {
            r.skip(6 * 4)?; // frets of 6 strings
        }
        return Ok(ChordDiagram {
            name,
            spelling: None,
        });
    }
    let sharp = r.read_bool()?;
    r.skip(3)?;
    let root = i32::from(r.read_u8()?);
    let kind = r.read_u8()?;
    r.read_u8()?; // extension (9 / 11 / 13)
    let bass = r.read_i32()?;
    r.read_i32()?; // tonality (diminished / augmented fifth)
    r.read_bool()?; // "add" flag
    let name = r.read_byte_size_string(22)?;
    r.skip(3)?; // fifth, ninth, eleventh alterations
    r.read_i32()?; // first fret
    r.skip(7 * 4)?; // frets of up to 7 strings
    r.skip(1 + 5 + 5 + 5)?; // barre count, frets, starts, ends
    r.skip(7)?; // omitted intervals
    r.skip(1)?; // padding
    r.skip(7)?; // fingering per string
    r.read_bool()?; // show fingering
    Ok(ChordDiagram {
        name,
        spelling: Some(ChordSpelling {
            sharp,
            root,
            kind,
            bass,
        }),
    })
}

fn skip_beat_effects(r: &mut Reader<'_>) -> Result<(), GpError> {
    let flags1 = r.read_u8()?;
    let flags2 = r.read_u8()?;
    if flags1 & 0x20 != 0 {
        r.skip(1)?; // tap / slap / pop
    }
    if flags2 & 0x04 != 0 {
        skip_bend(r)?; // tremolo bar
    }
    if flags1 & 0x40 != 0 {
        r.skip(2)?; // stroke up / down speed
    }
    if flags2 & 0x02 != 0 {
        r.skip(1)?; // pick stroke direction
    }
    Ok(())
}

fn skip_bend(r: &mut Reader<'_>) -> Result<(), GpError> {
    r.skip(1 + 4)?; // bend type, value
    // Each point: position (i32), value (i32), vibrato (bool).
    let points = r.read_count("bend point count", 9)?;
    r.skip(points * 9)
}

/// Reads a mix table change and returns its tempo change, if any.
fn read_mix_table_change(r: &mut Reader<'_>, version: Version) -> Result<Option<i32>, GpError> {
    r.read_i8()?; // instrument
    skip_rse_instrument(r, version)?;
    if version == Version::V500 {
        r.skip(1)?;
    }
    // volume, balance, chorus, reverb, phaser, tremolo; -1 = unchanged.
    let mut changed = 0;
    for _ in 0..6 {
        if r.read_i8()? >= 0 {
            changed += 1;
        }
    }
    r.read_int_byte_size_string()?; // tempo name
    let tempo = r.read_i32()?;
    r.skip(changed)?; // transition duration of each changed value
    if tempo >= 0 {
        r.skip(1)?; // tempo transition duration
        if version == Version::V510 {
            r.read_bool()?; // hide tempo
        }
    }
    r.read_u8()?; // "apply to all tracks" flags
    r.read_i8()?; // wah
    if version == Version::V510 {
        r.read_int_byte_size_string()?; // RSE effect name
        r.read_int_byte_size_string()?; // RSE effect category
    }
    Ok((tempo > 0).then_some(tempo))
}

/// Reads the notes of a beat and returns how many there were.
fn read_notes(r: &mut Reader<'_>, strings: usize) -> Result<usize, GpError> {
    let string_flags = r.read_u8()?;
    let mut count = 0;
    // Bit 6 is string 1 (highest), bit 0 is string 7.
    for string in 1..=strings {
        if string_flags & (1 << (7 - string)) != 0 {
            skip_note(r)?;
            count += 1;
        }
    }
    Ok(count)
}

fn skip_note(r: &mut Reader<'_>) -> Result<(), GpError> {
    let flags = r.read_u8()?;
    if flags & 0x20 != 0 {
        r.read_u8()?; // note type (normal / tie / dead)
    }
    if flags & 0x10 != 0 {
        r.read_i8()?; // dynamic
    }
    if flags & 0x20 != 0 {
        r.read_i8()?; // fret
    }
    if flags & 0x80 != 0 {
        r.skip(2)?; // left- and right-hand fingering
    }
    if flags & 0x01 != 0 {
        r.skip(8)?; // duration percent (f64)
    }
    r.read_u8()?; // second flag byte (accidental spelling)
    if flags & 0x08 != 0 {
        skip_note_effects(r)?;
    }
    Ok(())
}

fn skip_note_effects(r: &mut Reader<'_>) -> Result<(), GpError> {
    let flags1 = r.read_u8()?;
    let flags2 = r.read_u8()?;
    if flags1 & 0x01 != 0 {
        skip_bend(r)?;
    }
    if flags1 & 0x10 != 0 {
        r.skip(5)?; // grace note: fret, dynamic, transition, duration, flags
    }
    if flags2 & 0x04 != 0 {
        r.skip(1)?; // tremolo picking speed
    }
    if flags2 & 0x08 != 0 {
        r.skip(1)?; // slide type bitmask
    }
    if flags2 & 0x10 != 0 {
        let offset = r.position();
        match r.read_i8()? {
            1 | 4 | 5 => {}  // natural, pinch, semi
            2 => r.skip(3)?, // artificial: semitone, accidental, octave
            3 => r.skip(1)?, // tapped: fret
            other => {
                return Err(GpError::InvalidData {
                    offset,
                    message: format!("harmonic type {other}"),
                });
            }
        }
    }
    if flags2 & 0x20 != 0 {
        r.skip(2)?; // trill: fret, period
    }
    Ok(())
}
