# 0021. Docs site is co-located with the playground (option a)

- **Status**: Accepted
- **Date**: 2026-05-19

## Context

[#2506](https://github.com/koedame/chordsketch/issues/2506) calls
for an ai-sdk.dev-style documentation site at
`chordsketch.koeda.me/docs` that hosts the embedding recipes and
per-component API reference for `@chordsketch/react`. §4 of the
parent tracking issue [#2473](https://github.com/koedame/chordsketch/issues/2473)
deferred this work explicitly so the host selection could land its
own decision record.

The issue identifies three candidate hosts:

- **(a) Extend the playground's Vite project with MDX/Markdown
  routes** under `/docs/*`. Same domain, same Vite project, same
  GitHub Pages deployment, same build pipeline.
- **(b) Separate `docs.chordsketch.koeda.me` subdomain** with its
  own Vite or Astro project, deployed to the same Pages site.
- **(c) Purpose-built static-site generator** (Docusaurus,
  VitePress, Astro Starlight) at a third subdomain or path,
  bringing built-in search, sidebar nav, and per-version routing.

The playground at `packages/playground/` is a Vite multi-page app
with three entry HTML files (`landing` / `chordpro` / `irealpro`).
It deploys to GitHub Pages via
`.github/workflows/deploy-playground.yml`, with a sibling
`playground-smoke.yml` running Playwright against the production
build on every PR. The 10 embedding recipes already exist as plain
Markdown at `docs/sdk/tasks/embed-react.md`.

The project's `.claude/rules/playground-is-a-sample.md` rule treats
the playground as a sample consumer of the libraries, with an
explicit carve-out for "Toolbar layout, status footer, visual
styling that is part of the playground's UI shell rather than the
library output." Docs site framing is the same class of concern:
chrome around the libraries, not library functionality itself.

## Decision

Host the docs site inside the existing playground Vite project as a
fourth multi-page entry at `/chordsketch/docs/` (option (a)).

The docs site is implemented as a small React SPA that renders the
canonical Markdown sources in `docs/sdk/` plus per-component API
reference pages authored alongside it. Markdown is parsed with
`marked` (zero-dep, ~30 KB minified). Code blocks render through
`marked`'s default HTML output styled by the playground's
design-system tokens; no separate syntax-highlight bundle is
shipped.

The canonical Markdown copies under `docs/sdk/tasks/` remain the
source of truth — the docs site reads from them directly via
Vite's `?raw` import, so a future GitHub viewer and the docs site
render the same file.

## Rationale

The Vite project already ships the wasm bundle, the design-system
tokens, the GitHub Pages workflow, the Playwright smoke harness,
and the SHA-pinned CI actions. Option (a) reuses every one of
those without duplication. Option (c) adds a second build pipeline
plus a second smoke surface plus a second set of dependency
upgrades; the benefit (built-in search, sidebar nav) is
deliverable inside option (a) with ~200 LOC of React.

The project does not yet need per-version docs routing — the
React component library is at v0.2.0 and the rest of the SDK is
pre-1.0 — so the headline feature of Docusaurus / VitePress is
not load-bearing today. When per-version docs become valuable, the
docs site can move to option (c) without breaking external links:
`/chordsketch/docs/embed-react/` stays the canonical URL through
a redirect rule in `index.html`.

`@chordsketch/react`'s components are not consumed inside the docs
pages themselves — the docs render Markdown, not live React
samples. The playground at `/chordsketch/chordpro/` and
`/chordsketch/irealpro/` is the live-sample surface. Keeping the
two concerns separate (read-only docs vs. interactive playground)
matches the ai-sdk.dev reference, which uses prose pages with
copy-paste recipes plus a separate "Playground" tab.

Authoring overhead matches the existing flow: contributors edit
Markdown under `docs/sdk/` and the docs site picks it up on the
next build. The per-component API reference pages live alongside
the recipes under `docs/sdk/reference/` so they share the same
edit-and-deploy loop. There is no separate site source tree to
keep in lockstep with the package surface.

## Consequences

**Positive.**

- Zero new CI workflows; `deploy-playground.yml` and
  `playground-smoke.yml` cover the docs site automatically.
- The same wasm runtime, design-system tokens, and Vite alias
  configuration apply uniformly across landing / chordpro /
  irealpro / docs.
- Canonical Markdown under `docs/sdk/` stays the source of truth —
  no two-copies risk.
- Future contributors who add a new recipe edit one file.

**Negative.**

- No built-in search. Acceptable for the current corpus size
  (~13 pages); when the page count justifies search, integrate
  Pagefind (the static-site search Algolia DocSearch comparison
  the issue raises) without changing the host. This is the
  primary watch signal for re-evaluating to option (c).
- No per-version routing. Acceptable while the React library is
  pre-1.0. When `@chordsketch/react` reaches 1.0 and starts
  shipping breaking changes, revisit per
  [`adr-discipline.md`](../../.claude/rules/adr-discipline.md).
- No sidebar nav generator. The nav index page is hand-authored
  from the canonical Markdown structure. This is fine for ~13
  pages; an automated generator becomes worthwhile around ~30.
- Bundle size grows by `marked` (~30 KB minified) plus the docs
  React entry. The docs entry is its own chunk via Vite's
  multi-page input, so the chordpro / irealpro routes are not
  affected.

**Mitigations.**

- The docs entry uses the same lazy-loading pattern as the rest of
  the playground (no `@chordsketch/wasm` import on the docs
  routes, so the heavy wasm bundle is not fetched).
- `playground-smoke.yml` adds at least one Playwright assertion
  per docs entry point per
  [`.claude/rules/playground-smoke.md`](../../.claude/rules/playground-smoke.md);
  the docs site participates in the same browser-mount guarantee.

## Alternatives considered

**Option (b) — separate `docs.chordsketch.koeda.me` subdomain.**
Same Vite or Astro project, separate Pages site. Doubles the build
+ deploy + smoke surface without improving the reader experience;
the subdomain split is a worse default than co-location because
external links from blog posts and Stack Overflow answers fragment
across two hosts.

**Option (c) — Docusaurus / VitePress / Astro Starlight at a
third subdomain.** Brings built-in search, sidebar nav, MDX
authoring, per-version routing. None of those are load-bearing
today. The dependency footprint (~150 transitive npm packages for
Docusaurus, ~80 for VitePress) is meaningful against the project's
"justify any new dependency" rule
([`.claude/rules/code-style.md`](../../.claude/rules/code-style.md)).
The watch signals for re-evaluation are: corpus exceeds ~30 pages,
per-version docs become necessary, or built-in search becomes a
user request. Until then, option (a) is the right default.

**Option (d) — host the recipes only on GitHub (no docs site).**
The current state. Rejected because the recipes are not
discoverable from `chordsketch.koeda.me` and the per-component API
reference is currently only available as the package README.

## References

- Issue: [#2506](https://github.com/koedame/chordsketch/issues/2506)
- Parent tracking issue: [#2473](https://github.com/koedame/chordsketch/issues/2473) §4
- Design reference: [ai-sdk.dev/docs/ai-sdk-ui](https://ai-sdk.dev/docs/ai-sdk-ui)
- Existing playground deployment:
  [`.github/workflows/deploy-playground.yml`](../../.github/workflows/deploy-playground.yml)
- Existing playground smoke:
  [`.github/workflows/playground-smoke.yml`](../../.github/workflows/playground-smoke.yml)
- Watch signals:
  - Search becomes a user request → integrate Pagefind without
    changing host.
  - Corpus exceeds ~30 pages → re-evaluate option (c).
  - `@chordsketch/react` reaches 1.0 with breaking changes →
    re-evaluate per-version routing.
