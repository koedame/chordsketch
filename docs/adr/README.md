# Architecture Decision Records

This directory contains the architecture decision records (ADRs) for
ChordSketch. An ADR captures a single, significant architectural or
operational decision together with the context that produced it, the
alternatives considered, and the consequences accepted.

ADRs exist to preserve **why** a decision was made, not just **what** was
decided. The codebase, git history, and issue tracker already record the
**what**; an ADR exists when the **why** would otherwise be lost.

## When to write an ADR

Write an ADR when any of the following are true:

- A decision intentionally **declines** to do work that an open issue
  proposes (e.g. an upstream-blocked migration), and that decision should
  outlive the issue's closure.
- A decision rules out an alternative whose case is non-obvious enough that
  a future contributor might re-propose it without the historical context.
- A decision establishes a project-wide convention that the rules in
  `.claude/rules/` do not already cover.

Routine code changes do **not** need an ADR. The bar is "would a reasonable
future contributor reach the wrong conclusion if this rationale were
missing?"

## File naming

ADR files are named `NNNN-kebab-case-title.md`, where `NNNN` is a
zero-padded sequence number assigned in creation order. Numbers are
**never reused**, even if an ADR is later superseded.

## Template

Each ADR follows this structure:

```markdown
# NNNN. Short title in sentence case

- **Status**: Accepted | Superseded by ADR-NNNN | Deprecated
- **Date**: YYYY-MM-DD

## Context

What problem prompted this decision? What constraints, prior art, or
upstream limits define the space of possible answers?

## Decision

The chosen course of action, stated unambiguously.

## Rationale

Why this option, given the context. Cite evidence (URLs, commit hashes,
issue numbers) so the reasoning can be re-verified later.

## Consequences

The trade-offs accepted by the decision — both positive and negative.
Mitigations for the negatives, if any.

## Alternatives considered

Other options that were on the table and why they were rejected.

## References

Issues, PRs, external documentation, and any "watch signals" that should
prompt revisiting the decision.
```

Once the ADR is committed, its **Status** is locked. If the decision later
changes, write a new ADR that supersedes the old one and update the old
ADR's Status line to `Superseded by ADR-NNNN`.

## Index

| ADR | Title | Status |
|---|---|---|
| [0001](0001-kotlin-maven-central-publishing-credentials.md) | Kotlin Maven Central publishing credentials | Accepted (2026-04-11) |
| [0002](0002-aur-smoke-coverage-exemption.md) | AUR install command is exempt from readme-smoke coverage | Accepted (2026-04-18) |
| [0003](0003-github-merge-queue.md) | GitHub Merge Queue replaces the auto-update-branch cascade | Superseded by ADR-0015 (2026-04-22) |
| [0004](0004-unsafe-eval-for-web-tree-sitter-emscripten.md) | `'unsafe-eval'` in the desktop CSP for `web-tree-sitter` | Accepted (2026-04-24) |
| [0005](0005-tauri-updater-key-management.md) | Tauri updater key management (Ed25519, no password) | Superseded by ADR-0007 (2026-04-25) |
| [0006](0006-desktop-webview-trust-boundary.md) | Desktop WebView is trusted; custom commands are not capability-gated | Accepted (2026-04-24) |
| [0007](0007-tauri-updater-key-with-password.md) | Tauri updater key requires a non-empty password | Accepted (2026-04-25) |
| [0008](0008-npm-publishing-is-local.md) | npm publishing is a maintainer-local manual operation | Accepted (2026-04-26) |
| [0009](0009-release-event-cascade-credential.md) | Release event cascading requires a non-GITHUB_TOKEN credential | Superseded by ADR-0039 (2026-04-26) |
| [0010](0010-image-path-resolution-stays-strict.md) | Image path resolution stays strict (declines R6.100 `~` and folder-next-to-song) | Accepted (2026-04-28) |
| [0011](0011-html-styles-stay-inline.md) | HTML styles stay inline-per-element (declines R6.100 `default/screen/print` + `html.style.embed`) | Accepted (2026-04-28) |
| [0012](0012-macports-portfile-cargo-crates-tag-relative.md) | MacPorts Portfile cargo.crates is tag-relative, not HEAD-relative | Accepted (2026-04-29) |
| [0013](0013-conditional-bot-driven-merge.md) | Bot-driven merge is allowed under explicit session permission | Accepted (2026-04-29; condition 4 updated by ADR-0015; clause 1 extended for unattended Dependabot merge by ADR-0024; clause 1 generalized by ADR-0047) |
| [0014](0014-bravura-glyphs-as-svg-paths.md) | Bravura SMuFL glyphs ship as inline SVG paths, not as a bundled font | Accepted (2026-05-01) |
| [0015](0015-disable-github-merge-queue.md) | Disable GitHub Merge Queue (supersedes ADR-0003) | Accepted (2026-05-03) |
| [0016](0016-dependabot-review-skill.md) | Dependabot review moves from a CI bot to a session skill; major bumps are no longer suppressed | Accepted (2026-05-03; unattended scheduled run added by ADR-0024) |
| [0017](0017-react-renders-from-ast.md) | React surface renders from AST; Rust HTML renderer demoted to static-output | Accepted (2026-05-10; consumer classification partially updated by ADR-0022) |
| [0018](0018-phase-based-shell-orchestrated-workflows.md) | Phase-based shell-orchestrated workflows (declines cc-wf-studio / n8n / Agent SDK as substitutes) | Accepted (2026-05-16) |
| [0019](0019-batch-mode-autopilot-issue.md) | Batch-mode autopilot-issue workflow (one PR aggregates multiple eligible issues per round) | Accepted (2026-05-17) |
| [0020](0020-ireal-pro-react-surface.md) | iReal Pro React surface is native React (option (b) MVP), not a `ui-irealb-editor` wrapper | Accepted (2026-05-19) |
| [0021](0021-docs-site-co-located-with-playground.md) | Docs site is co-located with the playground (option (a), not Docusaurus / VitePress / subdomain) | Accepted (2026-05-19) |
| [0022](0022-react-as-canonical-preview-surface.md) | React as the canonical preview surface; `@chordsketch/ui-web` retired | Accepted (2026-05-20) |
| [0023](0023-capo-transposes-displayed-chords.md) | `{capo}` directive transposes displayed chords | Accepted (2026-05-24) |
| [0024](0024-scheduled-dependabot-merge.md) | Scheduled unattended Dependabot review-and-merge, all bump types (extends ADR-0013 clause 1) | Accepted (2026-05-25) |
| [0025](0025-build-time-syntax-highlighting-shiki.md) | Build-time syntax highlighting for the docs site uses Shiki (preserves ADR-0021 zero-JS posture; reuses in-repo ChordPro TextMate grammar) | Accepted (2026-05-28) |
| [0026](0026-horizontal-chord-diagram-default-string-order.md) | Horizontal chord diagrams render reader-view only (high pitch on top, matches tablature stave order); player-view is not supported | Accepted (2026-05-30) |
| [0027](0027-inline-hover-compact-chord-diagrams.md) | Inline / hover chord diagrams use a dedicated compact layout (chordsketch `{diagrams: inline}` / `{diagrams: hover}` extension; not a CSS scale) | Accepted (2026-05-31) |
| [0028](0028-shared-directive-catalog.md) | Shared directive catalog in `chordsketch-chordpro` is the single source of truth for directive-name + value completion across LSP / web / playground | Accepted (2026-05-31) |
| [0029](0029-react-ui-primitives-package.md) | Design-system React primitives live in a wasm-free `@chordsketch/react-ui`; `@chordsketch/react` stays domain-only and does not re-export them | Accepted (2026-06-01) |
| [0030](0030-chord-diagram-fret-number-axis.md) | Chord diagrams label the full visible fret range by default across SVG / HTML / PDF; the axis subsumes the legacy single base-fret label, compact keeps it | Accepted (2026-06-15); labelling position superseded by ADR-0031, compact carve-out by ADR-0032 |
| [0031](0031-chord-diagram-fret-numbers-at-cell-centres.md) | Chord-diagram fret numbers sit at fret-cell centres (press positions, `1 2 3 …`, no nut `0`), not on fret lines; supersedes ADR-0030's labelling-position sub-decision | Accepted (2026-06-15); compact carve-out superseded by ADR-0032 |
| [0032](0032-compact-diagrams-show-fret-number-axis.md) | Inline / hover (compact) diagrams also draw the press-position fret-number axis (smaller font), not the legacy single label; supersedes ADR-0030/0031's compact carve-out | Accepted (2026-06-15) |
| [0033](0033-canonical-key-directive-notation.md) | Canonical `{key}` notation + a single strict key parser (`parse_key`); malformed keys (`G m`, `Gminor`, `G minor`, `G7`) warn and render verbatim instead of being silently mis-classified | Accepted (2026-06-17); strict-input clause superseded by ADR-0034 |
| [0034](0034-lenient-key-input-canonical-render.md) | Lenient `{key}` input, canonical render: accept the common human key spellings (`G minor`, `G m`, `Gminor`, `G major`, …) and normalise them to a canonical form on every render surface while leaving the editor source untouched; only non-keys (`G7`, `H`) still warn (supersedes ADR-0033's strict-input clause) | Accepted (2026-06-17); canonical-form clause superseded by ADR-0035 |
| [0035](0035-spelled-out-canonical-key-notation.md) | Spelled-out canonical `{key}` notation: the rendered canonical form is `G major` / `G minor` / `C dorian` (was `Gm` / `G`), parallel with the modal form, via the shared `key::quality_word` so every surface agrees; input stays lenient (supersedes ADR-0034's canonical-form clause) | Accepted (2026-06-17) |
| [0036](0036-real-bravura-glyphs-for-key-and-staff.md) | Real Bravura SMuFL outlines (gClef / sharp / flat / notehead) for the `{key}` chip + chord-tone staff, baked as SVG paths via the ADR-0014 generator across render-html + `@chordsketch/react`; no JS notation engine (renderer-parity), Verovio recorded as a future watch signal | Accepted (2026-06-22) |
| [0037](0037-explicit-chord-extension-notation.md) | Explicit chord-extension notation: the editor produces only unambiguous forms (`G7(13)` / `G7(9,11,13)`, never bare `G13`; `Cadd9` / `C7(9)`, never `C(9)`) via orthogonal triad × seventh × tension controls; ambiguous notation still parses and renders but warns toward the explicit spelling (sister to ADR-0034's `validate_keys`), source never auto-rewritten | Accepted (2026-06-22) |
| [0038](0038-single-sourced-design-tokens.md) | Design tokens stay single-sourced in `design-system/tokens.css`; a bespoke zero-dependency `scripts/build-tokens.mjs` projects it to the hand-mirrored derived copies (the per-package `--cs-*` blocks and the iReal bare block) between `@generated` markers, with a CI diff guarding drift; namespaces and scopes preserved, single light theme | Accepted (2026-06-26) |
| [0039](0039-release-fan-out-is-an-explicit-call-graph.md) | Release fan-out is an explicit `workflow_call` graph rooted at `release.yml`, not a `release: [published]` broadcast; tag-namespace routing and publish-before-verify ordering become structural, `release-verify` moves to a daily convergence sweep, `vscode-extension.yml` stops masking failures, and `RELEASE_DISPATCH_TOKEN` is retired (supersedes ADR-0009) | Accepted (2026-08-30) |
| [0040](0040-external-tool-tests-are-not-run-in-ci.md) | External-tool integration (abc2svg / LilyPond / MuseScore / Perl ChordPro) is not covered by CI; the never-run, dispatch-only `Extended Tests` workflow is removed and the `#[ignore]` tests stay as local on-demand checks | Accepted (2026-08-30) |
| [0041](0041-readme-smoke-scoped-to-readme-prs.md) | README install smoke tests run on PRs only when the README system changes (`README.md`, the command snapshot, the fixtures, the `cli-render-smoke` composite, the workflow); the daily cron stays the detector for registry-side regressions | Accepted (2026-08-30) |
| [0042](0042-action-pins-must-be-default-branch-ancestors.md) | Action SHA pins must name a commit reachable from the upstream default branch (a rewritten-branch tip breaks Dependabot's `github_actions` job and can be garbage-collected out from under every workflow); `dtolnay/rust-toolchain` moves to a `master` pin + explicit `toolchain:` | Accepted (2026-08-30) |
| [0043](0043-issue-not-required-for-prs.md) | A GitHub Issue is not a prerequisite for a change; branches without an issue use `{type}/{short-kebab-case}` and PR bodies without `Closes #N` are valid (issues stay the place for user reports, planning, and `type:tracking` umbrellas) | Accepted (2026-08-30) |
| [0044](0044-pre-1.0-breaking-changes-are-expected.md) | Pre-1.0 releases may break compatibility without a deprecation cycle (public API, rendered output, CLI flags, binding wire shape) and an MSRV raise is not held for `1.0.0`; the workspace floor moves 1.85 → 1.88 to unblock the `uniffi` / `pdf-extract` bumps | Accepted (2026-08-31) |
| [0045](0045-retire-one-pr-at-a-time.md) | Retire the one-PR-at-a-time serialisation rule: no cap on open PRs against `main`, the `autopilot-issue` HALT gate is removed, and the macOS 5-job ceiling keeps its home in `ci-parallelization.md` §5 as advice rather than a prohibition | Accepted (2026-09-01) |
| [0046](0046-linux-release-binaries-target-an-old-glibc.md) | Every Linux artifact — release archives, Node addon, gem and JAR native libraries — is linked against an old sysroot (`cross`, or `--use-napi-cross` for napi-rs) under one glibc 2.18 support floor, enforced on PRs against the release matrix and against each workflow's built artifacts before its publishing job; bottling Homebrew, swapping in musl, and documenting a 2.39 floor are all rejected (amended by ADR-0056, which carves the desktop bundles out to their own 2.35 floor) | Accepted (2026-09-02) |
| [0047](0047-merge-authorization-may-precede-the-work.md) | Merge authorization may be granted before the work begins: ADR-0013 condition (1) becomes "authorization to merge", satisfied by a grant made with a self-contained work unit (covering the PRs the assistant opens for it), by a named PR, or by explicit permission in the active session; inference and carry-over stay prohibited and conditions (2)–(4) are unchanged | Accepted (2026-09-02) |
| [0048](0048-scheduled-rustsec-audit.md) | RustSec advisories are detected by a daily `cargo audit` sweep that maintains one rolling tracking issue instead of failing; a pull request fails only for a vulnerability its own diff introduces, findings are labelled runtime vs dev-only, and every `.cargo/audit.toml` ignore entry carries an enforced `why:` and `review-by:` | Accepted (2026-09-01) |
| [0049](0049-chocolatey-rollup-reports-pending-as-its-own-verdict.md) | The post-release rollup's Chocolatey check reports three verdicts — OK once the version is installable from the feed `choco install` reads, PENDING while community moderation holds it, FAIL when the push never landed — because green must mean installable and red must be actionable | Accepted (2026-09-01) |
| [0050](0050-windows-preview-handler-is-installer-registered.md) | The Windows Explorer preview handler ships inside the desktop installer and is registered declaratively by WiX / NSIS at the installer's own scope (`HKMU` / `SHCTX`), not by a self-registering `DllRegisterServer`; the pane is a WebView2 control showing `chordsketch-render-html`'s fragment output under a `default-src 'none'` CSP, with the WebView2 profile in `LocalLow` and `IPreviewHandlerVisuals` deliberately unimplemented | Accepted (2026-09-02) |
| [0051](0051-inline-chord-diagrams-centre-on-the-lyric-position.md) | Inline chord diagrams (`{diagrams: inline}`) are centred on the lyric position their chord marks by shifting each cell half its own width, a paint-time transform that leaves every block width and lyric position untouched and cannot make diagrams collide on any instrument; cross-axis centring (which moves the lyric) and dropping the diagram from the width calculation (which makes diagrams overlap) are rejected | Accepted (2026-09-02) |
| [0052](0052-svelte-bindings-publish-sources.md) | `@chordsketch/svelte` publishes preprocessed `.svelte` sources plus generated `.d.ts` via `svelte-package` instead of a `tsup` ESM + CJS bundle, because the host application's own Svelte compiler is what turns a component into JavaScript and a CJS half would have no consumer; `vitePreprocess({ script: true })` (not the default) strips TypeScript and the `dist/` check in `svelte.yml` guards it | Accepted (2026-09-03) |
| [0053](0053-framework-demos-live-in-the-playground.md) | The Vue and Svelte bindings get live demo routes inside the existing playground Vite project (`/chordsketch/vue/`, `/chordsketch/svelte/`) rather than the `examples/docs-site/` Next.js app #2046 asked for; ADR-0021 already answered the hosting question, React's live surface stays the ChordPro playground, and the pages double as the only browser coverage either binding has. Lighthouse accessibility lands at 100, performance is recorded as unmet at parity with the playground | Accepted (2026-09-03) |
| [0054](0054-tertiary-ink-is-not-a-body-text-tone.md) | `--ink-500` / `--text-tertiary` (#8A8790) keeps its value and is documented as a non-text / large-text / disabled tone rather than a body-text one: at 3.53:1 it clears WCAG 1.4.11's 3:1 but not 1.4.3's 4.5:1, and no lighter tone both passes and stays visually distinct from `--ink-600` (the lightest AA-passing ink is #726F78, nine channel steps away), so small copy moves to `--text-secondary` instead of the token changing under every external consumer | Accepted (2026-09-03) |
| [0055](0055-docs-shiki-theme-matches-the-code-surface.md) | The docs Shiki theme is `github-dark-default`, picked because the build strips the theme's own background and paints `--cs-ink-1000` (#0A0A0B): the theme must be designed for a near-black surface and every token colour it emits over the corpus must clear 4.5:1, which `github-dark`'s #6A737D comments (4.11:1) did not | Accepted (2026-09-03) |
| [0056](0056-desktop-bundles-target-ubuntu-2204.md) | The Linux desktop bundles are built on a pinned `ubuntu-22.04` runner under their own glibc 2.35 floor, separate from ADR-0046's 2.18: a Tauri app links the host's webkit2gtk, `cross`'s Ubuntu 16.04 image cannot build it, and 22.04 is the oldest image carrying webkit2gtk 4.1 — which is also what excludes Debian 11 and RHEL at any glibc. Both desktop matrices' runner pins are asserted per PR and all three bundle formats (including the AppImage's ~160 bundled system libraries) are measured before upload (amended by ADR-0057: the RHEL exclusion covers EL 8 and EL 9 — EPEL packages webkit2gtk 4.1 for EL 10, where the `.rpm` installs) | Accepted (2026-09-04) |
| [0057](0057-desktop-rpm-stays-a-webkit2gtk-41-channel.md) | The desktop `.rpm` keeps being published as what it actually is — a webkit2gtk 4.1 channel serving Fedora and EL 10 with EPEL, measured rather than assumed — instead of being dropped or duplicated against webkit2gtk 4.0 / libsoup2: EL 8 and EL 9 package 4.0 only and the AppImage does not reach them either (ADR-0056's glibc 2.35 floor against their 2.34 / 2.28), so both alternatives cost work to serve a population of zero; the CLI is the RHEL 8 / 9 answer and both READMEs now state the per-format split | Accepted (2026-09-05) |
| [0058](0058-the-name-is-protected-separately-from-the-code.md) | The name and logo are held separately from the code licence and governed by `TRADEMARK.md`: nominative use (describing, teaching, repackaging unmodified releases) is free, source-identifying use (product names, official-looking package names, modified builds under the name) needs written permission; the marks are asserted unregistered (™) and registration stays a separate decision | Accepted (2026-09-05) |
| [0059](0059-claude-code-skill-ships-as-a-marketplace-plugin.md) | The Claude Code skill ships as a plugin installed from a `.claude-plugin/marketplace.json` at this repository's root (`packages/claude-code-plugin/skills/chordpro/`), not from `.claude/skills/` and not from a separate repository: co-location keeps the documented commands and the CLI that answers them in one diff, and the plugin version stays in workspace lockstep because Claude Code caches plugins per version and will not re-fetch an unchanged one. The skill is CLI-first; AST JSON is documented against the published `@chordsketch/wasm` package as an optional extra | Accepted (2026-09-05) |
