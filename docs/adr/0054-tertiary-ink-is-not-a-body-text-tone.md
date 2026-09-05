# 0054. Tertiary ink is not a body-text tone

- **Status**: Accepted
- **Date**: 2026-09-03

## Context

`design-system/tokens.css` publishes a four-step light-mode text ramp:

| Alias | Ink | On `--surface` (#FFFFFF) | On `--canvas` (#FAFAF7) | On `--surface-hover` (#F6F4F7) |
|---|---|---|---|---|
| `--text-primary` | `--ink-1000` `#0A0A0B` | 19.79:1 | 18.92:1 | 18.10:1 |
| `--text-strong` | `--ink-700` `#44424A` | 9.89:1 | 9.46:1 | 9.04:1 |
| `--text-secondary` | `--ink-600` `#67646D` | 5.80:1 | 5.55:1 | 5.30:1 |
| `--text-tertiary` | `--ink-500` `#8A8790` | 3.53:1 | 3.38:1 | 3.23:1 |

WCAG 2.2 SC 1.4.3 (Contrast Minimum, AA) asks for 4.5:1 on text below
18.66px bold / 24px regular. Every one of the ramp's tertiary uses in the
playground is 10–16px copy, so the tone fails the criterion at every one
of them. Lighthouse scored `/chordsketch/chordpro/` at 91 and
`/chordsketch/irealpro/` at 95 with `color-contrast` failures naming
`#8A8790` on all three surfaces above.

`--ink-500` is also the tone the design system hands to things WCAG does
not hold to 4.5:1: the breadcrumb `/` separator, disabled controls
(1.4.3 exempts inactive components), the iReal Pro editor's cell borders
and the slider's major tick (non-text UI, 1.4.11, 3:1).

Two ways to close the gap were on the table, and #2834 / #2835 had
already taken the second one twice without recording why.

## Decision

`--ink-500` keeps the value `#8A8790`. It is a **non-text / large-text /
disabled tone**, not a body-text tone, and `--text-tertiary` inherits
that constraint.

Any site that paints text below 18.66px on a light surface uses
`--text-secondary` instead. `design-system/DESIGN.md` §4 states the
constraint so the ramp table is not read as four interchangeable text
tones.

## Rationale

**There is no lighter tone that both passes and reads as a separate
tier.** Walking the ink ramp's hue (`R = B − 6`, `G = B − 9`) toward
`--ink-600`, the lightest value clearing 4.5:1 on `--surface-hover` — the
darkest light surface tertiary text actually sits on, measured on the
rendered `/chordsketch/chordpro/` route — is `#726F78` at 4.51:1. That is
nine steps per channel away from `--ink-600` `#67646D` (5.30:1 on the
same surface). Darkening the token would buy AA by collapsing tier 4 into
tier 3, i.e. by keeping the name of a hierarchy step that no longer
renders as one.

**Both options produce the same pixels.** If tertiary text has to be
within nine channel steps of secondary, the rendered result of
"repoint the token" and "use `--text-secondary` at the failing sites" is
indistinguishable. What differs is only which artefact carries the truth,
so the tie goes to the one that keeps the token honest about what it is.

**The token's non-text uses are correct as they stand.** 3.53:1 / 3.38:1
clears the 3:1 floor 1.4.11 sets for non-text UI and 1.4.3 sets for large
text, and 1.4.3 exempts disabled controls outright. Darkening `--ink-500`
would sweep the breadcrumb separator, the `~` multi-chord separator, the
iReal Pro cell borders and the disabled-chip fill along with the text
fix, changing rendering for every external consumer of a token whose
names are a published contract (ADR-0038, constraint 1).

## Consequences

**Positive.**

- Every route under `/chordsketch/` reaches Lighthouse accessibility 100
  (measured before/after in the PR that landed this ADR).
- The four-step ramp keeps four visually distinct steps.
- External consumers of `tokens.css` see no value change.

**Negative, and what bounds it.**

- The constraint lives in prose, so a future author can still reach for
  `--text-tertiary` on 12px copy. `tests-e2e/accessibility.spec.ts` runs
  axe-core against every playground route on every PR, so the class fails
  CI rather than waiting for the next manual Lighthouse run.
- Sites outside the audited routes were not swept when this ADR landed,
  because Lighthouse could only measure what a playground route rendered.
  They have been swept since, each measured on rendered output rather than
  read off the source: the shipped stylesheets in #2838
  (`@chordsketch/react`'s song `{comment}` body, `.chordsketch-capo__hint`,
  the secondary attribution line; `@chordsketch/react-ui`'s
  `.song-card time` / `.setlist` labels / `::placeholder`), the static
  reference pages in #2840, and the CodeMirror bracket / comment syntax
  tones in #2841. The allowlist guards those PRs added
  (`tertiary-ink.test.ts` per package, `scripts/check-design-system-tertiary.py`
  for the reference pages) are what keep the set from growing back.
- `--text-tertiary` remains reachable under a name that reads like a text
  token. Renaming it is a breaking change to the published token contract
  (ADR-0038) and is deliberately not bundled with an accessibility fix.

## Alternatives considered

**Darken `--ink-500` to the AA floor (≈`#726F78`).** One line, fixes
every consumer at once, and is the shape `root-cause-fixes.md` normally
prefers. Rejected on the measurement above: at nine channel steps from
`--ink-600` the tier stops existing, and the change reaches non-text uses
that were never broken.

**Repoint `--text-tertiary` to `--ink-600`.** Passes everywhere and
leaves `--ink-500` free for non-text use, but makes `--text-tertiary` an
exact alias of `--text-secondary` — a token that silently does nothing,
which is worse to inherit than one with a documented constraint.

**Leave the tertiary sites and grant an exception.** 1.4.3 has no
exception for "de-emphasised" copy; only disabled controls and incidental
text are exempt. Not available.

## References

- SC 1.4.3 Contrast (Minimum): https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum
- SC 1.4.11 Non-text Contrast: https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast
- [ADR-0038](0038-single-sourced-design-tokens.md) — `tokens.css` is the
  authored source and its bare names are a published contract
- [ADR-0055](0055-docs-shiki-theme-matches-the-code-surface.md) — the
  same 4.5:1 floor applied to the docs code surface
- PRs #2834 / #2835 took this decision's shape at two sites without
  recording the rationale; this ADR is that record
- **Watch signal**: a dark-mode surface set. Every ratio here is measured
  against the light ramp; a dark surface inverts which tones are legible
  and the constraint would need restating rather than reusing.
