# 0033. Canonical `{key}` directive notation and a single strict key parser

- **Status**: Accepted
- **Date**: 2026-06-17

## Context

The ChordPro `{key}` directive value was interpreted by several
subsystems independently, each calling the deliberately *permissive*
chord parser (`chord::parse_chord`) or carrying its own ad-hoc grammar.
`parse_chord` accepts any string that starts with a note letter and
dumps the remainder into a chord's `extension` field, so the same
musical intent written four ways produced four different results
(issue #2665):

| Input | `parse_chord` quality (transpose / scale / audio) | `music_glyphs` key-signature lookup |
|---|---|---|
| `{key: Gm}` | Minor | Minor |
| `{key: G m}` | **Major** (extension `" m"`) | Minor (its regex allowed `\s*m`) |
| `{key: Gminor}` | Minor (extension `"or"` — garbage) | Minor |
| `{key: G minor}` | **Major** (extension `" minor"`) | Minor |

So `{key: G minor}` rendered a "G minor" label, drew a **minor**
key-signature glyph, yet auditioned a **G major** scale and chose the
flat/sharp side as if **major**. The divergence is a silent
correctness bug: which subsystem you looked at decided whether the key
was major or minor.

The ChordPro reference accepts the minor markers `m`, `mi`, `min`, and
`-` for chords, and does not permit spaces inside a chord name
([chordpro.org/chordpro/chordpro-chords](https://www.chordpro.org/chordpro/chordpro-chords/)).
The `{key}` page does not pin the value grammar further, so the Perl
reference's chord-name interpretation governs. Separately, this project
already supports *modal* keys (`{key: C dorian}`) across all four
rendering surfaces, and that behaviour must be preserved.

## Decision

Adopt **one** canonical `{key}` notation and route every key-consuming
subsystem through a **single strict parser**,
`chordsketch_chordpro::parse_key` (new `crates/chordpro/src/key.rs`).

A `{key}` value is well-formed iff it is one of:

1. **Tonal key** — a root note `A`–`G`, an optional accidental
   (`#` / `b`), an optional *attached* minor marker, and an optional
   `/bass`. The canonical minor marker is `m`; the spec aliases `mi`,
   `min`, and `-` are accepted and normalise to `m`.
2. **Modal key** — a root + optional accidental, a single space, and
   one of the seven church modes (`ionian`, `dorian`, `phrygian`,
   `lydian`, `mixolydian`, `aeolian`, `locrian`), case-insensitive.

Everything else is **invalid**: spelled-out qualities (`Gminor`,
`Gmajor`), a space before a non-mode word (`G m`, `G minor`,
`G major`), and chord extensions on a key (`G7`, `Cmaj7`) — a key is a
tonal centre, not a chord.

An invalid key is surfaced as a **validation warning** (the project's
existing render-boundary diagnostic channel, sister to `validate_capo`)
and degrades gracefully and identically across every surface: the value
is rendered verbatim and untransposed, with no key-signature glyph and
no scale / tonic-triad audition. This matches how the codebase reports
every other malformed directive value — there is no hard parse-failure
path for a single bad directive, and introducing one for `{key}` alone
would be inconsistent.

## Rationale

- **A single source of truth eliminates the divergence class.** With
  `parse_key` as the only path that decides a key's root / major-minor /
  modal classification, the transpose re-spelling, the key-signature
  glyph (Rust `music_glyphs` and the React `music-glyphs.tsx`
  sister-site), and the scale / tonic-triad audio (`key_scale_pitches`
  / `key_tonic_triad`) can no longer disagree.
- **The canonical form is the ChordPro chord-name form.** `Gm` is the
  spec's primary minor spelling; `mi` / `min` / `-` are spec aliases
  and so are accepted rather than rejected. Rejecting them would
  contradict the spec-as-primary-reference rule.
- **Rejecting spelled-out words and spaces is what makes the four user
  forms collapse to one.** `G m`, `Gminor`, and `G minor` are not
  spec-legal chord names; treating them as errors (not silently
  normalising them) is what the issue asked for — "decide one official
  notation, make the wrong ones errors."
- **Dropping extension-keys is the musically-correct simplification.**
  A key has no seventh or suspension; `{key: G7}` is meaningless as a
  key. Excluding extensions keeps the grammar small enough to reject
  `Gminor` (a `min` marker followed by junk) without building a full
  chord-extension validator.
- **A warning, not a hard error, fits the codebase.** `{capo}`,
  `{transpose}`, and strict-mode key-presence are all reported via the
  render-boundary `warnings` channel that the CLI, the bindings, and the
  React preview already surface. `{key}` validation joins them.

## Consequences

- **Positive.** All four subsystems agree on every accepted key.
  Malformed keys are reported instead of silently mis-classified. Modal
  and slash-bass keys keep working. The grammar lives in one tested
  place with sister-site parity enforced by tests on both the Rust and
  TypeScript glyph paths.
- **Negative — a small set of previously-"accepted" inputs change
  behaviour.** `{key: G7}` (and other extension-keys) and `{key: Bb
  minor}` (and other spelled-out / spaced forms) are no longer
  transposed; they render verbatim with a warning. Three existing tests
  that asserted the old lenient behaviour were updated to the new
  contract (the spec changed deliberately, per
  `.claude/rules/root-cause-fixes.md`). The mitigation is the warning
  itself: the user is told the canonical form rather than left guessing.
- **Modal keys now audition their parent colour.** A minor-third mode
  (dorian / phrygian / aeolian / locrian) auditions the natural-minor
  scale; the others audition major. Previously a modal key auditioned
  major unconditionally (a side effect of the permissive parse).

## Alternatives considered

- **Silently normalise the malformed forms to `Gm`.** Rejected: the
  issue explicitly asked for the wrong forms to be errors, and silent
  normalisation hides authoring mistakes (a typo'd `G mlnor` would still
  be guessed).
- **Keep extension-keys valid (`G7`, `Cmaj7`).** Rejected: it forces a
  full chord-extension validator to distinguish `Gmin7` (valid) from
  `Gminor` (junk), and a key with an extension is musically meaningless.
- **Make a malformed key a hard parse error.** Rejected: inconsistent
  with every other directive-value diagnostic in the codebase, which
  are render-boundary warnings with graceful degradation.
- **Fix each subsystem's grammar in place.** Rejected as a
  band-aid: four grammars would still drift. The root cause is the
  absence of a single key parser.

## References

- Issue #2665 — the originating bug report.
- `crates/chordpro/src/key.rs` — the strict parser.
- `crates/chordpro/src/render_result.rs` — `validate_keys`.
- `.claude/rules/renderer-parity.md`, `.claude/rules/fix-propagation.md`
  — the sister-site obligations this change satisfies (text / HTML /
  PDF renderers, the React JSX walker's `music-glyphs` glyph, and the
  wasm parse path).
- [ChordPro chord-name syntax](https://www.chordpro.org/chordpro/chordpro-chords/)
  — minor markers `m` / `mi` / `min` / `-`, no spaces in chord names.
