# 0059. The Claude Code skill ships as a plugin from a repo-root marketplace

- **Status**: Accepted
- **Date**: 2026-09-05

## Context

ChordSketch already meets AI-assisted workflows in two places: the CLI is
installable from ten channels, and the SDK is published to npm, PyPI,
RubyGems, CocoaPods and Maven Central. What is missing is the entry point
an agent actually reads — a description of *which* command answers "add
chords to these lyrics", "put this a whole step up", "turn it into a PDF",
"is this file valid".

Claude Code loads that kind of description as a **skill**: a `SKILL.md`
whose front matter declares when to use it, plus optional reference files
loaded on demand. Skills reach users through **plugins**, and plugins are
installed from a **marketplace** — a git repository carrying
`.claude-plugin/marketplace.json` at its root:

```
/plugin marketplace add koedame/chordsketch
/plugin install chordsketch@chordsketch
```

The repository already has a `.claude/skills/` directory, but everything
in it (`specification-website`) is development scaffolding for this
repository's own contributors. Nothing there is reachable by a user who
has installed ChordSketch and never cloned the source.

Two constraints shape the answer. First, a skill is only as truthful as
the surface it describes: it must document commands that the released
binary actually accepts, not the ones the working tree grew last week.
Second, Claude Code caches plugins under `<marketplace>/<plugin>/<version>/`
and refuses to re-fetch when the version in `plugin.json` has not moved, so
a plugin whose version never changes is a plugin whose content never
reaches anyone again.

## Decision

Ship the skill as a Claude Code plugin distributed from this repository:

1. `.claude-plugin/marketplace.json` at the repository root declares a
   marketplace named `chordsketch` with one plugin, `chordsketch`, sourced
   from `./packages/claude-code-plugin`.
2. `packages/claude-code-plugin/` holds the plugin: its
   `.claude-plugin/plugin.json` manifest, a README, and
   `skills/chordpro/` — `SKILL.md` plus `references/` for the detail that
   does not belong in the always-loaded body.
3. The skill drives the **`chordsketch` CLI** for render, transpose,
   validate, format and convert. The one operation the CLI has no path for
   — emitting the parsed AST as JSON — is documented against the published
   `@chordsketch/wasm` package and marked optional, so a user with only the
   CLI installed still gets every other operation.
4. The plugin version tracks the workspace version in lockstep, enforced by
   `scripts/check-version-consistency.py` like every other versioned
   manifest, and listed in `docs/releasing.md` step 1.

## Rationale

**The repository is the marketplace, so there is no second thing to
release.** A marketplace is a git repository with one JSON file; making
this repository serve as its own marketplace costs one manifest and reuses
the release process, the tag namespace, and the review gates that already
exist. `koedame/chordsketch` is also the name a user already trusts.

**Co-location keeps the skill honest.** The skill's commands and the CLI
that answers them live in one tree, so a PR that changes a flag can change
the skill in the same diff, and CI reviews both together. A skill in a
separate repository would drift from the CLI silently — the exact failure
mode `.claude/rules/readme-sync.md` exists to prevent for `README.md`.

**Lockstep versioning is what makes updates arrive.** Because the plugin
cache is keyed by version, the plugin has to bump for its content to reach
an installed client. Tying it to the workspace version means every release
already does that, and the existing consistency check fails the release if
a manifest is forgotten. An independently-versioned plugin would have a
bump step that only a human remembers.

**CLI-first matches how the skill is used.** An agent asked to render a
chart has a shell; assuming a Node toolchain and a resolvable npm registry
on top of that narrows the audience for no gain on the operations the CLI
already covers. AST JSON genuinely needs the wasm package today, and saying
so is more useful than pretending the CLI can do it.

## Consequences

- A user installs the skill with two lines and no clone, and the skill's
  operations map onto commands the released binary accepts.
- The repository is now a Claude Code marketplace. Adding a second plugin
  later is an entry in the existing `plugins` array, not new
  infrastructure.
- Skill content only reaches installed clients when a release bumps the
  version. A wording fix made mid-cycle waits for the next release. This is
  the accepted cost of not having a bump step that can be forgotten; a skill
  correction urgent enough to break that rule can ride a patch release.
- `parse` requires Node and `@chordsketch/wasm`. If the CLI ever grows a
  machine-readable AST output, the reference file collapses to a flag and
  the optional dependency disappears. That is the preferred resolution, and
  this ADR should be revisited when it lands.
- The skill documents the **published** surface. Exports added to
  `crates/wasm` after the last release are not usable by an installed
  client, so the reference files are written against what `npm view` shows,
  not against `bindings.rs`.

## Alternatives considered

**Put the skill in `.claude/skills/chordpro/`.** Rejected: that directory
is loaded from a checkout of this repository, so it serves contributors and
nobody else. The ticket's goal is distribution to ChordSketch *users*, who
have a binary and no source tree.

**Publish the plugin from a separate repository.** Rejected: it buys
independent versioning at the cost of a second release surface, a second
review path, and a skill that can describe flags the shipped CLI does not
have. The drift risk is the dominant term.

**Wait for an MCP server and ship tools instead of a skill.** Rejected as a
blocker, not as an idea. An MCP server exposes callable tools; a skill
teaches an agent to use what is already installed. They compose, and the
skill does not need the server to be useful today. The MCP server is
tracked separately and can be referenced from the skill once it exists.

**Version the plugin independently of the workspace.** Rejected: see
Rationale. The bump would be a manual step outside the release checklist,
and forgetting it is silent — installed clients simply keep the old skill.

## References

- Claude Code plugin and marketplace layout: `.claude-plugin/plugin.json`,
  `.claude-plugin/marketplace.json`
- `docs/releasing.md` step 1 — the versioned-manifest bump list
- `scripts/check-version-consistency.py` — enforcement of lockstep
- [ADR-0021](0021-docs-site-co-located-with-playground.md) — the same
  co-location argument applied to the docs site
