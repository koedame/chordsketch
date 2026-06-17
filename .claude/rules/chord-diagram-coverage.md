# Chord Diagram Coverage

Every chord type a user can pick from the ChordPro editor's **chord-type
palette** MUST render a valid chord diagram on every supported instrument.
Diagram coverage of the palette is **100%, and stays at 100%** as the palette
grows. A chord type that the palette offers but that produces "no diagram
available" on any instrument is a coverage defect.

## What the palette is

The palette is `CHORD_TYPE_PRESETS` in
`packages/react/src/chord-source-edit.ts` — the chips rendered by
`<ChordInspector>`'s "Type" group. Each chip's `text` field is the ChordPro
suffix written after the root (`""` for major, `"m7"`, `"7b9"`, `"sus4"`, …).

The supported instruments are the ones
`chordsketch_chordpro::voicings::lookup_diagram` /
`lookup_keyboard_voicing` dispatch to: **guitar, ukulele, charango**
(fretted) and **keyboard/piano**.

## Why coverage is structural, not per-type data

Coverage is guaranteed by **algorithmic voicing synthesis**, not by a
hand-authored voicing per chord type. `lookup_diagram` /
`lookup_keyboard_voicing` consult, in order:

1. song `{define}` directives,
2. the curated built-in tables (`crates/chordpro/src/voicings.rs`),
3. **`crates/chordpro/src/voicing_synth.rs`**, which searches the fretboard
   (or lays out keyboard keys) from the chord's pitch-class content
   (`chordsketch_chordpro::chord::chord_tones`).

Because step 3 is driven by the chord's tones — not a per-type table — any
chord the parser can model automatically gets a diagram. This is the
root-cause mechanism that keeps coverage at 100% with **zero per-type data to
maintain**: a new chord type needs no new voicing data, only a parser that
understands its suffix.

### Synthesised shapes must be playable

The synthesiser does not just cover the chord tones — it rejects shapes a hand
cannot fret. A guitar / ukulele / charango voicing is constrained to **at most
four fingers** (`MAX_FINGERS`, with an index-barre at the lowest fret counted
as one finger) within a **four-fret window** (`SPAN` = 3 fret rows beyond the
anchor, i.e. a highest-minus-lowest fretted span of at most 3). Dense chords therefore
drop the droppable tones (the fifth, inner tensions) the way a player does,
rather than synthesising an unfrettable five- or six-finger stack. The
essential tones (root, third / `sus`, seventh, the headline tension, any
altered fifth, the bass) are always kept — see
`chordsketch_chordpro::chord::ChordTones`.

## The rule

When you add (or change) a chip in `CHORD_TYPE_PRESETS`, in the **same PR**:

1. **Add its suffix to `PALETTE_SUFFIXES`** in
   `crates/chordpro/src/voicings.rs` (the sister list — see below).
2. **Confirm the parser models the suffix.** `chord_tones("<root><suffix>")`
   must return the intended pitch classes. If the suffix introduces a tension
   or alteration the interval logic in `chordsketch_chordpro::chord` does not
   yet handle, extend that logic (and its `chord_pitches` tests) so the
   diagram — and the audio path — is musically correct, rather than letting it
   degrade to a bare triad.
3. **Run the coverage tests** (below). They must stay green.

Removing a chip is the reverse: drop the suffix from both lists in the same
PR.

## Sister lists

`CHORD_TYPE_PRESETS[*].text` (TypeScript) and `PALETTE_SUFFIXES`
(Rust, `crates/chordpro/src/voicings.rs`) are a documented sister pair under
[`fix-propagation.md`](fix-propagation.md). They must hold the same set of
suffixes. Each file's comment block points at the other.

## Enforcement

- **Rust** (`crates/chordpro/src/voicings.rs` tests):
  - `palette_chord_types_have_fretted_diagrams_for_every_root` — every
    `PALETTE_SUFFIXES` suffix × 12 roots yields a guitar / ukulele / charango
    diagram. Synthesised diagrams are additionally asserted to sound only
    chord tones, contain every essential tone, and sound the bass. (Curated
    entries may use rootless / reduced voicings, so they are required only to
    exist.)
  - `palette_chord_types_have_keyboard_diagrams_for_every_root` — the same for
    keyboard.
  - `crates/chordpro/src/voicing_synth.rs` carries the synthesiser's own
    musical-correctness unit tests.
- **TypeScript** (`packages/react/tests/chord-type-coverage.test.ts`): asserts
  every palette chip's `text` appears in `PALETTE_SUFFIXES`, and that
  `PALETTE_SUFFIXES` has no stale entry the palette dropped — catching the
  drift where a chip is added on one side only.

A PR that adds a palette chip without the matching Rust suffix fails the
TypeScript guard; a suffix the parser models incorrectly fails the Rust
musical-correctness assertions.

## Why

The chord-type palette is the user's menu of chords; a chip that silently
renders no diagram is a broken promise specific to the chord types a beginner
is most likely to be unfamiliar with (exactly the chords a diagram helps most).
Before this rule, the curated tables covered only five guitar families, so the
majority of the palette's chips had no diagram. Tying coverage to algorithmic
synthesis — and gating palette changes on the sister-list + coverage tests —
makes "every selectable chord type has a diagram" an invariant the test suite
keeps true, rather than a property that decays every time the palette grows.
