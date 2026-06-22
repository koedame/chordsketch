# Chord Diagram Coverage

Every chord type a user can produce from the ChordPro editor's **chord-type
controls** MUST render a valid chord diagram on every supported instrument.
Diagram coverage of the producible set is **100%, and stays at 100%** as the
controls evolve. A chord type the controls can produce but that yields "no
diagram available" on any instrument is a coverage defect.

## What the producible set is

Per [ADR-0037](../../docs/adr/0037-explicit-chord-extension-notation.md), the
editor's chord-type controls are three orthogonal groups in
`packages/react/src/chord-source-edit.ts` — triad quality, seventh, and
tensions — rendered by `<ChordInspector>`. Their composition
(`composeChordSuffix`) only ever yields an explicit, unambiguous suffix.

The **producible set** is `enumerateEditorSuffixes()` in the same file: a
representative-complete enumeration of every (triad × seventh) base, every base
plus a single tension, and the natural full stacks. The availability rules
(`isSeventhAvailable` / `isTensionAvailable`) bound this set so every member is
voiceable — see "Inherent unvoiceability" below.

The supported instruments are the ones
`chordsketch_chordpro::voicings::lookup_diagram` /
`lookup_keyboard_voicing` dispatch to: **guitar, ukulele, charango**
(fretted) and **keyboard/piano**.

## Inherent unvoiceability

A chord that needs more **essential** tones than an instrument has strings is
unplayable as a matter of physics, not a synthesiser gap — you cannot put five
required notes on a four-string ukulele. The editor's availability rules
therefore restrict tensions to major/minor triads and forbid the combinations
that would exceed four essential tones (dim/aug carry their characteristic
fifth, the power chord is two-note, sus tensions are degenerate, the
minor-major-7 is a plain seventh form). This keeps the producible set fully
voiceable. Multi-altered combinations *beyond* the representative enumeration
that a determined user reaches through the free-form field are covered
structurally by the synthesiser where playable, and fall back to "no diagram
for this instrument" where the essential-tone count genuinely exceeds the
string count.

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

When you change the editor's producible set — a new triad / seventh / tension
option, or a change to the `isSeventhAvailable` / `isTensionAvailable`
availability rules — in the **same PR**:

1. **Regenerate `PALETTE_SUFFIXES`** in `crates/chordpro/src/voicings.rs` from
   `enumerateEditorSuffixes()` (the sister list — see below).
2. **Confirm the parser models every new suffix.** `chord_tones("<root><suffix>")`
   must return the intended pitch classes. If a tension or alteration the
   interval logic in `chordsketch_chordpro::chord` does not yet handle is
   introduced, extend that logic (and its `chord_pitches` tests) so the
   diagram — and the audio path — is musically correct, rather than letting it
   degrade to a bare triad.
3. **Run the coverage tests** (below). They must stay green. A new combination
   that is not voiceable on a 4-string instrument must be excluded by the
   availability rules (not left to fail the coverage test) — see "Inherent
   unvoiceability".

## Sister lists

`enumerateEditorSuffixes()` (TypeScript, `packages/react/src/chord-source-edit.ts`)
and `PALETTE_SUFFIXES` (Rust, `crates/chordpro/src/voicings.rs`) are a
documented sister pair under [`fix-propagation.md`](fix-propagation.md). They
must hold the **same set** of suffixes. Each file's comment block points at the
other.

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
  `enumerateEditorSuffixes()` equals `PALETTE_SUFFIXES` exactly — every
  producible suffix is covered, and no stale Rust entry survives that the
  editor can no longer produce — catching the drift where one side changes
  alone.

A PR that makes the editor produce a suffix without the matching Rust coverage
entry fails the TypeScript guard; a suffix the parser models incorrectly, or a
producible combination that is unvoiceable, fails the Rust musical-correctness
assertions.

## Why

The chord-type palette is the user's menu of chords; a chip that silently
renders no diagram is a broken promise specific to the chord types a beginner
is most likely to be unfamiliar with (exactly the chords a diagram helps most).
Before this rule, the curated tables covered only five guitar families, so the
majority of the palette's chips had no diagram. Tying coverage to algorithmic
synthesis — and gating palette changes on the sister-list + coverage tests —
makes "every selectable chord type has a diagram" an invariant the test suite
keeps true, rather than a property that decays every time the palette grows.
