# 0077. Dependabot reads the composite actions; github-actions majors are grouped by dependency name

- **Status**: Accepted
- **Date**: 2026-09-16

## Context

`.github/dependabot.yml` pointed the `github-actions` ecosystem at
`directory: "/"`. For that ecosystem, `/` means `.github/workflows/` and an
`action.yml` at the repository root
([options reference: `directories` / `directory`](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference#directories-or-directory--)).
The eleven composite actions under `.github/actions/*/action.yml` were never
read, so their `uses:` pins stayed where they were written while the same
actions moved on in the workflows. On 2026-09-16:

- `actions/setup-node` was `v6.4.0` in the workflows and in two other composite
  actions, and `v6.3.0` in
  `.github/actions/desktop-build-steps`, while
  [#2919](https://github.com/koedame/chordsketch/pull/2919) proposed `v7.0.0`
  for the workflows only.
- `taiki-e/install-action`, commented `# v2` everywhere, resolved to three
  releases: `v2.87.0` in the workflows, `v2.77.6` in
  `.github/actions/install-wasm-pack` and `v2.75.18` in
  `.github/actions/desktop-build-steps`.

[ADR-0075](0075-dependabot-groups-patch-and-minor-updates.md) decision 4
already assumed a github-actions PR edits workflow and composite-action files
alike.

Listing the composite actions in `directories` changes how PRs are cut, and
the documentation does not say how for this configuration: it describes
`group-by: dependency-name` combining one dependency across directories, but
not what a `groups` entry without `group-by`, or an update no group matches,
does across several directories. Getting it wrong matters here because an
ecosystem stops receiving PRs once five of them are open (ADR-0075, Context).

The configuration was therefore measured in a scratch repository holding one
workflow and two composite actions that pin the same actions, with
`directories: ["/", "/.github/actions/*"]`:

| Configuration | Patch update of one action pinned in all three | Major update of one action pinned in all three |
| --- | --- | --- |
| `actions-minor-patch` group only (ADR-0075 as written) | 1 PR: "bump the actions-minor-patch group across 3 directories with 1 update", editing all three files | **3 PRs**, one per directory ("bump actions/setup-node from 6.3.0 to 7.0.0 in /.github/actions/a", …) |
| plus a `major` group with `group-by: dependency-name` | 1 PR, as above (a second patch update joined the same PR) | 1 PR per action ("bump actions/setup-node in /"), editing every file that pins it |

## Decision

1. The `github-actions` ecosystem reads `directories: ["/", "/.github/actions/*"]`.
   A new composite action is covered without editing the configuration.
2. A second group, `actions-major`, matches `update-types: ["major"]` with
   `group-by: dependency-name`, so a major stays one PR per dependency, now
   covering every workflow and composite action that pins it. This amends
   ADR-0075 decision 2 ("No group matches `major`") for github-actions; cargo
   has one directory and is unchanged.
3. `/dependabot-review` recognises the shapes this produces: a github-actions
   major titled `bump <DEP> in /` without versions, whose versions are in the
   body's `Updates` line, and a grouped body spanning several directories that
   repeats each `Updates` section per directory.

## Rationale

Without decision 2, one action major pinned in the workflows and in a few
composite actions opens a PR per directory, and a single week with one such
major reaches the five-PR limit that stopped cargo for 42 days. With it, the
PR count per week is what ADR-0075 intended: one grouped PR plus one PR per
major dependency. Grouping by dependency name keeps the property ADR-0075
decision 2 protected — a `BLOCKED` verdict and an adaptation commit attach to
exactly one dependency — and adds that the workflows and composite actions
move to the same pin in the same merge, which is what the split pins above
were missing.

## Consequences

**Positive**

- Composite-action pins receive updates, and a merge moves an action to one
  SHA across workflows and composite actions.
- A github-actions major is one PR however many directories pin the action.

**Negative**

- A github-actions major's title carries no versions and its head ref is
  `dependabot/github_actions/github_actions-<hash>`, so tooling that reads the
  dependency and versions from the title or ref finds nothing. Mitigation: the
  body's `Updates` line carries them, and `/dependabot-review` reads it.
- `group-by` applies to version updates only; a github-actions security update
  is not covered by this decision and may still open per directory.
  Mitigation: those are rare for actions and open at most once per affected
  directory.

## Alternatives considered

- **`directories` without an `actions-major` group.** Rejected: measured above,
  majors split per directory.
- **A second `github-actions` entry for `/.github/actions/*`.** Rejected: each
  entry opens its own grouped PR and its own majors, so one action update is
  two PRs that can merge apart, which is the split this decision removes.
- **Moving the composite actions' steps into the workflows.** Rejected: the
  composite actions exist to share steps between workflows; the configuration
  can read them where they are.

## References

- [ADR-0075](0075-dependabot-groups-patch-and-minor-updates.md) — decision 2 is
  amended here for github-actions.
- [Dependabot options reference: `directories`, `groups`, `group-by`](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference).
- [Optimizing the creation of pull requests for Dependabot version updates](https://docs.github.com/en/code-security/tutorials/secure-your-dependencies/optimizing-pr-creation-version-updates).
- `.github/dependabot.yml`, `.claude/commands/dependabot-review.md`.
- **Watch signals**: a github-actions major opened per directory (the group no
  longer applies); a composite action whose pin differs from the workflows'
  after a merged Dependabot PR.
