# 0035. Spelled-out canonical `{key}` notation (`G major` / `G minor`)

- **Status**: Accepted
- **Date**: 2026-06-17
- **Supersedes**: the canonical-*form* choice of
  [ADR-0034](0034-lenient-key-input-canonical-render.md) (`Gm` / `G`). The
  lenient-input and canonical-render-on-every-surface decisions of ADR-0034
  are unchanged.

## Context

[ADR-0033](0033-canonical-key-directive-notation.md) unified key
interpretation behind a single parser and chose the compact `Gm` / `G` as the
canonical notation; [ADR-0034](0034-lenient-key-input-canonical-render.md) kept
that canonical form but made the *input* lenient (accept `G minor`, `G m`,
`Gminor`, `G major`, …) and render the canonical form on every surface while
leaving the editor source untouched.

The compact form has one readability wart: the bare major key renders as a
lone letter (`G`), and the minor marker is a single trailing `m` (`Gm`) — terse
for a rendered key *label*, and visually inconsistent with the modal form,
which was already spelled out (`C dorian`). A key label is a piece of
display chrome a reader scans, not a chord symbol packed into a chord line, so
the spelled-out form reads more clearly: `G major` / `G minor` parallels
`C dorian` and removes the "is that a lone `G` a key or a stray chord?"
ambiguity.

The ChordPro `{key}` grammar is not pinned by the spec, so the canonical
*rendered* form is a project decision (ADR-0033 §Context). This ADR revisits
only that rendered-form decision; everything else ADR-0033 / ADR-0034
established stays.

## Decision

Make the **canonical rendered** `{key}` notation the **spelled-out** form:

- major → `G major` (was `G`)
- minor → `G minor` (was `Gm`)
- modal → `C dorian` (unchanged — already spelled out)
- slash-bass → the quality word precedes the slash: `G major/B`, `A minor/C`

Input stays **lenient** exactly as ADR-0034 defined it — every spelling
ADR-0034 accepts (`Gm`, `G m`, `Gminor`, `G min`, `Gmi`, `G-`, `G`, `Gmaj`,
`G maj`, `G major`, `CM`, the church modes, slash-bass) still parses; only the
*output* of `Key`'s `Display` changes. The editor textarea is still untouched:
only the rendered marker is canonical.

`chordsketch_chordpro::key::quality_word(is_minor)` is the single source of
truth for the spelled-out suffix (`" minor"` / `" major"`). `Key`'s `Display`
and the two transpose-path key-string builders
(`transposed_key_display_string`, `canonical_key_string` in
`crate::transpose`) all route through it, so the zero-transpose path and the
transposed path agree (`G minor` static, `A minor` at +2) and a modal key never
gains a spurious ` major` (the mode word, carried in the chord-detail
`extension`, wins over the quality word).

Every surface follows: the three Rust renderers' inline `{key:}` marker (via
`canonical_key_for_display`), the wasm AST canonicalisation
(`canonicalize_key_directives` + the transposed-key map, now keyed by the
canonicalised value `G major`), and the React JSX walker (which receives the
canonical string from the wasm AST and renders it through the
`KeySignatureButton` / `KeySignatureGlyph`). The key-signature glyph's
`aria-label` reads the spelled-out string too (`Key Bb major (2 flats)`).

## Rationale

- **Parallel with the modal form.** `C dorian` was already spelled out;
  `G major` / `G minor` makes the three quality classes (major / minor / modal)
  visually consistent rather than mixing a lone letter, a trailing `m`, and a
  spelled-out mode.
- **A key label is chrome, not a chord.** The rendered `{key}` marker is a
  reader-facing label (it sits in the metadata header / inline marker, not in a
  chord line), so the brevity argument that favours `Gm` for chord symbols does
  not apply; clarity wins.
- **One source of truth keeps the surfaces in lockstep.** Routing every Rust
  key-string builder through `key::quality_word`, and letting the React walker
  consume the wasm-canonicalised AST, means the spelled-out form lands on all
  four surfaces from one decision — the ADR-0033/0034 consistency guarantee is
  preserved.
- **No behaviour reversal for input.** Because only the rendered form changed,
  no input that ADR-0034 accepted is now rejected; the change is contained to
  `Display`.

## Consequences

- **Positive.** The rendered key reads `G major` / `A minor` consistently
  across text / HTML / PDF / React, including the glyph `aria-label`; the form
  is parallel with `C dorian`; the editor source is still preserved; lenient
  input is unchanged.
- **Negative — snapshot / test churn.** Every golden snapshot and unit test
  that asserted the compact key marker (`[Key: Gm]`, `<span …>G</span>`,
  `"key":"Gm"`, the transposed-key map keys) was updated to the spelled-out
  form (a deliberate spec change, per `.claude/rules/root-cause-fixes.md`). The
  wasm transposed-key directive map is now keyed by the canonicalised value
  (`G major`) rather than the raw authored value.
- **Neutral — the validation warning suggestion text** now names `G minor` /
  `G major` / `G dorian` as the canonical alternatives instead of `Gm` / `G`.

## Alternatives considered

- **Keep the compact `Gm` / `G` (ADR-0034 status quo).** Rejected: the
  maintainer judged the spelled-out form clearer and more consistent with the
  already-spelled-out modal form.
- **Spell out only the standalone marker, keep `Gm` in the transposed-key
  map / AST value.** Rejected: it reintroduces exactly the cross-surface
  divergence ADR-0033 eliminated — the displayed marker and the AST value would
  disagree, and the map lookup key would not match the canonical directive
  value. One canonical form everywhere is the whole point.
- **Use `G maj` / `G min` (abbreviated words).** Rejected: half-way between the
  two forms, less readable than the full word, and not obviously more canonical
  than the spec's accepted `maj` / `min` input aliases.

## References

- Issue #2678 — this change.
- [ADR-0034](0034-lenient-key-input-canonical-render.md) — lenient input /
  canonical render; its canonical-form choice (`Gm`) is what this ADR
  supersedes (its input policy is unchanged).
- [ADR-0033](0033-canonical-key-directive-notation.md) — the single-parser
  consistency guarantee this ADR preserves.
- `crates/chordpro/src/key.rs` (`quality_word`, `Key` `Display`),
  `crates/chordpro/src/transpose.rs` (`canonical_key_for_display` and the
  key-string builders), `crates/wasm/src/lib.rs`
  (`canonicalize_key_directives`), `packages/react/src/key-signature-button.tsx`
  / `music-glyphs.tsx` (the React render surface).
