# 0075. Dependabot groups patch and minor updates per ecosystem; majors stay one PR per dependency

- **Status**: Accepted
- **Date**: 2026-09-15

## Context

[ADR-0016](0016-dependabot-review-skill.md) configured Dependabot to open one
pull request per dependency for every update type, and explicitly rejected
`groups:` ("Why per-PR audits instead of a grouped Dependabot PR?"): a bad
dependency inside a grouped PR "can no longer be skipped without unwinding the
whole grouped PR through `@dependabot recreate`", and the audit loop already
removed the human cost of many PRs. [ADR-0024](0024-scheduled-dependabot-merge.md)
then let a scheduled automation run that audit unattended, with a diff-sanity
gate phrased for one dependency per PR ("only manifest/lockfile or a single
`uses:` line for the dependency itself").

Two things have changed since.

**The PR count is the load, not a presentation detail.** The weekly run of
2026-09-13 opened nine PRs,
[#2875](https://github.com/koedame/chordsketch/pull/2875)–[#2883](https://github.com/koedame/chordsketch/pull/2883):
five cargo and four github-actions. Each is a separate audit, a separate full
check matrix, and a separate squash merge, after which Dependabot rebases every
sibling in the ecosystem and the matrix runs again on each. Every cargo PR runs
the macOS cells, and GitHub-hosted runners cap concurrent macOS jobs at five
(`.claude/rules/ci-parallelization.md` §5), so five cargo PRs rebased after
each merge queue behind one another. Across the last 60 Dependabot PRs, 8 were
closed unmerged, most of them superseded by the next version of the same
dependency before anyone reached them — audit work spent on a PR that never
merged.

**The per-PR count is also what stops Dependabot.** An ecosystem stops receiving
update PRs once five of its PRs are open (the default
`open-pull-requests-limit`). With one PR per dependency, a single unattended
week can reach that; it did, and cargo received no PR for 42 days
(2026-07-19 to 2026-08-30, recorded in the comment at the top of
`.github/dependabot.yml` and in [ADR-0048](0048-scheduled-rustsec-audit.md)).

**The skip problem ADR-0016 cited now has a mechanism.** Dependabot's comment
commands for grouped updates include `@dependabot ignore <DEPENDENCY_NAME>`,
which closes the grouped PR and stops Dependabot updating that dependency, and
`@dependabot unignore <DEPENDENCY_NAME>`, which clears the condition and opens a
new PR that includes it again
([Dependabot pull request comment commands](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-pull-request-comment-commands)).
A blocked row can be dropped without recreating the group by hand.

## Decision

1. **Group patch and minor version updates per ecosystem.** Each ecosystem in
   `.github/dependabot.yml` gets one group matching
   `update-types: ["minor", "patch"]`: `cargo-minor-patch` and
   `actions-minor-patch`. A week's patch and minor updates arrive as one PR per
   ecosystem.
2. **Major updates stay one PR per dependency.** No group matches `major`, so
   Dependabot keeps opening them individually. For cargo this includes every
   pre-1.0 bump that Cargo treats as breaking: Dependabot's cargo version class
   classifies `0.y.z` → `0.(y+1).z` and any `0.0.z` change as `major`, so
   `wry` 0.55 → 0.57 and `windows-core` 0.61 → 0.62 (both in the 2026-09-13 run)
   stay individual.
3. **Security updates are not grouped.** The groups use the default
   `applies-to: version-updates`; security updates keep opening immediately, one
   per advisory.
4. **The audit covers every dependency a PR updates, and the verdict is per
   PR.** `/dependabot-review` reads the grouped PR's `| Package | From | To |`
   table and runs the advisory check, release-note read and repository-activity
   sniff test for each row; build, test and lint run once. One `BLOCKED` row
   blocks the PR. This amends ADR-0024 decision 2 ("release notes across every
   version between old and new") to apply per row, and its diff-sanity gate to
   "`Cargo.toml` / `Cargo.lock`, or `uses:` lines naming the listed actions, in
   any number of workflow and composite-action files" — one action is commonly
   pinned in several workflows, so even a single-dependency actions PR
   ([#2878](https://github.com/koedame/chordsketch/pull/2878)) touches two
   files.
5. **A blocked row is dropped with `@dependabot ignore <DEP>`.** When the other
   rows are `SAFE` / `FIXED`, the audit drops the blocked rows so the rest are
   re-proposed without them, records each ignored dependency and its
   `@dependabot unignore <DEP>` command in the PR comment and the run summary,
   and lifts the condition once the block is resolved. The merge gate is
   otherwise unchanged: ADR-0013 conditions and ADR-0024's five conditions
   apply to a grouped PR exactly as to a single-dependency one.

`open-pull-requests-limit`, the Dependabot default cooldown and
`commit-message` are left unset.

## Rationale

The split follows where the audit's judgement is spent. A patch or minor update
is, by the dependency's own versioning promise, compatible; the audit's work on
it is reading notes and advisories and letting the check matrix confirm, and
none of that gets harder when several such updates share one matrix run.
Majors are where release notes describe breaking changes and the audit writes
code-side adaptation commits (ADR-0016, ADR-0024). Keeping them one per PR keeps
a `BLOCKED` verdict and a `fix(deps): adapt to <DEP> <NEW>` commit attached to
exactly one dependency, which is what ADR-0016's objection to grouping was
protecting.

Cargo's pre-1.0 classification is what makes the `minor` / `major` line safe
for this workspace, where much of the dependency graph is `0.y`: the updates
that are breaking under Cargo's caret rules are classified `major` and never
enter the group.

Dropping a row with `ignore` is persistent, unlike simply leaving it out of one
PR, which is why the decision requires recording the ignored dependency and its
`unignore` command where the maintainer reads the result.

## Consequences

**Positive**

- The 2026-09-13 run would have been four PRs instead of nine: one cargo group
  (`napi-derive`, `schemars`, `clap_complete`), `wry`, `windows-core`, and one
  actions group.
- One matrix run and one merge per ecosystem for all compatible updates, with
  no sibling-rebase cascade between them; far fewer macOS cells contending for
  the five-job ceiling.
- An ecosystem's open PRs are its grouped PR plus its majors, so reaching the
  five-PR limit takes five unmerged majors rather than one busy week.
- A newer version of a row supersedes the grouped PR as a whole: Dependabot
  closes it and opens a replacement, instead of leaving one closed PR per
  superseded dependency.

**Negative**

- A regression that slips through the audit lands in a commit that updated
  several dependencies at once, so bisecting to the culprit takes a step more.
  Mitigation: the grouped PR's table names every version change, and the rows
  are compatible updates by their own versioning.
- A `BLOCKED` row delays the other rows of its group until Dependabot
  re-proposes them. Mitigation: the drop procedure, and the maintainer can
  trigger the ecosystem's update run from the Dependabot page instead of waiting
  a week.
- An `ignore` that is never lifted stops updates for that dependency silently.
  Mitigation: every ignored dependency is named, with its `unignore` command, in
  the PR comment and the run summary; `@dependabot show <DEP> ignore conditions`
  lists what is stored.

## Alternatives considered

- **Keep one PR per dependency (ADR-0016).** Rejected for the load and
  stalled-ecosystem reasons in Context; the skip mechanism that justified it
  is now available for grouped PRs.
- **Group every update type, majors included.** Rejected: majors are where code
  adaptation happens, and a group couples an adapted major's fate to every
  compatible update in the week.
- **Groups per dependency family (`tauri*`, `napi*`, …).** Rejected: every
  patch and minor update already lands in the one ecosystem group, and families
  whose major versions must move together are governed by the checks that
  enforce them (e.g. ADR-0066), not by PR layout.
- **Raise `open-pull-requests-limit` instead.** Rejected: it removes the stall
  without reducing the audit, matrix and rebase work per week.

## References

- [ADR-0016](0016-dependabot-review-skill.md) — per-dependency PRs and the
  `/dependabot-review` skill; its rejection of grouping is reversed here for
  patch and minor updates.
- [ADR-0024](0024-scheduled-dependabot-merge.md) — unattended audit-and-merge;
  decision 2 and its diff-sanity gate are amended here.
- [ADR-0048](0048-scheduled-rustsec-audit.md) — the 42-day cargo stall.
- `.github/dependabot.yml`, `.claude/commands/dependabot-review.md`.
- [Dependabot options reference: `groups`](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference#groups--).
- Dependabot's cargo version class (`Dependabot::Cargo::Version.update_type`)
  for the pre-1.0 classification.
- **Watch signals**: a regression bisected to a grouped merge whose culprit the
  table did not make obvious; a grouped PR that repeatedly carries a `BLOCKED`
  row; an ignore condition found stale with no record of why.
