# 0023. `{capo}` directive transposes displayed chords

- **Status**: Accepted
- **Date**: 2026-05-24

## Context

The `{capo: N}` ChordPro directive has historically been treated as a printed
annotation only: every renderer in this codebase (text, HTML, PDF, React JSX
walker) emitted the directive as song metadata but left the chord lines
unchanged. That matches the literal ChordPro spec — `{capo}` is described as
metadata the renderer may surface to the player — but it does not match what
guitarists actually expect when they reach for the capo control.

A guitarist who sets `{capo: 2}` while *keeping the sounding pitch* of the
song wants to see the **chord shapes they need to hold while a capo on fret 2
keeps the song at its original pitch**. That is the chord names transposed
down by two semitones, not the same names the song was written in. Tools the
community already uses (Ultimate Guitar's capo selector, Songbook Chords' capo
button, the `chordpro --transpose` pipeline configured behind a "capo" UI in
several editors) implement this user-facing semantic — ChordSketch's literal
reading is the outlier.

The disagreement surfaced in #2560 with a slider-UI proposal: the slider only
makes sense if dragging it changes what the user sees. A pure-metadata
directive that left the chord lines untouched would have a slider whose
visible effect was a single integer changing in a corner of the page.

The Rust transposition pipeline already has every primitive needed to
implement the new semantic: `transpose_chord_with_style`,
`canonical_transposed_key_with_style`, and `transposed_key_prefers_flat` (in
`crates/chordpro/src/transpose.rs`) compose the existing `{transpose}`
directive and the `--transpose` CLI flag into a single offset that drives the
chord-line walk. The React surface consumes the same offset through
`@chordsketch/react`'s `chordpro-jsx` walker per ADR-0017.

## Decision

`{capo: N}` transposes every rendered chord name by `-N` semitones across all
four ChordSketch rendering surfaces:

1. `chordsketch-render-text`
2. `chordsketch-render-html`
3. `chordsketch-render-pdf`
4. `@chordsketch/react`'s `chordpro-jsx` walker

The directive itself stays in the AST — only the chord-line content
shifts. Whether a given renderer surfaces `{capo}` as a visible annotation
(text renderer: not surfaced; HTML / PDF / React walker: surfaced as
metadata when present) is unchanged from the pre-2560 baseline. The shift
composes with the existing `{transpose}` directive and CLI / API transpose
parameters: the final offset applied to chord names is

```
effective = file_transpose + cli_transpose - capo
```

implemented as a single helper `effective_transpose(file_offset, cli_offset,
capo)` in `chordsketch_chordpro::transpose` that every renderer routes through
(per `.claude/rules/fix-propagation.md` — one source of truth, no
parallel rules in each renderer). Saturation behaviour mirrors
`combine_transpose`'s existing contract (`i16` arithmetic, clamp to `i8`,
return a `(value, saturated)` tuple).

Spelling continues to follow the existing canonical pipeline:
`transposed_key_prefers_flat` chooses the flat/sharp side of the circle of
fifths for the resulting key, so `{capo: 2}` on a song in C produces `Bb` /
`Eb` / `F` (not `A#` / `D#` / `F`).

This is a deliberate breaking change for CLI / FFI / NAPI / PDF consumers that
were depending on the old "capo is a printed annotation only" behaviour. No
opt-in flag is introduced: the new semantic IS the contract going forward,
and consumers that need the pre-2560 behaviour can omit the `{capo}` directive
or strip it before rendering.

## Rationale

- **User expectation aligned with every adjacent tool.** Treating `{capo: N}`
  as a printed annotation only was the literal spec reading but the outlier
  in practice. Guitarists working from a chord sheet expect the chord names
  to be the ones they hold; a directive that quietly does nothing visible
  fails that expectation silently.
- **The slider UI in #2560 demands the new semantic.** A capo slider whose
  movement does not change the rendered chords is not a feature — it is an
  integer editor with a misleading name. The slider and the semantic land
  together so the UI does what it claims to do.
- **One source of truth across four renderers.** Putting the
  `file + cli - capo` arithmetic in `chordsketch_chordpro::transpose` (a
  zero-dependency core crate every renderer already depends on) means the
  rule cannot drift between surfaces. `.claude/rules/fix-propagation.md`
  documents the cost of letting each renderer implement the same rule
  independently; the helper avoids that cost up front.
- **The `{capo}` directive stays in the AST.** Whether each renderer emits a
  visible capo annotation is unchanged from the pre-2560 baseline (text:
  not surfaced; HTML / PDF / React walker: surfaced when present). Tools
  that strip the directive before re-emitting ChordPro keep working. Only
  chord-line content changes.
- **No opt-in flag.** Adding `RenderOptions.capo_transposes_chords: bool` and
  defaulting it to `false` for non-React surfaces was considered (the
  `#2560` issue body proposed exactly this shape). It was rejected because:
  the codebase ships every renderer to consumers that benefit equally from
  guitar-correct output (the CLI `--format pdf` is exactly the path a player
  prints from before a rehearsal), and a permanent two-mode renderer is a
  fix-propagation hazard — every future capo-related fix would need to be
  thought through in both modes. A single, breaking change is cheaper to
  audit than a permanent fork in semantics.

## Consequences

### Positive

- Slider UI in #2560 ships with the matching renderer semantic; users see
  what they hold.
- Single helper `effective_transpose` removes the temptation to inline the
  same arithmetic at four renderer call sites.
- React JSX walker, text, HTML, and PDF outputs now agree byte-for-byte on
  what `{capo: N}` means.

### Negative (with mitigations)

- **Breaking change for CLI / FFI / NAPI / PDF consumers.** Any tool that
  was relying on `{capo}` being a no-op for rendered chord names will see
  output shift. Mitigation: the CHANGELOG entry for the release that lands
  this ADR calls out the change explicitly; downstream consumers who need
  the old shape can strip the directive before rendering. The render-time
  arithmetic is exposed via the `effective_transpose` helper so a consumer
  who wants to opt-out can compute its own offset and pass `cli_transpose +
  capo` to recover the pre-change output.
- **Existing fixtures whose input contains `{capo: N}` change their
  expected output.** The `crates/render-*/tests/fixtures/metadata-header/`
  fixtures all use `{capo: 2}` and will have their snapshot baselines
  updated in the same PR that lands this ADR. The change is mechanical
  (every chord on every chord line shifts by `-2` semitones via the
  existing canonical-spelling pipeline).
- **VS Code and Tauri preview surfaces shift simultaneously.** Both
  consume `@chordsketch/react` per ADR-0022 — they pick up the new
  semantic automatically with no host-side change required.

## Alternatives considered

### Treat `{capo}` as parse-time transposition (rewrite the AST)

Have the parser apply `-capo` semitones to every chord line and drop the
`{capo}` directive from the AST. Renderers would then have nothing capo-
specific to do.

**Rejected** because the `{capo}` directive must remain in the AST so each
renderer can still emit it as a printed annotation. Parse-time rewriting
would conflate the printed-annotation responsibility with the chord-line
responsibility; render-time wiring keeps them orthogonal.

### Opt-in flag (`RenderOptions.capo_transposes_chords`)

The shape proposed in #2560's issue body: default `false` for non-React
renderers (preserve backwards compatibility), default `true` for the React
preview surface. Each renderer would carry both modes indefinitely.

**Rejected** for the reasons in §Rationale — permanent two-mode renderer is
a fix-propagation hazard, and the two consumer groups (the CLI exporting a
PDF for printing vs. the React component rendering on screen) want the same
guitar-correct output. A flag that no one wants to set to `false` is just
two code paths to maintain.

### Sliding renderer scope: implement in React only, defer Rust

Land the React display rule + slider UI now, defer the Rust renderer changes
to a follow-up PR.

**Rejected** because `.claude/rules/renderer-parity.md` requires the four
surfaces to agree on directive semantics, and the deferred state would be a
documented, intentional violation of that rule. The renderer-parity rule
exists because the project has lost time before to "we'll fix the other
surface later" promises. The work is bundled into one PR.

## References

- Issue: [#2560](https://github.com/koedame/chordsketch/issues/2560) — Capo
  should transpose rendered chords (real-pitch preservation) + slider UI for
  Capo / Transpose.
- Renderer-parity rule: `.claude/rules/renderer-parity.md`.
- Fix-propagation rule: `.claude/rules/fix-propagation.md`.
- Sister-site demotion of `chordsketch-render-html` from canonical to static-
  output: [ADR-0017](0017-react-renders-from-ast.md).
- React surface unification across VS Code / Tauri / playground:
  [ADR-0022](0022-react-as-canonical-preview-surface.md).
- Transposition pipeline: `crates/chordpro/src/transpose.rs`
  (`transpose_chord_with_style`, `canonical_transposed_key_with_style`,
  `transposed_key_prefers_flat`, `combine_transpose`).
