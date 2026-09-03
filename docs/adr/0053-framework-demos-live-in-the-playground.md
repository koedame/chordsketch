# 0053. Per-framework live demos live in the playground; the separate Next.js docs site is not built

- **Status**: Accepted
- **Date**: 2026-09-03

## Context

[#2046](https://github.com/koedame/chordsketch/issues/2046) — the last
open sub-issue of the
[#2039](https://github.com/koedame/chordsketch/issues/2039) UI-library
epic — asks for an `examples/docs-site/` **Next.js** app that hosts
live, interactive examples for each UI package and cross-links to the
SDK docs. It was filed on 2026-04-21, when none of the three UI
packages existed and there was no documentation site of any kind. It
carried the `blocked` label with "Blocked by: React / Vue / Svelte
packages shipped".

Both halves of that context have since changed.

- The blocker is gone. `@chordsketch/react` v0.4.0
  ([#2473](https://github.com/koedame/chordsketch/issues/2473)),
  `@chordsketch/vue` v0.1.0
  ([#2048](https://github.com/koedame/chordsketch/issues/2048)) and
  `@chordsketch/svelte` v0.1.0
  ([#2047](https://github.com/koedame/chordsketch/issues/2047)) are all
  in the tree, and every other sub-issue of #2039 is closed.
- The docs-site half was decided independently, and differently, by
  [ADR-0021](0021-docs-site-co-located-with-playground.md) (2026-05-19,
  a month after #2046 was filed). It hosts the docs inside the existing
  playground Vite project as pre-rendered static HTML at
  `/chordsketch/docs/`, and explicitly rejects a purpose-built
  site generator at its own path or subdomain — the dependency
  footprint is not justified while the corpus is ~20 pages, the
  React library is pre-1.0, and search is not a user request. That
  site now ships 20 pages including the three per-framework embedding
  recipes and the full `@chordsketch/react` component reference, and
  deploys on every push to `main` via `deploy-playground.yml`.

What #2046 asks for that is genuinely missing is therefore narrower
than its title: **a live surface for the Vue and Svelte bindings**.
Neither package has ever run in a browser inside this repository.
Their test suites are jsdom with a stubbed wasm loader, by design, so
nothing in the tree would notice either binding failing to boot the
real module — the exact blind spot
[`.claude/rules/playground-smoke.md`](../../.claude/rules/playground-smoke.md)
was written for after #2397.

## Decision

Do not build `examples/docs-site/`. Ship the missing live surface as
two more entries in the existing playground Vite project:

- `/chordsketch/vue/` — a Vue 3 app mounting `@chordsketch/vue`'s
  `<ChordTextarea>` and `<Transpose>`.
- `/chordsketch/svelte/` — the same page as a Svelte 5 app on
  `@chordsketch/svelte`.

Each page's nav, heading and lede are static markup in its
`index.html`; only the editor is mounted by the framework. The two
pages are linked from the playground landing page and from the
matching recipe page under `docs/sdk/tasks/`, and each links back to
its recipe. React's live surface stays the ChordPro playground at
`/chordsketch/chordpro/` — a second, thinner React embed would
demonstrate nothing the existing one does not.

`tests-e2e/framework-demos.spec.ts` drives both routes in a real
browser on every PR through `playground-smoke.yml`.

This decision closes #2046. The Next.js app, the `examples/`
directory, and the second deployment target are declined, not
deferred.

## Rationale

Every argument ADR-0021 made for co-locating the docs applies
unchanged to the demos, and one more argument applies only to them.

**The reasons carry over.** The playground project already owns the
wasm bundle, the design-system token layer, the GitHub Pages
workflow, the Playwright smoke harness and the SHA-pinned actions.
Adding two entries to its `rollupOptions.input` reuses all of that;
`examples/docs-site/` would need a second build pipeline, a second
deployment target, a second smoke surface and a second dependency
tree to upgrade. The Next.js app would also have to consume the UI
packages as published artifacts or through a workspace link, while
the playground aliases them to their sources — so a demo there could
lag the working tree, which is precisely what makes a demo worthless
as a regression signal.

**Framework parity is a reason, not an obstacle.** `@vitejs/plugin-vue`
and `@sveltejs/vite-plugin-svelte` each claim only their own file
extensions, so the three plugins coexist in one config and every
entry pays for exactly the framework it mounts. The built bundles
are 70 KB (Vue) and 57 KB (Svelte) — the Vue page does not download
Svelte, and neither downloads React.

**The demos double as the missing integration test.** This is the
argument ADR-0021 did not have to make: the docs pages render
Markdown, but these pages run the bindings. Before them, `npm test`
in `packages/vue` and `packages/svelte` could stay green through a
wasm-init regression that broke every real consumer. Now a browser
test asserts that each binding boots the real module, renders the
sample through `render_html_body`, re-renders from typed input, and
re-renders on transpose.

**The acceptance criteria are met except one, and that one was
written for a different artifact.** Live playground per UI package:
yes, for all three bindings. Per-component props reference: the
`@chordsketch/react` reference is 14 pages under
`docs/sdk/reference/`; the Vue and Svelte surfaces are documented per
component in their package READMEs and in their recipe pages, which
the demos link to. CI deployment on merge to `main`: already true via
`deploy-playground.yml`. Lighthouse accessibility 95+: measured at
**100** on both demo routes (the run surfaced one real contrast
failure — `.tool-group .label` at 3.53:1 on white — which this change
fixes for every playground route). Lighthouse performance 90+: see
Consequences.

## Consequences

**Positive.**

- Zero new workflows, deployment targets or hosting decisions; the
  demos deploy with everything else on the existing Pages job.
- `@chordsketch/vue` and `@chordsketch/svelte` gain browser coverage
  they have never had, on every PR.
- The demos always exercise the working tree, because the playground
  aliases both packages to their sources.
- One WCAG 1.4.3 contrast failure fixed across every playground
  route.

**Negative.**

- **The Lighthouse performance target is not met on the demo
  routes.** Measured locally against `vite preview` of the production
  bundle (uncompressed, no HTTP/2, throttled): 64 (Vue) and 52
  (Svelte), against 94 for the static docs route and 51 for the
  existing ChordPro playground. The gap is structural, not
  incidental: the largest element on the page is the rendered chord
  sheet, and it cannot paint before the ~500 KB wasm module has
  loaded and run. Reaching 90 would mean not rendering the sample on
  arrival — putting the editor behind a click — which removes the
  only thing the page exists to show. The demos are accepted at
  parity with the playground they sit beside, and the target is
  recorded here as unmet rather than quietly dropped. Deployed
  numbers will be better than the local measurement (GitHub Pages
  serves gzip over HTTP/2; the `uses-text-compression` audit alone
  estimates 215 KiB), but not by 30 points.
- The playground's devDependencies now carry `vue` and `svelte` plus
  their Vite plugins, and three CI workflows install two more sibling
  packages. Mitigation: all four are devDependencies of a private,
  unpublished package, and the install steps mirror the ones already
  there for `react` / `react-ui` / `ui-irealb-editor`.
- The two demo single-file components are not typechecked. `tsc`
  parses neither `.vue` nor `.svelte`, and adding `vue-tsc` plus
  `svelte-check` to the playground for two ~30-line components is a
  worse trade than the ambient declarations in
  `src/framework-demo.d.ts`. Mitigation: the components each package
  publishes *are* typechecked by their own package's CI, and the
  demos' use of them is asserted end to end in a real browser.
- The demo pages load `playground.css` whole, most of which they do
  not use (~22 KB uncompressed). Mitigation: splitting the shared
  chrome and the `--cs-*` token mirror out of that file would touch
  every playground route for a sub-5 KB gzipped saving; the token
  mirror must stay single-copy per
  [`.claude/rules/design-tokens.md`](../../.claude/rules/design-tokens.md).

## Alternatives considered

**Build `examples/docs-site/` as specified (Next.js).** Rejected. It
re-opens a hosting question ADR-0021 already answered, and answers it
the way ADR-0021 rejected: a second build pipeline, a second
deployment, a second smoke surface, and ~150 transitive packages
against the "justify any new dependency" bar in
[`.claude/rules/code-style.md`](../../.claude/rules/code-style.md).
The docs half of the issue is already delivered at
`/chordsketch/docs/`; building a second site would leave two docs
sites and fragment external links.

**Add the demos to the docs site instead of the playground.** Rejected.
ADR-0021's docs route is deliberately zero-JavaScript pre-rendered
HTML, which is why it scores 94 on performance. Mounting a framework
runtime on those pages would trade that property away for every
reader, including the ones who only came to read a recipe.

**Ship a third, minimal React demo for symmetry.** Rejected. The
ChordPro playground *is* the React surface, and a thinner React embed
next to it would demonstrate nothing new while adding a route to
maintain. The landing page says so explicitly instead.

**Defer #2046 as still-blocked.** Rejected. The blocker named on the
issue — the three packages shipping — is gone, so leaving the issue
open would state something untrue about the project.
Per [`.claude/rules/effort-is-not-a-filter.md`](../../.claude/rules/effort-is-not-a-filter.md)
its `size:large` label is not grounds to skip it either.

## References

- Issue: [#2046](https://github.com/koedame/chordsketch/issues/2046)
- Tracking issue: [#2039](https://github.com/koedame/chordsketch/issues/2039)
- Superseded framing: [ADR-0021](0021-docs-site-co-located-with-playground.md)
  chose the docs host; this ADR applies the same reasoning to the
  live-example half of #2046
- Smoke discipline: [`.claude/rules/playground-smoke.md`](../../.claude/rules/playground-smoke.md)
- Reproducing the Lighthouse numbers: build the playground, then run
  `npx vite preview --port 4180 --host 127.0.0.1` and
  `npx lighthouse@12 http://127.0.0.1:4180/chordsketch/vue/
  --only-categories=performance,accessibility` against it
- Watch signals:
  - A UI package gains a component with no counterpart in the demo
    (`<ChordDiagram>`, `<PdfExport>`) and adopters ask how to wire it
    → extend the demo pages rather than starting a new site.
  - The corpus or the audience outgrows ADR-0021's host (its own
    watch signals: >30 pages, per-version docs, search as a user
    request) → revisit both decisions together, since the demos ride
    on the same deployment.
