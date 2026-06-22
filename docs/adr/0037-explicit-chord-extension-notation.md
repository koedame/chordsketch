# 0037. Explicit chord-extension notation; reject ambiguous bare stacks

- **Status**: Accepted
- **Date**: 2026-06-22

## Context

A jazz chord symbol like `G13` is ambiguous. Tertian theory reads it as the
full stack `G B D F A C E` (root, 3, 5, ♭7, 9, 11, 13 — equivalent to
`G7(9,11,13)`); playing practice reads it as a dominant seventh with a 13th
added and the inner tensions omitted (`G7(13)` ≈ `G B D F E`). Both readings
are legitimate, which is precisely the problem: the same symbol denotes two
different chords depending on who reads it. The same ambiguity attaches to
`C9` / `C11` / `Cm13` / `Cmaj9` (the bare extended "stack"), and to a tension
written in bare parentheses with no seventh, `C(9)`, which reads as neither a
clean add-tone chord nor a dominant.

ChordSketch's chord editor (`<ChordInspector>`) previously offered these
ambiguous forms as first-class chips in a single flat chord-type palette
(`CHORD_TYPE_PRESETS`): `9`, `m9`, `maj9`, `11`, `m11`, `13`, `m13`. Picking
one wrote the bare stack into the source, baking the ambiguity into the user's
document.

We want the editor to produce only notation whose meaning is unambiguous,
while still reading the full ChordPro / Perl-reference vocabulary (the
[compatibility strategy](../../CLAUDE.md) makes full read compatibility a
project goal — refusing to parse `G13` would break existing songs).

## Decision

**ChordSketch adopts explicit chord-extension notation and does not produce
ambiguous bare stacks.**

1. **Canonical grammar.** A chord is
   `Root[Accidental] · TriadCore · SeventhCore · [ "(" tensions ")" ] · [ "/" Bass ]`.
   - Tensions render inside one parenthesis group, **comma-separated and
     ascending by scale degree**: `C7(9,11,13)`, `C7(b9,#11)`.
   - **Altered tones live inside the parentheses**, consistently:
     `C7(b9)`, `Cm7(b5)`, `C7(#5)` (not the concatenated `7b9` / `m7b5` /
     `7#5`).
   - A seventh-less single natural tension is an **add-tone chord**:
     `Cadd9` (never `C(9)`). The sixth chords stay `C6` / `Cm6` / `C69`.

2. **The editor's chord-type controls are three orthogonal groups**, replacing
   the flat palette:
   - **Triad quality** (single-select): major / minor / dim / aug, plus the
     third-replacement triads sus2 / sus4 and the power chord (5).
   - **Seventh** (single-select): none / `7` (dominant) / `maj7`. Because the
     seventh type is independent of the tension set, `maj7(13)` is reachable
     (pick maj7 + the 13 tension).
   - **Tensions** (multi-select): 6, 9, 11, 13, b9, #9, #11, b13, b5, #5.

3. **Ambiguous notation is still parsed, never auto-rewritten.** `G13`, `C9`,
   `C(9)` etc. keep parsing to the exact pitch classes they always did
   (`chord_tones` / `parse_chord` are unchanged). The render boundary emits a
   warning (`render_result::validate_ambiguous_chords`, sister to
   `validate_keys`) across every surface — text / HTML / PDF / React preview —
   naming the explicit spelling. `chord::suggest_canonical_chord` computes the
   suggestion: the **tone-preserving** explicit form (`G13` → `G7(9,11,13)`)
   plus, where it differs, the shorter dominant-7-plus-headline reading
   (`G7(13)`) or the add-tone reading (`C(9)` → `Cadd9`). The user's source is
   never modified; opening an ambiguous chord in the editor normalises it only
   when the user touches a control.

## Rationale

- **The ambiguity is real and load-bearing.** `G13` denoting two different
  pitch-class sets is not a stylistic nicety; it changes which notes sound.
  An editor that produces it is producing a document whose meaning depends on
  the reader. Explicit parenthesised notation is the standard lead-sheet
  device for resolving exactly this (Mark Levine, *The Jazz Theory Book*, uses
  parenthesised tensions for added-but-not-stacked tones).
- **The interval engine already supported the explicit form for free.**
  `chord_intervals` matches tension tokens as substrings and treats an explicit
  `7` as "not a full stack", so `C7(13)` already computed root-3-5-♭7-13 (no
  implied 9/11) before this ADR — the parentheses are inert characters to the
  tone logic. The work was notation classification + warning plumbing + the
  editor, not the tone model. Verified by `suggested_canonical_form_preserves_tones`.
- **Orthogonal controls model the harmony correctly.** Dominant-7 and major-7
  are mutually exclusive (a single-select group); the tension set is a
  separate axis. This makes `maj7(13)` a two-click composition rather than a
  special-case chip, and makes "add a 7th to this minor triad" mean exactly
  that (`Am` + 7 → `Am7`, not `A7`).
- **Reading stays compatible.** Keeping `parse_chord` lenient and warning at
  the render boundary preserves the project's full-read-compatibility goal
  while still steering authored documents toward unambiguous notation.

## Consequences

### Positive

- Every chord the editor writes has exactly one meaning.
- `maj7(13)`, `7(b9,#11)`, and similar precise voicings are reachable from the
  UI for the first time.
- A song imported with ambiguous notation renders identically but tells the
  user how to disambiguate, on every surface, with one message shape.

### Negative / trade-offs

- **The producible chord set is bounded to keep every chord voiceable.**
  Tensions are offered only on major/minor triads; dim/aug carry their
  characteristic fifth (the augmented-dominant colour is reached via maj/min +
  ♯5), the power chord is two-note, sus-chord tensions are degenerate, and the
  exotic minor-major-7 is a plain seventh form. The reason is partly musical
  (these stacks are non-idiomatic) and partly physical: a dim/aug triad or an
  altered-fifth chord already spends an essential-tone slot on its fifth, so a
  deep stack on top would demand more essential tones than a 4-string ukulele
  has strings — genuinely unplayable, not a synthesiser gap. The bounded set is
  61 suffixes, each proven to yield a playable diagram on guitar / ukulele /
  charango / keyboard for all twelve roots
  (`palette_chord_types_have_*_diagrams_for_every_root`).
  *Mitigation:* the free-form Quality / ext. field still accepts any suffix
  (e.g. `7sus4(9)`, `7alt`), and the parser still reads it; only the one-click
  controls are bounded.
- **Two equivalent spellings now coexist in the wild** (`7b9` and `7(b9)`).
  *Mitigation:* both parse to identical tones; the editor normalises the
  concatenated form to the parenthesised one when the chord is edited, and the
  concatenated form is unambiguous so it does **not** warn.
- **The chord-diagram coverage sister list moved from a hand-curated palette
  to a generated set.** `enumerateEditorSuffixes()` (TS) must equal
  `PALETTE_SUFFIXES` (Rust); `chord-type-coverage.test.ts` asserts the
  equality. Multi-altered tension combinations beyond the representative
  enumeration are covered structurally by the algorithmic voicing synthesiser,
  per [`chord-diagram-coverage.md`](../../.claude/rules/chord-diagram-coverage.md).

## Alternatives considered

- **Keep `G13` and define it as one of the two readings.** Rejected: whichever
  reading we pick, half of users read the symbol the other way, so the document
  still does not say what it means to its reader. The ambiguity is intrinsic to
  the glyph.
- **Auto-rewrite ambiguous notation on parse.** Rejected: it would mutate the
  user's source behind their back and break round-trip fidelity with other
  ChordPro tools. The warning-plus-suggestion path informs without mutating.
- **Stacked single-tension parens, `C7(9)(11)(13)`.** Rejected in favour of the
  comma-separated `C7(9,11,13)`, which is the standard lead-sheet convention
  and shorter.
- **Keep concatenated altered tones (`7b9`, `m7b5`) as the canonical form.**
  Rejected for consistency: once tensions live in parentheses, having
  alterations sometimes inside and sometimes attached is a second rule to
  remember. Parsing the concatenated form is retained for compatibility.
- **A single flat palette with a curated explicit set.** Rejected: it cannot
  express the seventh-type × tension-set product (e.g. `maj7(13)` vs `7(13)`)
  without a combinatorial explosion of chips, which is what the orthogonal
  groups solve.

## References

- Issue #2705.
- `crates/chordpro/src/chord.rs` — `suggest_canonical_chord`, `ChordSuggestion`.
- `crates/chordpro/src/render_result.rs` — `validate_ambiguous_chords`.
- `packages/react/src/chord-source-edit.ts` — `composeChordSuffix`,
  `decomposeChordSuffix`, `isTensionAvailable`, `enumerateEditorSuffixes`.
- `packages/react/src/chord-inspector.tsx` — the triad / 7th / tension controls.
- [ADR-0033](0033-canonical-key-directive-notation.md) /
  [ADR-0034](0034-lenient-key-input-canonical-render.md) — the parallel
  "lenient input, canonical guidance, warn-not-rewrite" decision for `{key}`,
  whose `validate_keys` render-boundary diagnostic this ADR's
  `validate_ambiguous_chords` is a sister to.
- `.claude/rules/chord-diagram-coverage.md` — the coverage rule updated for the
  generated sister list and the inherent-unvoiceability scope.

### Watch signals

- If the voicing synthesiser ever gains multi-string-group or open-voiced
  shapes that make 5-essential-tone chords playable on 4-string instruments,
  revisit the tension-triad restriction (dim/aug and minor-major-7 could then
  carry tensions).
- If users frequently reach for `7sus4(9)`-style sus tensions through the
  free-form field, consider modelling sus tensions explicitly (with the
  degenerate-degree conflicts resolved) rather than leaving them free-form.
