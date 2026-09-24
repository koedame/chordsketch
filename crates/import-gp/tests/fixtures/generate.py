#!/usr/bin/env python3
"""Regenerate the Guitar Pro 5 fixtures in this directory.

    python3 -m venv /tmp/gp-venv
    /tmp/gp-venv/bin/pip install pyguitarpro==0.11
    /tmp/gp-venv/bin/python crates/import-gp/tests/fixtures/generate.py

The fixtures are written with PyGuitarPro (LGPL-3.0, used as a tool only;
none of its code is part of this repository), an open-source reader and
writer for the Guitar Pro 3-5 binary formats. Every song is either in the
public domain or was written for this test suite, so the files can be
redistributed under the repository's MIT licence. See README.md next to
this script for what each fixture exercises.

The output is deterministic: running the script twice produces
byte-identical files, which `git diff` on the fixtures confirms.
"""

from pathlib import Path

import guitarpro as gp
from guitarpro import models as m

HERE = Path(__file__).resolve().parent

# Standard tuning, string 1 (high E) first, as MIDI note numbers.
GUITAR_TUNING = [64, 59, 55, 50, 45, 40]
BASS_TUNING = [43, 38, 33, 28]

# Guitar Pro duration values: 1 = whole, 2 = half, 4 = quarter, ...
WHOLE, HALF, QUARTER, EIGHTH, SIXTEENTH = 1, 2, 4, 8, 16

# Chord types, by the value Guitar Pro stores (see ChordType in
# PyGuitarPro's models).
MAJOR, SEVENTH, MAJOR_SEVENTH, MINOR, MINOR_SEVENTH = 0, 1, 2, 4, 5


def new_song(title, *, artist="", words="", music="", copyright_="", tempo=120, version):
    song = m.Song(tracks=[], measureHeaders=[])
    song.versionTuple = version
    song.title = title
    song.artist = artist
    song.words = words
    song.music = music
    song.copyright = copyright_
    song.tempo = tempo
    return song


def add_headers(song, count, numerator, denominator=4):
    for number in range(1, count + 1):
        header = m.MeasureHeader(number=number)
        header.timeSignature = m.TimeSignature(numerator=numerator, denominator=m.Duration(value=denominator))
        song.addMeasureHeader(header)


def add_track(song, name, tuning, *, capo=0, channel=0, instrument=25):
    # Track's default factory already builds one measure per header.
    track = m.Track(song, number=len(song.tracks) + 1, name=name, offset=capo)
    track.strings = [m.GuitarString(i + 1, value) for i, value in enumerate(tuning)]
    track.channel = m.MidiChannel(channel=channel, effectChannel=channel + 1, instrument=instrument)
    song.tracks.append(track)
    return track


def chord(name, *, root=0, type_=MAJOR, frets=(), sharp=False):
    """A new-format chord diagram. `frets` lists strings 1..6 (-1 = muted)."""
    c = m.Chord(length=6)
    c.newFormat = True
    c.sharp = sharp
    c.name = name
    c.root = m.PitchClass(root)
    c.type = m.ChordType(type_)
    c.bass = m.PitchClass(root)
    c.add = False
    c.firstFret = 1
    c.strings = list(frets) + [-1] * (6 - len(frets))
    c.show = True
    return c


def beat(voice, duration, notes=(), *, dotted=False, tuplet=None, chord_=None, text=None, rest=False):
    """Append a beat. `notes` is a list of (string, fret) or (string, fret, effect_fn)."""
    b = m.Beat(voice)
    b.duration = m.Duration(value=duration, isDotted=dotted)
    if tuplet:
        b.duration.tuplet = m.Tuplet(*tuplet)
    b.status = m.BeatStatus.rest if rest or not notes else m.BeatStatus.normal
    for entry in notes:
        string, fret = entry[0], entry[1]
        note = m.Note(b, value=fret, string=string, type=m.NoteType.normal)
        if len(entry) > 2:
            entry[2](note)
        b.notes.append(note)
    if chord_ is not None:
        b.effect.chord = chord_
    if text is not None:
        b.text = text
    voice.beats.append(b)
    return b


def write(song, filename, version):
    # Guitar Pro writes one "empty" beat into a voice that has no notes;
    # readers such as alphaTab expect every voice to have at least one beat.
    for track in song.tracks:
        for measure in track.measures:
            for voice in measure.voices:
                if not voice.beats:
                    empty = m.Beat(voice, status=m.BeatStatus.empty)
                    empty.duration = m.Duration(value=QUARTER)
                    voice.beats.append(empty)
    gp.write(song, str(HERE / filename), version=version)


# ---------------------------------------------------------------------------
# 1. Amazing Grace — words John Newton (1779), melody traditional. Public
#    domain. The arrangement below was written for this test suite.
#
#    Exercises: GP 5.10 header, 3/4, G major, one track, lyrics on the chord
#    track with a line break per phrase, hyphenated syllables, chords on rest
#    beats (pickup measures), a single section marker.
# ---------------------------------------------------------------------------


def amazing_grace():
    song = new_song(
        "Amazing Grace",
        artist="Traditional",
        words="John Newton",
        music="Traditional",
        copyright_="Public domain",
        tempo=72,
        version=(5, 1, 0),
    )
    add_headers(song, 18, 3)
    song.measureHeaders[0].keySignature = m.KeySignature.GMajor
    song.measureHeaders[0].marker = m.Marker(title="Verse 1")
    for header in song.measureHeaders[1:]:
        header.keySignature = m.KeySignature.GMajor
    track = add_track(song, "Acoustic Guitar", GUITAR_TUNING)

    g, g7, c, em, d, d7 = (
        chord("G", root=7, frets=(3, 0, 0, 0, 2, 3)),
        chord("G7", root=7, type_=SEVENTH, frets=(1, 0, 0, 0, 2, 3)),
        chord("C", root=0, frets=(0, 1, 0, 2, 3, -1)),
        chord("Em", root=4, type_=MINOR, frets=(0, 0, 0, 2, 2, 0)),
        chord("D", root=2, frets=(2, 3, 2, 0, -1, -1)),
        chord("D7", root=2, type_=SEVENTH, frets=(2, 1, 2, 0, -1, -1)),
    )
    # Melody pitches as (string, fret) in open position.
    D4, E4, G4, A4, B4, D5 = (4, 0), (4, 2), (3, 0), (3, 2), (2, 0), (2, 3)

    # (chord on the downbeat or None, [(duration, dotted, pitch or None)])
    bars = [
        (None, [(HALF, False, None), (QUARTER, False, D4)]),
        (g, [(HALF, False, G4), (QUARTER, False, B4)]),
        (g7, [(HALF, False, B4), (QUARTER, False, A4)]),
        (c, [(HALF, False, G4), (QUARTER, False, E4)]),
        (g, [(HALF, True, D4)]),
        (g, [(HALF, False, None), (QUARTER, False, D4)]),
        (None, [(HALF, False, G4), (QUARTER, False, B4)]),
        (em, [(HALF, False, B4), (QUARTER, False, A4)]),
        (d, [(HALF, True, D5)]),
        (d7, [(HALF, False, None), (QUARTER, False, B4)]),
        (g, [(HALF, False, D5), (QUARTER, False, B4)]),
        (g7, [(HALF, False, D5), (QUARTER, False, B4)]),
        (c, [(HALF, False, A4), (QUARTER, False, G4)]),
        (g, [(HALF, True, E4)]),
        (g, [(HALF, False, None), (QUARTER, False, D4)]),
        (em, [(HALF, False, G4), (QUARTER, False, B4)]),
        (d, [(HALF, False, B4), (QUARTER, False, A4)]),
        (g, [(HALF, True, G4)]),
    ]
    for measure, (chord_, notes) in zip(track.measures, bars):
        voice = measure.voices[0]
        for i, (duration, dotted, pitch) in enumerate(notes):
            beat(voice, duration, [pitch] if pitch else [], dotted=dotted, chord_=chord_ if i == 0 else None)

    song.lyrics = m.Lyrics(trackChoice=1)
    song.lyrics.lines[0].startingMeasure = 1
    song.lyrics.lines[0].lyrics = (
        "A- ma- zing grace how sweet the sound\n"
        "That saved a wretch like me\n"
        "I once was lost but now am found\n"
        "Was blind but now I see"
    )
    write(song, "amazing-grace.gp5", (5, 1, 0))


# ---------------------------------------------------------------------------
# 2. Harbor Lights — written for this test suite (MIT, like the repository).
#
#    Exercises: GP 5.00 header, three tracks (lyrics on the melody track,
#    chords on the rhythm guitar, a bass with no chords), capo 2 on the chord
#    track, E minor, sections Intro / Verse / Chorus, a chord-only intro, a
#    tempo change and a 2/4 bar mid-song, two lyric lines that start at
#    different measures, a chord diagram with an empty name, a chord in the
#    second voice, triplets, dotted notes, rests, and a spread of note and
#    beat effects the parser has to step over.
# ---------------------------------------------------------------------------


def with_bend(note):
    note.effect.bend = m.BendEffect(
        type=m.BendType.bend,
        value=50,
        points=[m.BendPoint(0, 0), m.BendPoint(6, 2), m.BendPoint(12, 2)],
    )


def with_slide(note):
    note.effect.slides = [m.SlideType.legatoSlideTo]


def with_hammer(note):
    note.effect.hammer = True


def with_harmonic(note):
    note.effect.harmonic = m.NaturalHarmonic()


def with_grace(note):
    note.effect.grace = m.GraceEffect(fret=2, duration=32, transition=m.GraceEffectTransition.slide)


def with_vibrato_and_palm_mute(note):
    note.effect.vibrato = True
    note.effect.palmMute = True


def dead(note):
    note.type = m.NoteType.dead


def harbor_lights():
    song = new_song(
        "Harbor Lights",
        artist="ChordSketch Test Band",
        words="ChordSketch contributors",
        music="ChordSketch contributors",
        copyright_="MIT",
        tempo=96,
        version=(5, 0, 0),
    )
    song.subtitle = "A test song"
    song.album = "Fixtures"
    add_headers(song, 13, 4)
    for header in song.measureHeaders:
        header.keySignature = m.KeySignature.EMinor
    song.measureHeaders[0].marker = m.Marker(title="Intro")
    song.measureHeaders[2].marker = m.Marker(title="Verse")
    song.measureHeaders[6].timeSignature = m.TimeSignature(numerator=2, denominator=m.Duration(value=4))
    song.measureHeaders[7].marker = m.Marker(title="Chorus")

    melody = add_track(song, "Vocal Melody", GUITAR_TUNING, channel=0, instrument=53)
    rhythm = add_track(song, "Rhythm Guitar", GUITAR_TUNING, capo=2, channel=2, instrument=25)
    bass = add_track(song, "Bass", BASS_TUNING, channel=4, instrument=33)

    # Chord shapes relative to the capo on fret 2 (Guitar Pro stores frets and
    # chord diagrams relative to the capo). Sounding chords are two semitones
    # higher: Em -> F#m, C -> D, G -> A, D -> E, Am7 -> Bm7.
    em = chord("Em", root=4, type_=MINOR, frets=(0, 0, 0, 2, 2, 0))
    c = chord("C", root=0, frets=(0, 1, 0, 2, 3, -1))
    g = chord("G", root=7, frets=(3, 0, 0, 0, 2, 3))
    d = chord("D", root=2, frets=(2, 3, 2, 0, -1, -1))
    am7 = chord("Am7", root=9, type_=MINOR_SEVENTH, frets=(0, 1, 0, 2, 0, -1))
    # No name: the importer has to spell it from root + type (Gmaj7 shape).
    gmaj7 = chord("", root=7, type_=MAJOR_SEVENTH, frets=(2, 0, 0, 0, 2, 3))

    strum = [(3, 0), (2, 0), (1, 0)]
    progression = [
        # (measure index, [chord per half-bar]); None keeps the previous chord.
        (0, [em, None]),
        (1, [c, d]),
        (2, [em, None]),
        (3, [c, g]),
        (4, [am7, None]),
        (5, [d, None]),
        (6, [em]),  # 2/4 bar
        (7, [g, None]),
        (8, [d, None]),
        (9, [em, c]),
        (10, [gmaj7, None]),
        (11, [am7, d]),
        (12, [em, None]),
    ]
    for index, chords in progression:
        voice = rhythm.measures[index].voices[0]
        for half, chord_ in enumerate(chords):
            if index == 5 and half == 0:
                # Stroke + dead strum + let ring to cover beat effects.
                b = beat(voice, QUARTER, [(3, 2), (2, 3), (1, 2)], chord_=None)
                b.effect.stroke = m.BeatStroke(m.BeatStrokeDirection.down, 16)
                beat(voice, QUARTER, [(3, 2, dead), (2, 3, dead)])
                continue
            beat(voice, QUARTER, strum, chord_=chord_)
            beat(voice, EIGHTH, strum)
            beat(voice, EIGHTH, strum)
    # The D in measure 6 sits in the second voice, under a bass pedal.
    voice2 = rhythm.measures[5].voices[1]
    beat(voice2, QUARTER, [], rest=True)
    beat(voice2, QUARTER, [(4, 0)], chord_=d)
    beat(voice2, HALF, [(4, 0)])

    # Bass: roots in half notes, a mix-table tempo change at the chorus.
    for index, measure in enumerate(bass.measures):
        voice = measure.voices[0]
        if index == 6:
            beat(voice, HALF, [(3, 2, with_vibrato_and_palm_mute)])
            continue
        first = beat(voice, HALF, [(3, 2)])
        beat(voice, HALF, [(3, 2, with_slide)])
        if index == 7:
            first.effect.mixTableChange = m.MixTableChange(
                tempo=m.MixTableItem(value=104, duration=0), tempoName="Chorus", hideTempo=False
            )

    # Melody. Intro (measures 1-2) is instrumental. Each entry is a list of
    # (duration, pitch or None, extras) where extras may hold dotted/tuplet.
    A3, B3, D4, E4, Fs4, G4, A4, B4 = (5, 0), (5, 2), (4, 0), (4, 2), (4, 4), (3, 0), (3, 2), (2, 0)
    melody_bars = {
        0: [(WHOLE, None, {})],
        1: [(HALF, B4, {"effect": with_harmonic}), (HALF, None, {})],
        # Verse (lyric line 1 starts at measure 3)
        2: [(QUARTER, None, {}), (QUARTER, E4, {}), (QUARTER, G4, {}), (QUARTER, A4, {})],
        3: [(HALF, B4, {"effect": with_bend}), (QUARTER, A4, {}), (QUARTER, G4, {"effect": with_hammer})],
        4: [(QUARTER, E4, {"dotted": True}), (EIGHTH, D4, {}), (HALF, E4, {})],
        5: [(EIGHTH, Fs4, {"tuplet": (3, 2)}), (EIGHTH, G4, {"tuplet": (3, 2)}), (EIGHTH, A4, {"tuplet": (3, 2)}),
            (QUARTER, B4, {}), (HALF, None, {})],
        6: [(HALF, None, {})],
        # Chorus (lyric line 2 starts at measure 8)
        7: [(QUARTER, B4, {"effect": with_grace}), (QUARTER, B4, {}), (QUARTER, A4, {}), (QUARTER, G4, {})],
        8: [(HALF, Fs4, {}), (QUARTER, E4, {}), (QUARTER, D4, {})],
        9: [(QUARTER, E4, {}), (QUARTER, G4, {}), (SIXTEENTH, A4, {}), (SIXTEENTH, B4, {}), (EIGHTH, A4, {}),
            (QUARTER, G4, {})],
        10: [(WHOLE, B4, {})],
        11: [(QUARTER, A4, {}), (QUARTER, G4, {}), (QUARTER, Fs4, {}), (QUARTER, D4, {})],
        12: [(WHOLE, E4, {})],
    }
    for index, notes in melody_bars.items():
        voice = melody.measures[index].voices[0]
        for duration, pitch, extras in notes:
            entry = [(pitch[0], pitch[1], extras["effect"])] if pitch and "effect" in extras else ([pitch] if pitch else [])
            beat(voice, duration, entry, dotted=extras.get("dotted", False), tuplet=extras.get("tuplet"))
    melody.measures[3].voices[0].beats[0].text = "softly"

    song.lyrics = m.Lyrics(trackChoice=1)
    # Line 1: 12 syllables over the verse (measures 3-6). `+` joins two
    # words onto one beat, `[...]` is a comment, a trailing `_` marks a held
    # syllable.
    song.lyrics.lines[0].startingMeasure = 3
    song.lyrics.lines[0].lyrics = (
        "[verse] Lan- terns on the wa- ter\n"
        "Guide+me home to- night__"
    )
    # Line 2: the chorus, starting at measure 8.
    song.lyrics.lines[1].startingMeasure = 8
    song.lyrics.lines[1].lyrics = (
        "Har- bor lights are call- ing\n"
        "Bring me back a- gain to shore\n"
        "Home"
    )
    write(song, "harbor-lights.gp5", (5, 0, 0))


# ---------------------------------------------------------------------------
# 3. Greensleeves — traditional English ballad (16th century), public
#    domain. The arrangement below was written for this test suite.
#
#    Exercises: GP 5.10 header, 6/8, A minor, lyrics with no line breaks (the
#    importer has to break lines itself), chords on beat 1 and beat 4 of the
#    bar, chord diagrams in the second (bass) voice only, sections Verse /
#    Refrain.
# ---------------------------------------------------------------------------


def greensleeves():
    song = new_song(
        "Greensleeves",
        artist="Traditional",
        words="Traditional",
        music="Traditional",
        copyright_="Public domain",
        tempo=100,
        version=(5, 1, 0),
    )
    add_headers(song, 8, 6, 8)
    for header in song.measureHeaders:
        header.keySignature = m.KeySignature.AMinor
    song.measureHeaders[0].marker = m.Marker(title="Verse")
    song.measureHeaders[4].marker = m.Marker(title="Refrain")
    track = add_track(song, "Classical Guitar", GUITAR_TUNING, instrument=24)

    am = chord("Am", root=9, type_=MINOR, frets=(0, 1, 2, 2, 0, -1))
    g = chord("G", root=7, frets=(3, 0, 0, 0, 2, 3))
    f = chord("F", root=5, frets=(1, 1, 2, 3, 3, 1))
    e = chord("E", root=4, frets=(0, 0, 1, 2, 2, 0))
    c = chord("C", root=0, frets=(0, 1, 0, 2, 3, -1))

    # Melody in voice 1: six eighth-note slots per bar as (duration, pitch).
    A4, B4, C5, D5, E5, G4, Gs4, F4 = (3, 2), (2, 0), (2, 1), (2, 3), (1, 0), (3, 0), (3, 1), (4, 3)
    melody = [
        [(QUARTER, A4), (EIGHTH, C5), (QUARTER, D5), (EIGHTH, E5)],
        [(QUARTER, E5), (EIGHTH, D5), (QUARTER, C5), (EIGHTH, A4)],
        [(QUARTER, G4), (EIGHTH, A4), (QUARTER, B4), (EIGHTH, G4)],
        [(QUARTER, E5), (EIGHTH, D5), (QUARTER, C5), (EIGHTH, B4)],
        [(QUARTER, E5), (EIGHTH, D5), (QUARTER, C5), (EIGHTH, A4)],
        [(QUARTER, G4), (EIGHTH, A4), (QUARTER, B4), (EIGHTH, Gs4)],
        [(QUARTER, A4), (EIGHTH, F4), (QUARTER, Gs4), (EIGHTH, B4)],
        [(QUARTER, A4), (EIGHTH, A4), (QUARTER, A4), (EIGHTH, None)],
    ]
    # Bass in voice 2: dotted quarters, carrying the chord diagrams.
    bass = [(am, (5, 0)), (am, (5, 0)), (g, (6, 3)), (e, (6, 0)), (c, (5, 3)), (g, (6, 3)), (f, (6, 1)), (am, (5, 0))]
    second_half = [None, None, None, None, None, e, e, None]
    for index, measure in enumerate(track.measures):
        voice1, voice2 = measure.voices[0], measure.voices[1]
        for duration, pitch in melody[index]:
            beat(voice1, duration, [pitch] if pitch else [])
        chord_, root = bass[index]
        beat(voice2, QUARTER, [root], dotted=True, chord_=chord_)
        beat(voice2, QUARTER, [root], dotted=True, chord_=second_half[index])

    song.lyrics = m.Lyrics(trackChoice=1)
    song.lyrics.lines[0].startingMeasure = 1
    # 28 syllables over the first 28 of the 31 melody notes, on one line on
    # purpose so the importer has to choose the line breaks.
    song.lyrics.lines[0].lyrics = (
        "A- las my love you do me wrong to cast me off dis- cour- teous- ly "
        "Green- sleeves was all my joy Green- sleeves was my de- light"
    )
    write(song, "greensleeves.gp5", (5, 1, 0))


if __name__ == "__main__":
    amazing_grace()
    harbor_lights()
    greensleeves()
