//! Algorithmic chord-voicing synthesis.
//!
//! The curated tables in [`crate::voicings`] cover only a handful of chord
//! families per instrument (major / minor / dominant-7 / major-7 / minor-7 for
//! guitar, fewer for ukulele). Every other chord the parser understands —
//! every type the editor's chord-type palette can produce — used to fall
//! through to "no diagram available".
//!
//! This module closes that gap structurally rather than by hand-authoring
//! hundreds of voicings: given a chord's pitch-class content (from
//! [`crate::chord::chord_tones`]) it searches the fretboard for a playable
//! voicing whose sounded notes are all chord tones, that contains every
//! essential tone, and that places the bass sensibly. Because the search is
//! driven by the chord's tones — not by a per-type lookup table — any chord
//! type the parser can model automatically gets a diagram, and the diagram
//! coverage of the chord-type palette stays at 100% with no per-type data to
//! maintain (see `.claude/rules/chord-diagram-coverage.md`).
//!
//! The synthesiser is a *fallback*: [`crate::voicings::lookup_diagram`] and
//! [`crate::voicings::lookup_keyboard_voicing`] consult song `{define}`
//! directives and the curated tables first, so hand-tuned canonical shapes are
//! always preferred. Synthesis only runs when nothing else matched.

use crate::chord::chord_tones;
use crate::chord_diagram::{DiagramData, KeyboardVoicing};

/// Standard six-string guitar tuning (EADGBE) as absolute MIDI pitches, in the
/// diagram's string order (string 6 / low E first).
const GUITAR_TUNING: &[i32] = &[40, 45, 50, 55, 59, 64];

/// Standard re-entrant ukulele tuning (gCEA) as absolute MIDI pitches, in the
/// diagram's string order (string 4 / high g first), matching the curated
/// ukulele tables.
const UKULELE_TUNING: &[i32] = &[67, 60, 64, 69];

/// Charango tuning (G4 C5 E4 A4 E5) as absolute MIDI pitches, in upstream
/// string order — matching the curated [`crate::voicings`] charango table.
const CHARANGO_TUNING: &[i32] = &[67, 72, 64, 69, 76];

/// Number of visible fret rows beyond the anchor fret the search spans (a
/// four-fret window — the practical stretch of a hand without repositioning).
/// `pub(crate)` so the coverage tests in [`crate::voicings`] assert against the
/// same bound the synthesiser enforces rather than a hardcoded copy.
pub(crate) const SPAN: i32 = 3;

/// Highest anchor fret the search considers. Twelve frets is one full octave,
/// enough to voice every chord in at least one position.
const MAX_POSITION: i32 = 12;

/// The most fingers a fretting hand has. A voicing estimated to need more than
/// this is rejected as unplayable, no matter how many chord tones it sounds.
/// `pub(crate)` for the same reason as [`SPAN`].
pub(crate) const MAX_FINGERS: i64 = 4;

// Scoring weights for [`evaluate`], in descending magnitude. Only the *ordering*
// of these magnitudes is load-bearing — the search returns the highest-scoring
// assignment, so what matters is that a higher-priority term can never be
// outweighed by the sum of every lower-priority term across the values they can
// take. They are named (rather than inlined) so a future tweak to one weight is
// reviewed against the others instead of buried as a bare literal.

/// Reward per distinct chord tone sounded. An order of magnitude above every
/// penalty so a richer voicing always wins and a non-essential extra tone is
/// never traded away for a cheaper-to-fret shape.
const W_COVERED: i64 = 10_000;
/// Penalty per finger. Outranks the per-string rewards so the search prefers
/// the simplest shape that voices the chord over a denser barre.
const W_FINGERS: i64 = 700;
/// Penalty per fret of span — biases toward compact, low-stretch shapes.
const W_SPAN: i64 = 400;
/// Penalty per anchor-fret position — open / first-position shapes are what a
/// learner reads off a diagram.
const W_POSITION: i64 = 500;
/// Reward per ringing open string.
const W_OPEN: i64 = 150;
/// Reward per sounded (non-muted) string.
const W_SOUNDED: i64 = 60;
/// Penalty per interior muted gap (hard to mute cleanly, reads poorly).
const W_GAP: i64 = 300;
/// Penalty per fret summed across fretted strings — a light tie-breaker pulling
/// otherwise-equal shapes toward lower frets.
const W_FRET_SUM: i64 = 10;

/// Returns the absolute-MIDI open-string tuning for an instrument name, in the
/// diagram's string order. Unknown instruments fall back to guitar, matching
/// [`crate::voicings::lookup_diagram`]'s dispatch.
#[must_use]
pub(crate) fn instrument_tuning(instrument: &str) -> &'static [i32] {
    match instrument.to_ascii_lowercase().as_str() {
        "ukulele" | "uke" => UKULELE_TUNING,
        "charango" => CHARANGO_TUNING,
        _ => GUITAR_TUNING,
    }
}

/// Builds a 12-bit pitch-class mask (`bit p` set ⇔ pitch class `p` present).
fn pc_mask(pcs: &[u8]) -> u16 {
    pcs.iter().fold(0u16, |m, &pc| m | (1u16 << (pc % 12)))
}

/// The lowest and highest *fretted* (`fret > 0`) positions in an assignment, or
/// `None` when no string is fretted. Open (`0`) and muted (`< 0`) strings are
/// ignored, so `high - low` is the fret span a hand must cover. The single
/// source of truth for the fretted range used by [`fingers_needed`],
/// [`fret_span`], and (through them) the search scorer and playability checks,
/// so those callers cannot drift apart.
fn fretted_extent(chosen: &[i32]) -> Option<(i32, i32)> {
    let mut lo = i32::MAX;
    let mut hi = i32::MIN;
    for &f in chosen {
        if f > 0 {
            lo = lo.min(f);
            hi = hi.max(f);
        }
    }
    (lo <= hi).then_some((lo, hi))
}

/// Fret span (`highest − lowest` fretted position) of an assignment; `0` when
/// fewer than two distinct fretted frets are present.
fn fret_span(chosen: &[i32]) -> i64 {
    match fretted_extent(chosen) {
        Some((lo, hi)) => i64::from(hi - lo),
        None => 0,
    }
}

/// Estimates the minimum number of fingers a fret assignment needs.
///
/// Each fretted string (`fret > 0`) costs one finger, with one saving: an
/// index-finger barre across the lowest fretted fret collapses the strings
/// sharing that fret into a single finger. The barre is only credited when no
/// open string is sounded — a barre lies across every string at that fret, so
/// it is incompatible with an open string ringing above it. Upper-fret partial
/// barres (a ring- or pinky-finger barre) are deliberately NOT credited: they
/// are real but advanced, so ignoring them biases the search toward the
/// simpler, more reliably playable shape a learner can actually fret. `0` for
/// an all-open / all-muted assignment.
fn fingers_needed(chosen: &[i32]) -> i64 {
    let Some((min_fret, _)) = fretted_extent(chosen) else {
        return 0;
    };
    let fretted = chosen.iter().filter(|&&f| f > 0).count() as i64;
    let has_open = chosen.contains(&0);
    let at_min = chosen.iter().filter(|&&f| f == min_fret).count() as i64;
    // An index barre at the lowest fret turns its `at_min` strings into one
    // finger, saving `at_min - 1` — but only when no open string forbids it.
    let barre_save = if !has_open && at_min >= 2 {
        at_min - 1
    } else {
        0
    };
    fretted - barre_save
}

/// Synthesises a fretboard voicing for `chord_name` on `instrument`, or `None`
/// when the name is not a parseable chord.
///
/// The returned diagram sounds only chord tones, contains every essential tone
/// of the chord, and — wherever a position allows it — puts the chord's bass
/// (root, or the slash bass) as the lowest-pitched string.
#[must_use]
pub(crate) fn synth_fretted_voicing(
    chord_name: &str,
    instrument: &str,
    frets_shown: usize,
) -> Option<DiagramData> {
    let tuning = instrument_tuning(instrument);
    let tones = chord_tones(chord_name)?;
    let target = pc_mask(&tones.pitch_classes);
    let essential = pc_mask(&tones.essential);

    // Pass A insists the lowest-sounding string is the bass (a root-position
    // voicing). When no position can satisfy that (common on the re-entrant
    // ukulele, where the lowest pitch is not the lowest-numbered string), pass
    // B relaxes to "the bass is sounded somewhere".
    for require_bass_low in [true, false] {
        if let Some(frets) = search(tuning, target, essential, tones.bass_pc, require_bass_low) {
            return Some(to_diagram(chord_name, &frets, frets_shown, tuning.len()));
        }
    }
    // Unreachable in practice: with 13 anchor positions across 4–6 strings and
    // a small essential set (≤ 4 pitch classes for any palette chord), pass B
    // always finds a valid voicing for any parseable chord. This path is the
    // correct fallback for hypothetical future chords whose essential set cannot
    // fit the instrument (e.g., a > 6-tone essential set on a 4-string ukulele).
    None
}

/// The fixed parameters of one anchor position's voicing search, threaded
/// through the backtracking so the recursive helpers stay narrow (and free of
/// a `clippy::too_many_arguments` allow).
struct SearchCtx<'a> {
    /// Open-string MIDI pitches, in diagram string order.
    tuning: &'a [i32],
    /// Pitch-class mask of the tones a valid voicing must sound.
    essential: u16,
    /// Pitch class of the chord's bass.
    bass_pc: u8,
    /// Whether the lowest-sounding string must be the bass.
    require_bass_low: bool,
    /// The anchor fret this search pass is built around (for scoring).
    position: i32,
}

/// Searches every anchor position for the best-scoring valid voicing.
fn search(
    tuning: &[i32],
    target: u16,
    essential: u16,
    bass_pc: u8,
    require_bass_low: bool,
) -> Option<Vec<i32>> {
    let n = tuning.len();
    let mut best: Option<(i64, Vec<i32>)> = None;

    for position in 0..=MAX_POSITION {
        // Per-string candidate frets that sound a chord tone within this
        // position's window, plus the always-available muted option (-1).
        let mut cands: Vec<Vec<i32>> = Vec::with_capacity(n);
        for &open in tuning {
            let mut c = vec![-1i32];
            for f in 0..=(position + SPAN) {
                let in_window = if position == 0 {
                    f <= SPAN
                } else if f == 0 {
                    // Open strings only make sense near the nut; up the neck a
                    // ringing open string sits jarringly below the shape.
                    position <= 1
                } else {
                    f >= position && f <= position + SPAN
                };
                if in_window {
                    let pc = ((open + f).rem_euclid(12)) as u8;
                    if target & (1u16 << pc) != 0 {
                        c.push(f);
                    }
                }
            }
            cands.push(c);
        }

        let ctx = SearchCtx {
            tuning,
            essential,
            bass_pc,
            require_bass_low,
            position,
        };
        let mut chosen = vec![-1i32; n];
        backtrack(0, &cands, &ctx, &mut chosen, &mut best);
    }

    best.map(|(_, frets)| frets)
}

/// Recursively assigns a fret to each string, evaluating complete assignments.
fn backtrack(
    string_idx: usize,
    cands: &[Vec<i32>],
    ctx: &SearchCtx,
    chosen: &mut [i32],
    best: &mut Option<(i64, Vec<i32>)>,
) {
    if string_idx == cands.len() {
        if let Some(score) = evaluate(chosen, ctx) {
            if best.as_ref().is_none_or(|(b, _)| score > *b) {
                *best = Some((score, chosen.to_vec()));
            }
        }
        return;
    }
    for &fret in &cands[string_idx] {
        chosen[string_idx] = fret;
        backtrack(string_idx + 1, cands, ctx, chosen, best);
    }
}

/// Scores a complete assignment, or returns `None` if it is not a valid
/// voicing of the chord. Higher scores are better.
fn evaluate(chosen: &[i32], ctx: &SearchCtx) -> Option<i64> {
    let SearchCtx {
        tuning,
        essential,
        bass_pc,
        require_bass_low,
        position,
    } = *ctx;
    let mut sounded_mask = 0u16;
    let mut sounded = 0i64;
    let mut open = 0i64;
    let mut fret_sum = 0i64;
    let mut min_pitch = i32::MAX;
    let mut first = usize::MAX;
    let mut last = 0usize;

    for (i, (&fret, &tune)) in chosen.iter().zip(tuning).enumerate() {
        if fret < 0 {
            continue;
        }
        sounded += 1;
        if fret == 0 {
            open += 1;
        } else {
            fret_sum += i64::from(fret);
        }
        let pitch = tune + fret;
        min_pitch = min_pitch.min(pitch);
        sounded_mask |= 1u16 << ((pitch.rem_euclid(12)) as u8);
        first = first.min(i);
        last = last.max(i);
    }

    // Must sound every essential tone and the bass.
    if essential & !sounded_mask != 0 {
        return None;
    }
    if sounded_mask & (1u16 << bass_pc) == 0 {
        return None;
    }
    if require_bass_low && (min_pitch.rem_euclid(12)) as u8 != bass_pc {
        return None;
    }

    // Muted strings wedged between two sounded strings are hard to mute
    // cleanly and read poorly on the diagram.
    let gaps = chosen[first..=last].iter().filter(|&&f| f < 0).count() as i64;
    let covered = i64::from(sounded_mask.count_ones());

    // Reject anything a hand cannot fret. A guitar chord is limited to four
    // fingers; a voicing that needs more is not a realistic shape no matter how
    // many chord tones it sounds, so it is discarded rather than scored.
    let fingers = fingers_needed(chosen);
    if fingers > MAX_FINGERS {
        return None;
    }

    // Fret span of the fretted notes — a wide span is a finger stretch, so
    // compact shapes are preferred among otherwise-equal voicings. Computed by
    // the same helper the playability checks use, so the bound asserted in tests
    // and the bound rewarded here cannot diverge.
    let span = fret_span(chosen);

    // Scoring priorities, in descending weight (see the `W_*` constants):
    //  1. Cover as many distinct chord tones as possible (a richer voicing).
    //  2. Use as few fingers as possible — a four-finger shape is the ceiling
    //     (enforced above), but easier shapes read better and play better.
    //  3. Sit as low on the neck as possible — open / first-position shapes are
    //     what a learner reads off a diagram.
    //  4. Keep the fret span compact — a narrow shape is less of a stretch.
    //  5. Avoid interior muted gaps (hard to mute cleanly, reads poorly).
    //  6. Prefer ringing open strings, then a few extra sounded strings.
    //  7. Minimise total fret distance as a final tie-breaker.
    // Position and finger count outrank the per-string rewards so the search
    // does not climb to a hard six-string barre when a simpler shape voices the
    // same chord.
    Some(
        covered * W_COVERED
            - fingers * W_FINGERS
            - span * W_SPAN
            - i64::from(position) * W_POSITION
            + open * W_OPEN
            + sounded * W_SOUNDED
            - gaps * W_GAP
            - fret_sum * W_FRET_SUM,
    )
}

/// Encodes a chosen absolute-fret assignment into renderable [`DiagramData`],
/// matching the curated tables' convention: nut-anchored shapes (with open
/// strings, or sitting at the first fret) use `base_fret = 1` and absolute
/// fret numbers; barre shapes up the neck shift to `base_fret = lowest fret`
/// with frets relative to it.
fn to_diagram(name: &str, frets_abs: &[i32], frets_shown: usize, strings: usize) -> DiagramData {
    let min_fretted = frets_abs.iter().copied().filter(|&f| f > 0).min();
    let has_open = frets_abs.contains(&0);

    let (base_fret, frets) = match min_fretted {
        Some(min_f) if !has_open && min_f > 1 => (
            min_f as u32,
            frets_abs
                .iter()
                .map(|&f| if f > 0 { f - min_f + 1 } else { f })
                .collect(),
        ),
        // Nut-anchored (open strings present, sits at fret 1, or all open/muted).
        _ => (1u32, frets_abs.to_vec()),
    };

    DiagramData {
        name: name.to_string(),
        display_name: None,
        strings,
        frets_shown,
        base_fret,
        frets,
        fingers: vec![],
    }
}

/// Synthesises a keyboard voicing for `chord_name`, or `None` when the name is
/// not a parseable chord. Lays the chord's tones out as MIDI keys (root
/// position, with a slash bass dropped below) and marks the root key.
#[must_use]
pub(crate) fn synth_keyboard_voicing(chord_name: &str) -> Option<KeyboardVoicing> {
    let keys = crate::chord::chord_pitches(chord_name)?;
    let tones = chord_tones(chord_name)?;
    // Prefer the lowest key that actually spells the root as the marked root
    // key. `chord_pitches` always places the root interval (0) first, and
    // `VOICING_ROOT_MIDI = 48 = 4 × 12`, so `keys[0] % 12 == root_pc` is an
    // invariant — the `find` always succeeds. For slash chords the bass is
    // prepended via `insert(0, …)` and the root key remains in the list. The
    // `unwrap_or(keys[0])` is a defence-in-depth guard against hypothetical
    // future changes to `chord_pitches` that break the invariant.
    let root_key = keys
        .iter()
        .copied()
        .find(|k| k % 12 == tones.root_pc)
        .unwrap_or(keys[0]);
    Some(KeyboardVoicing {
        name: chord_name.to_string(),
        display_name: None,
        keys,
        root_key,
    })
}

/// Pitch classes a rendered fretted diagram actually sounds on `instrument`.
///
/// Reverses the [`to_diagram`] fret encoding (`base_fret` + relative rows back
/// to absolute frets) and maps each sounded string to its pitch class. Shared
/// by the synthesiser's own tests and the chord-diagram coverage test in
/// [`crate::voicings`] so both verify musical correctness against one decoder.
#[cfg(test)]
#[must_use]
pub(crate) fn sounded_pitch_classes(data: &DiagramData, instrument: &str) -> Vec<u8> {
    let tuning = instrument_tuning(instrument);
    let mut pcs = Vec::new();
    for (i, &raw) in data.frets.iter().enumerate() {
        if raw < 0 || i >= tuning.len() {
            continue;
        }
        let abs = if raw == 0 {
            0
        } else {
            raw + data.base_fret as i32 - 1
        };
        let pc = ((tuning[i] + abs).rem_euclid(12)) as u8;
        pcs.push(pc);
    }
    pcs.sort_unstable();
    pcs.dedup();
    pcs
}

/// Decodes a rendered diagram back to absolute fret numbers (muted `-1`, open
/// `0`, fretted `n`), reversing the [`to_diagram`] `base_fret` encoding. Shared
/// by the playability checks below and the coverage test in [`crate::voicings`].
#[cfg(test)]
#[must_use]
pub(crate) fn absolute_frets(data: &DiagramData) -> Vec<i32> {
    data.frets
        .iter()
        .map(|&raw| {
            if raw <= 0 {
                raw
            } else {
                raw + data.base_fret as i32 - 1
            }
        })
        .collect()
}

/// The `(fingers, fret_span)` a rendered diagram requires — the playability
/// metrics the synthesiser bounds (`fingers ≤ MAX_FINGERS`, `span ≤ SPAN`).
#[cfg(test)]
#[must_use]
pub(crate) fn diagram_playability(data: &DiagramData) -> (i64, i64) {
    let abs = absolute_frets(data);
    (fingers_needed(&abs), fret_span(&abs))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sounded_pcs(data: &DiagramData, tuning: &[i32]) -> Vec<u8> {
        let instrument = if tuning.len() == 4 {
            "ukulele"
        } else if tuning.len() == 5 {
            "charango"
        } else {
            "guitar"
        };
        sounded_pitch_classes(data, instrument)
    }

    fn assert_valid(chord: &str, instrument: &str) {
        let tuning = instrument_tuning(instrument);
        let data = synth_fretted_voicing(chord, instrument, 5)
            .unwrap_or_else(|| panic!("no synth voicing for {chord} ({instrument})"));
        let tones = chord_tones(chord).unwrap();
        let target = pc_mask(&tones.pitch_classes);
        let essential = pc_mask(&tones.essential);
        let sounded = sounded_pcs(&data, tuning);
        let sounded_mask = pc_mask(&sounded);

        // No sounded note may be outside the chord.
        for &pc in &sounded {
            assert!(
                target & (1u16 << pc) != 0,
                "{chord} ({instrument}): sounded non-chord tone {pc} (frets {:?}, base {})",
                data.frets,
                data.base_fret
            );
        }
        // Every essential tone must be present.
        assert!(
            essential & !sounded_mask == 0,
            "{chord} ({instrument}): missing essential tones (have {sounded:?}, need essential mask {essential:012b})"
        );
        // The bass must be sounded.
        assert!(
            sounded_mask & (1u16 << tones.bass_pc) != 0,
            "{chord} ({instrument}): bass {} not sounded",
            tones.bass_pc
        );
        // String count matches the instrument.
        assert_eq!(data.strings, tuning.len());
        assert_eq!(data.frets.len(), tuning.len());
    }

    #[test]
    fn synthesises_basic_triads_on_guitar() {
        for chord in ["C", "Am", "Gdim", "Faug", "Csus4", "Dsus2", "C5"] {
            assert_valid(chord, "guitar");
        }
    }

    #[test]
    fn synthesised_voicings_are_fingerable() {
        // The dense extended / altered chords that used to synthesise five- and
        // six-finger shapes must now come out as something a hand can fret:
        // at most four fingers, within a four-fret span.
        //
        // This calls `synth_fretted_voicing` directly, so it exercises the
        // *synthesiser* regardless of curation. The exhaustive palette test in
        // `crate::voicings` asserts the same bound, but it routes through
        // `lookup_diagram` and skips playability for chords a curated table
        // happens to cover — so if one of these chords later gains a curated
        // entry, this test keeps the synthesiser itself under the bound.
        let chords = [
            "C9", "C11", "C13", "Cm11", "Cm13", "C7#9", "C7alt", "Eb9", "A11", "B13", "F11", "F13",
            "Bmaj9", "Gm7b5", "F7#11", "G7b13", "Ebm13", "F7#9",
        ];
        for chord in chords {
            for instrument in ["guitar", "ukulele", "charango"] {
                let data = synth_fretted_voicing(chord, instrument, 5)
                    .unwrap_or_else(|| panic!("no voicing for {chord} ({instrument})"));
                let (fingers, span) = diagram_playability(&data);
                assert!(
                    fingers <= MAX_FINGERS,
                    "{chord} ({instrument}): needs {fingers} fingers (frets {:?}, base {})",
                    data.frets,
                    data.base_fret,
                );
                assert!(
                    span <= SPAN as i64,
                    "{chord} ({instrument}): fret span {span} exceeds {SPAN} (frets {:?}, base {})",
                    data.frets,
                    data.base_fret,
                );
            }
        }
    }

    #[test]
    fn synthesises_extended_and_altered_on_guitar() {
        for chord in [
            "C9", "Cmaj9", "Am9", "C11", "Am11", "C13", "Am13", "C7b9", "C7#9", "C7#11", "C7b13",
            "C7alt", "Cadd9", "C6", "Am6", "C69", "CmMaj7", "Cm7b5", "Cdim7",
        ] {
            assert_valid(chord, "guitar");
        }
    }

    #[test]
    fn synthesises_extended_on_ukulele_and_charango() {
        for chord in ["C13", "Am7b5", "C7#11", "CmMaj7", "C7alt"] {
            assert_valid(chord, "ukulele");
            assert_valid(chord, "charango");
        }
    }

    #[test]
    fn synthesises_slash_chord_with_named_bass() {
        let data = synth_fretted_voicing("C/G", "guitar", 5).unwrap();
        let sounded = sounded_pcs(&data, GUITAR_TUNING);
        // G (pc 7) must be present as the bass.
        assert!(
            sounded.contains(&7),
            "C/G should sound a G bass: {sounded:?}"
        );
    }

    #[test]
    fn open_c_major_is_nut_anchored() {
        // The synthesiser should find the open C-major shape (base fret 1).
        let data = synth_fretted_voicing("C", "guitar", 5).unwrap();
        assert_eq!(data.base_fret, 1);
        assert_eq!(sounded_pcs(&data, GUITAR_TUNING), vec![0, 4, 7]);
    }

    #[test]
    fn keyboard_voicing_marks_root_and_covers_tones() {
        let v = synth_keyboard_voicing("Cmaj9").unwrap();
        assert_eq!(v.root_key % 12, 0); // root is C
        let pcs: Vec<u8> = {
            let mut p: Vec<u8> = v.keys.iter().map(|k| k % 12).collect();
            p.sort_unstable();
            p.dedup();
            p
        };
        assert_eq!(pcs, vec![0, 2, 4, 7, 11]); // C E G B D
    }

    #[test]
    fn unparseable_chord_returns_none() {
        assert!(synth_fretted_voicing("not-a-chord", "guitar", 5).is_none());
        assert!(synth_keyboard_voicing("not-a-chord").is_none());
    }
}
