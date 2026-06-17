# 0034. Lenient `{key}` input, canonical render

- **Status**: Accepted
- **Date**: 2026-06-17
- **Supersedes**: the strict-input clause of
  [ADR-0033](0033-canonical-key-directive-notation.md)

## Context

[ADR-0033](0033-canonical-key-directive-notation.md) made the `{key}`
directive parser **strict**: it accepted only `Gm` (with the spec aliases
`mi` / `min` / `-`), the church modes, and slash-bass, and **rejected** the
common human spellings `{key: G minor}`, `{key: G m}`, `{key: Gminor}`,
`{key: G min}`, `{key: G major}` — emitting a validation warning and rendering
them verbatim and untransposed.

That decision standardised the *canonical* notation (`Gm`) and, crucially,
unified the key's major/minor/modal classification behind a single parser so
the transpose spelling, the key-signature glyph, the scale/tonic audition, and
the displayed text could no longer disagree. The remaining question — flagged
by the maintainer after ADR-0033 shipped — was the *input* policy: erroring on
`G minor` is harsh, because it is a perfectly reasonable thing for a person to
type, and the intent is unambiguous.

The ChordPro `{key}` directive grammar is not pinned by the spec (only the
example `{key: C}` is given), so the input policy is a project decision.

## Decision

Keep `Gm` / `G` / `C dorian` as the **canonical rendered** notation, but make
the **input lenient**:

- `chordsketch_chordpro::parse_key` accepts the common human key spellings and
  normalises them. The quality qualifier is matched case-insensitively and
  tolerates a single internal space:
  - minor ← `m` / `mi` / `min` / `minor` / `-`
  - major ← *(empty)* / `maj` / `major`
  - modal ← one of the seven church modes
  So `G minor`, `G m`, `Gminor`, `G min`, `Gmi`, `G-` all parse as G minor and
  canonicalise to `Gm`; `G major` / `Gmajor` / `G maj` canonicalise to `G`;
  `C Dorian` to `C dorian`.
- A chord extension on a key (`G7`, `Gm7`, `Cmaj7`, `Gsus4`) is **not** a key —
  a key is a tonal centre, not a chord — and neither is a non-note root (`H`).
  Those remain unrecognised.
- **Every render surface displays the canonical form**, including at a zero
  transpose: text / HTML / PDF route their inline `{key:}` marker through
  `transpose::canonical_key_for_display`, and the React surface renders from an
  AST whose `{key}` directive values were canonicalised at the wasm boundary
  (`canonicalize_key_directives`). The **editor textarea source is
  untouched** — only what is rendered is canonical.
- The render-boundary validation warning (`validate_keys`) is **kept but
  auto-relaxes**: it no longer fires for the now-accepted spellings, only for
  values `parse_key` cannot recognise as a key (`G7`, `H`, garbage), which keep
  rendering verbatim.

## Rationale

- **"Liberal in what you accept, strict in what you emit."** The editor should
  not punish a writer for `G minor`; the renderer should still present one
  consistent notation. Lenient-input / canonical-output delivers both.
- **The cross-subsystem consistency win from ADR-0033 is preserved.** Because
  the lenient spellings normalise to the same `Key`, the glyph, audio,
  transpose, and displayed text still agree — `{key: G minor}` is minor
  everywhere, now *and* without an error.
- **Extensions stay out.** Distinguishing `Gmin7` (would need a chord-extension
  validator) from `Gminor` is avoided entirely by keeping "a key is not a
  chord": no extensions, so `G7` is simply not a key. This keeps the grammar
  small while accepting every reasonable *key* spelling.
- **A warning is still useful for genuine non-keys.** Keeping `validate_keys`
  (auto-relaxed) means a typo like `{key: Gxyz}` or a misuse like `{key: G7}`
  still tells the user it wasn't understood, without nagging about ordinary
  key spellings.

## Consequences

- **Positive.** `{key: G minor}` and friends just work; the rendered key is
  always canonical and identical across the four surfaces; the editor preserves
  the author's text. The ADR-0033 consistency guarantee is retained.
- **Negative — behaviour reversal vs. ADR-0033.** Inputs ADR-0033 rejected are
  now accepted and normalised. The tests that asserted the strict rejection
  were updated to the lenient contract (the decision changed deliberately, per
  `.claude/rules/root-cause-fixes.md`). The React AST emitted by wasm now
  carries the *canonical* `{key}` value rather than the verbatim source — this
  is intentional (the AST is the render input; the editor holds the source) and
  contained to the wasm → JSX-walker path.
- **Modal keys** continue to render `C dorian`; `canonical_transposed_key`
  (the bare-label header variant) still returns `None` for modes so the header
  falls back to the authored value rather than a bare major label.

## Alternatives considered

- **Keep ADR-0033's strict rejection.** Rejected: the maintainer judged
  erroring on `G minor` too harsh for an unambiguous, common input.
- **Normalise at parse time (rewrite the AST/source).** Rejected: the formatter
  reconstructs ChordPro source from the AST, so normalising at parse would
  rewrite the user's editor text (`G minor` → `Gm`), contradicting "editor
  lenient." Normalisation is applied at the render boundary instead.
- **Drop the validation warning entirely.** Rejected: a soft warning for
  genuine non-keys (`G7`, `H`) is a cheap safety net with near-zero false
  positives now that real key spellings are accepted.
- **Also strip extensions (`G7` → `G`).** Rejected: silently discarding a
  user's `7` could change intent; leaving `G7` unrecognised (verbatim + warning)
  is more honest.

## References

- Issue #2674 — this change.
- [ADR-0033](0033-canonical-key-directive-notation.md) — the strict-input
  decision this supersedes (its canonical-form choice, `Gm`, is unchanged).
- `crates/chordpro/src/key.rs` (`parse_key`),
  `crates/chordpro/src/transpose.rs` (`canonical_key_for_display`),
  `crates/wasm/src/lib.rs` (`canonicalize_key_directives`),
  `packages/react/src/music-glyphs.tsx` (`keySignatureFor`).
