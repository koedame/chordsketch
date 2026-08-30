# 0040. External-tool integration is not covered by CI; the `Extended Tests` workflow is removed

- **Status**: Accepted
- **Date**: 2026-08-30

## Context

`.github/workflows/extended-tests.yml` was added on 2026-03-31 (#204) as a
`workflow_dispatch`-only workflow. It installs abc2svg, LilyPond and Perl
ChordPro, then runs `cargo test --workspace --exclude chordsketch-desktop --
--ignored` plus `scripts/compare-with-perl.sh` in both output formats.

It was the only place in CI that would have exercised the external-tool
surface: 11 `#[ignore]` tests across `crates/chordpro/src/external_tool.rs`
and `crates/render-html/src/lib.rs`, plus the Perl comparison script.

Two facts decide this:

1. **It has never run.** The GitHub Actions API reports `total_count: 0`
   for the workflow (id `254116223`) — zero runs in the five months since it
   was added. A dispatch-only workflow that nobody dispatches provides no
   coverage; it only looks like coverage from the workflow list.
2. **It has already drifted out of working order.** `musescore_detection`
   (added 2026-04-09, #1263, after the workflow was written) asserts
   `has_musescore()`, but the workflow never installs MuseScore. A first
   dispatch today would fail on that test, not on a real regression.

## Decision

Remove `.github/workflows/extended-tests.yml`. External-tool integration
(abc2svg, LilyPond, MuseScore, Perl ChordPro) is deliberately **not**
covered by CI.

The `#[ignore]` tests and `scripts/compare-with-perl.sh` stay in the tree as
on-demand local checks. `docs/dev-setup.md` keeps the install instructions
and the exact commands, and states explicitly that CI does not run them.

## Rationale

- Zero runs in five months is the whole evidence base for "nobody wants a
  manual external-tool run". Nothing suggests a scheduled one would be read
  either; it would just move the same output from nowhere to an inbox.
- Reviving the workflow is not "add a `schedule:` trigger". The drifted
  MuseScore step has to be fixed first, and a weekly run then installs four
  external toolchains (apt LilyPond, npm abc2svg, cpanm ChordPro, plus
  MuseScore) on every invocation. Those installs are the least stable part of
  the job: an upstream packaging change turns `main` red for a reason
  unrelated to this repository, and somebody has to be on the hook for it.
- The failures such a job would catch are mostly not ours. The integration
  is thin — runtime detection plus a sanitised subprocess invocation — so a
  break is usually a change in the external tool's CLI or output, surfacing
  as noise rather than as a regression signal.
- Security coverage does not depend on this workflow. The hardening that
  lives in this repository — `sanitize_abc_content`,
  `sanitize_lilypond_content`, `sanitize_musicxml_content`,
  `line_contains_dangerous_scheme` — is exercised by ordinary, non-`#[ignore]`
  unit tests that run in `ci.yml` on every PR. The single security-flavoured
  ignored test, `invoke_lilypond_blocks_scheme_code`, asserts LilyPond's own
  `-dsafe` behaviour, i.e. a property of the external tool.
- Keeping the tests runnable locally preserves the check for the contributor
  who actually touches `external_tool.rs`, at no standing cost.

## Consequences

- No workflow claims coverage that does not exist. The workflow list and the
  actual test matrix now agree.
- One fewer dispatch-only workflow to keep action pins and YAML current in;
  the cache carve-out list in `.claude/rules/ci-parallelization.md` loses its
  `extended-tests.yml` entry.
- **Negative**: a regression in the abc2svg / LilyPond / MuseScore / Perl
  ChordPro integration is now caught only when a human runs
  `cargo test --workspace -- --ignored` locally. In practice that was already
  the case — the workflow never ran — so this records reality rather than
  changing it.
  - *Mitigation*: `docs/dev-setup.md` states that CI does not run these
    tests, so a contributor changing `external_tool.rs` or the ABC/LY render
    paths knows the check is theirs to run.
- The 11 `#[ignore]` tests and `scripts/compare-with-perl.sh` are retained,
  so the decision is cheap to reverse: restoring a scheduled workflow is a
  new YAML file plus a MuseScore install step, not new tests.

## Alternatives considered

- **Add a weekly `schedule:` trigger and keep the workflow.** Rejected: it
  buys retroactive coverage of a surface nobody has reported a bug in, and
  charges a recurring four-toolchain install — the most flake-prone part of
  the job — against a scheduled run with no owner. Fixing the MuseScore drift
  is a prerequisite, so this is real work, not a one-line trigger change.
- **Leave the workflow as dispatch-only.** Rejected: this is the status quo
  that produced the problem. A workflow that has never run, and that would
  fail if it did, is worse than no workflow, because the workflow list
  implies the external-tool tests have somewhere to run.
- **Delete the `#[ignore]` tests and `scripts/compare-with-perl.sh` too.**
  Rejected: they cost nothing while dormant (`cargo test` skips them) and are
  the only compatibility check against the Perl reference implementation,
  which is the project's stated goal. Removing them would discard the check
  as well as the automation.

## References

- Workflow removed: `.github/workflows/extended-tests.yml`, added in
  https://github.com/koedame/chordsketch/pull/204
- MuseScore ignored test that the workflow never installed for:
  https://github.com/koedame/chordsketch/pull/1263
- Run count evidence: `gh api repos/koedame/chordsketch/actions/workflows/extended-tests.yml/runs --jq '.total_count'` → `0` (2026-08-30)
- Cache carve-out rule: `.claude/rules/ci-parallelization.md`
- Local run instructions: `docs/dev-setup.md` § "Running Extended Tests"
- **Watch signal**: revisit if a bug is reported against the abc2svg /
  LilyPond / MuseScore / Perl ChordPro integration that a scheduled run would
  have caught first, or if the external-tool surface grows beyond detection +
  invocation.
