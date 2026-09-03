# 0055. The docs Shiki theme is chosen for the surface the docs actually paint

- **Status**: Accepted
- **Date**: 2026-09-03

## Context

[ADR-0025](0025-build-time-syntax-highlighting-shiki.md) settled two
things that interact here. Shiki highlights the docs corpus at build
time, and a transformer strips the wrapper-level inline `style` Shiki
emits on `<pre>` (`SHIKI_PRE_KEEP_PROPERTIES` in
`packages/playground/scripts/lib/docs-render.mjs`) so that
`.docs-prose pre` in `docs.css` keeps control of background, padding and
radius. The theme therefore contributes **foreground colours only**; the
code surface is `--cs-ink-1000` `#0A0A0B`.

`github-dark` was the chosen theme. Its palette is designed against its
own `#24292E` background, and it paints comment tokens `#6A737D`. On
`#0A0A0B` that is **4.11:1**, under the 4.5:1 WCAG 2.2 SC 1.4.3 floor for
13px text. Every docs page carrying a code fence with a comment in it —
which is most of the recipe pages — lost its Lighthouse accessibility
score to that one token colour; `/chordsketch/docs/embed-vue/` measured
95 with `color-contrast` as the only failing audit.

Highlighting the whole 89-fence docs corpus and collecting every distinct
`color:` Shiki emits gives the per-theme picture against `#0A0A0B`:

| Theme | Theme's own background | Token colours below 4.5:1 | Lowest token colour |
|---|---|---|---|
| `github-dark` | `#24292E` (1.35:1 from ours) | 1 | `#6A737D` 4.11:1 |
| `github-dark-default` | `#0D1117` (1.05:1 from ours) | 0 | `#8B949E` 6.43:1 |
| `github-dark-dimmed` | `#22272E` (1.32:1) | 0 | `#768390` 5.11:1 |
| `one-dark-pro` | `#282C34` (1.41:1) | 0 | `#7F848E` 5.27:1 |
| `vitesse-dark` | `#121212` (1.06:1) | 1 | `#666666` 3.45:1 |

## Decision

`SHIKI_THEME` becomes **`github-dark-default`**.

The selection criterion is recorded with it: because the build strips the
theme's background, the theme must be one whose palette is designed for a
surface close to `--cs-ink-1000`, and every token colour it emits over
the docs corpus must clear 4.5:1 against that surface.

## Rationale

`github-dark-default` is GitHub's current dark palette (`github-dark` is
the legacy one), tuned for a `#0D1117` surface that is 1.05:1 from the
`#0A0A0B` the docs paint — near enough that the theme's own contrast
budget carries over intact rather than being borrowed from a lighter
surface it was never measured against. Its lowest token colour over the
corpus lands at 6.43:1, so the fix has margin rather than sitting on the
threshold.

It also preserves what ADR-0025 wanted from `github-dark` in the first
place: it is the same visual family readers know from GitHub's own code
rendering, so the on-page docs look does not change character.

Fixing the theme rather than the token keeps a single source for the code
palette. A `.docs-prose pre .shiki span[style*="#6A737D"]`-style override
would have to be re-derived by hand every time Shiki, the theme or the
grammar set changes, and it fixes one colour rather than the reason that
colour was wrong.

## Consequences

**Positive.**

- Every docs route reaches Lighthouse accessibility 100.
- The rule that picked the theme is written down, so the next theme
  change is a measurement rather than a preference.

**Negative, and what bounds it.**

- The `<pre>` class attribute changes from `shiki github-dark` to
  `shiki github-dark-default`. Nothing in the repo selects on it — the
  build keeps `class` only so the wrapper stays identifiable — but an
  external consumer styling the deployed docs HTML on that class would
  need to follow.
- Token colours shift across every code fence in the docs. The
  difference is confined to hue within the same dark-GitHub family; no
  layout, no markup, no build-gate change.
- The audit is a point-in-time measurement over the current corpus. A
  new fence language whose grammar introduces a token colour the audit
  never saw could reintroduce a sub-4.5:1 colour.
  `tests-e2e/accessibility.spec.ts` runs axe-core over the docs routes on
  every PR, so a regression fails CI rather than waiting to be noticed.

## Alternatives considered

**Override the comment colour in `docs.css`.** Smallest diff, but it
patches one symptom of "the theme was picked for a different surface" and
leaves the criterion unwritten, so the next theme or Shiki bump reopens
the same question with no record of it.

**Stop stripping the theme's background so `github-dark` paints its own
`#24292E`.** Makes the theme internally consistent, but `#6A737D` on
`#24292E` is 3.05:1 — still under the floor — and it hands the docs' code
surface to whichever theme is installed, which is the thing ADR-0025
deliberately took away.

**`github-dark-dimmed` / `one-dark-pro`.** Both clear the floor (5.11:1 /
5.27:1 lowest). Neither has margin comparable to `github-dark-default`'s
6.43:1, and `one-dark-pro` leaves the GitHub family that ADR-0025 chose
for reader familiarity.

**`vitesse-dark`.** Rejected on measurement: `#666666` at 3.45:1 across
1300 spans in the corpus is a worse failure than the one being fixed.

## References

- [ADR-0025](0025-build-time-syntax-highlighting-shiki.md) — build-time
  Shiki, the `<pre>` style-stripping transformer, and the original
  `github-dark` choice this ADR revises
- [ADR-0021](0021-docs-site-co-located-with-playground.md) — the docs
  site lives in the playground project
- [ADR-0054](0054-tertiary-ink-is-not-a-body-text-tone.md) — the same
  4.5:1 floor applied to the light-surface text ramp
- SC 1.4.3 Contrast (Minimum): https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum
- **Watch signal**: a light-mode docs toggle (left open by ADR-0025).
  A second surface means the criterion has to be met twice, which a
  single fixed theme cannot do — that story needs Shiki's dual-theme
  output, not another single-theme pick.
