//! Golden-snapshot tests for the 4-bars-per-line grid layout
//! engine across five canonical progression shapes (#2060 AC).
//!
//! Each helper builds an `IrealSong` deterministically; the
//! corresponding `tests/fixtures/<name>/expected.svg` snapshot is
//! checked byte-for-byte. Regenerate any snapshot with
//!
//! ```bash
//! UPDATE_GOLDEN=1 cargo test -p chordsketch-render-ireal --test progressions
//! ```
//!
//! and re-run without the env var to confirm parity.

use chordsketch_ireal::{
    Bar, BarChord, BeatPosition, Chord, ChordQuality, ChordRoot, IrealSong, KeyMode, KeySignature,
    Section, SectionLabel,
};
use chordsketch_render_ireal::{RenderOptions, render_svg};

fn bar_with_chord(note: char, quality: ChordQuality) -> Bar {
    let chord = Chord::triad(ChordRoot::natural(note), quality);
    Bar {
        chords: vec![BarChord {
            chord,
            position: BeatPosition::on_beat(1).unwrap(),
        }],
        ..Bar::new()
    }
}

fn bar_with_two_chords(c1: (char, ChordQuality), c2: (char, ChordQuality)) -> Bar {
    Bar {
        chords: vec![
            BarChord {
                chord: Chord::triad(ChordRoot::natural(c1.0), c1.1),
                position: BeatPosition::on_beat(1).unwrap(),
            },
            BarChord {
                chord: Chord::triad(ChordRoot::natural(c2.0), c2.1),
                position: BeatPosition::on_beat(3).unwrap(),
            },
        ],
        ..Bar::new()
    }
}

fn check_golden(name: &str, song: &IrealSong) {
    let path = format!(
        "{}/tests/fixtures/{}/expected.svg",
        env!("CARGO_MANIFEST_DIR"),
        name,
    );
    let actual = render_svg(song, &RenderOptions::default());
    if std::env::var_os("UPDATE_GOLDEN").is_some() {
        std::fs::write(&path, &actual).unwrap_or_else(|e| panic!("write {path}: {e}"));
    }
    let expected = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("read {path}: {e} — set UPDATE_GOLDEN=1 to regenerate"));
    assert_eq!(
        actual, expected,
        "render output drifted for {name}; rerun with UPDATE_GOLDEN=1 to regenerate"
    );
}

// ---------------------------------------------------------------------------
// Fixture: 12-bar blues
//
// One section, 12 bars in C major. Classic I-IV-V chord set; tests that
// 12 ÷ 4 = 3 rows align cleanly without trailing empties.
// ---------------------------------------------------------------------------

fn twelve_bar_blues() -> IrealSong {
    let mut song = IrealSong::new();
    song.title = "12-Bar Blues in C".into();
    song.style = Some("Medium Blues".into());
    song.key_signature = KeySignature {
        root: ChordRoot::natural('C'),
        mode: KeyMode::Major,
    };
    let bars = vec![
        bar_with_chord('C', ChordQuality::Dominant7), // I
        bar_with_chord('F', ChordQuality::Dominant7), // IV
        bar_with_chord('C', ChordQuality::Dominant7), // I
        bar_with_chord('C', ChordQuality::Dominant7), // I
        bar_with_chord('F', ChordQuality::Dominant7), // IV
        bar_with_chord('F', ChordQuality::Dominant7), // IV
        bar_with_chord('C', ChordQuality::Dominant7), // I
        bar_with_chord('C', ChordQuality::Dominant7), // I
        bar_with_chord('G', ChordQuality::Dominant7), // V
        bar_with_chord('F', ChordQuality::Dominant7), // IV
        bar_with_chord('C', ChordQuality::Dominant7), // I
        bar_with_chord('G', ChordQuality::Dominant7), // V (turnaround)
    ];
    song.sections.push(Section {
        label: SectionLabel::Letter('A'),
        bars,
    });
    song
}

#[test]
fn render_twelve_bar_blues() {
    check_golden("twelve_bar_blues", &twelve_bar_blues());
}

// ---------------------------------------------------------------------------
// Fixture: AABA 32-bar form
//
// Four sections × 8 bars. Tests that section breaks align row starts
// and that no trailing empties are emitted between sections that end
// at a 4-bar boundary.
// ---------------------------------------------------------------------------

fn aaba_32_bar() -> IrealSong {
    let mut song = IrealSong::new();
    song.title = "AABA Standard".into();
    song.style = Some("Medium Swing".into());
    song.key_signature = KeySignature {
        root: ChordRoot::natural('B'),
        mode: KeyMode::Major,
    };
    let a_section = || -> Vec<Bar> {
        vec![
            bar_with_chord('B', ChordQuality::Major7),
            bar_with_chord('E', ChordQuality::Minor7),
            bar_with_chord('A', ChordQuality::Dominant7),
            bar_with_chord('D', ChordQuality::Major7),
            bar_with_chord('B', ChordQuality::Major7),
            bar_with_chord('F', ChordQuality::Minor7),
            bar_with_chord('B', ChordQuality::Dominant7),
            bar_with_chord('E', ChordQuality::Major7),
        ]
    };
    let b_section = vec![
        bar_with_chord('A', ChordQuality::Minor7),
        bar_with_chord('D', ChordQuality::Dominant7),
        bar_with_chord('G', ChordQuality::Major7),
        bar_with_chord('C', ChordQuality::Minor7),
        bar_with_chord('F', ChordQuality::Dominant7),
        bar_with_chord('B', ChordQuality::Major7),
        bar_with_chord('C', ChordQuality::Minor7),
        bar_with_chord('F', ChordQuality::Dominant7),
    ];
    song.sections.push(Section {
        label: SectionLabel::Letter('A'),
        bars: a_section(),
    });
    song.sections.push(Section {
        label: SectionLabel::Letter('A'),
        bars: a_section(),
    });
    song.sections.push(Section {
        label: SectionLabel::Letter('B'),
        bars: b_section,
    });
    song.sections.push(Section {
        label: SectionLabel::Letter('A'),
        bars: a_section(),
    });
    song
}

#[test]
fn render_aaba_32_bar() {
    check_golden("aaba_32bar", &aaba_32_bar());
}

// ---------------------------------------------------------------------------
// Fixture: 16-bar loop
//
// Single section, 16 bars; 4 clean rows, no section break.
// ---------------------------------------------------------------------------

fn sixteen_bar_loop() -> IrealSong {
    let mut song = IrealSong::new();
    song.title = "Sixteen-Bar Vamp".into();
    song.style = Some("Bossa Nova".into());
    let bars = (0..16)
        .map(|i| {
            // Alternate Dm7 / G7 each bar.
            if i % 2 == 0 {
                bar_with_chord('D', ChordQuality::Minor7)
            } else {
                bar_with_chord('G', ChordQuality::Dominant7)
            }
        })
        .collect();
    song.sections.push(Section {
        label: SectionLabel::Letter('A'),
        bars,
    });
    song
}

#[test]
fn render_sixteen_bar_loop() {
    check_golden("sixteen_bar_loop", &sixteen_bar_loop());
}

// ---------------------------------------------------------------------------
// Fixture: irregular section-break layout
//
// Sections of 3, 5, 4 bars. Forces trailing-empty cells in the first
// row (3 bars) and second row (5 bars wraps to 4+1, leaving 3
// trailers). Validates the section-break wrap rule.
// ---------------------------------------------------------------------------

fn section_break_irregular() -> IrealSong {
    let mut song = IrealSong::new();
    song.title = "Irregular Form".into();
    song.style = Some("Free Time".into());
    let intro = vec![
        bar_with_chord('C', ChordQuality::Major7),
        bar_with_chord('A', ChordQuality::Minor7),
        bar_with_chord('D', ChordQuality::Minor7),
    ];
    let verse = vec![
        bar_with_chord('G', ChordQuality::Dominant7),
        bar_with_chord('C', ChordQuality::Major7),
        bar_with_chord('A', ChordQuality::Minor7),
        bar_with_chord('D', ChordQuality::Minor7),
        bar_with_chord('G', ChordQuality::Dominant7),
    ];
    let coda = vec![
        bar_with_chord('C', ChordQuality::Major7),
        bar_with_chord('F', ChordQuality::Major7),
        bar_with_chord('C', ChordQuality::Major7),
        bar_with_chord('G', ChordQuality::Dominant7),
    ];
    song.sections.push(Section {
        label: SectionLabel::Intro,
        bars: intro,
    });
    song.sections.push(Section {
        label: SectionLabel::Verse,
        bars: verse,
    });
    song.sections.push(Section {
        label: SectionLabel::Outro,
        bars: coda,
    });
    song
}

#[test]
fn render_section_break_irregular() {
    check_golden("section_break_irregular", &section_break_irregular());
}

// ---------------------------------------------------------------------------
// Fixture: multi-chord bar
//
// Single section, 4 bars; bar 2 holds two chords (a "split bar" in
// iReal Pro parlance). Validates that the simple-flat-layout joins
// chords with a space and centres the combined string in the cell.
// ---------------------------------------------------------------------------

fn multi_chord_bar() -> IrealSong {
    let mut song = IrealSong::new();
    song.title = "Split-Bar Demo".into();
    song.style = Some("Medium Swing".into());
    let bars = vec![
        bar_with_chord('C', ChordQuality::Major7),
        bar_with_two_chords(('A', ChordQuality::Minor7), ('D', ChordQuality::Minor7)),
        bar_with_chord('G', ChordQuality::Dominant7),
        bar_with_chord('C', ChordQuality::Major7),
    ];
    song.sections.push(Section {
        label: SectionLabel::Letter('A'),
        bars,
    });
    song
}

#[test]
fn render_multi_chord_bar() {
    check_golden("multi_chord_bar", &multi_chord_bar());
}
