# 0048. RustSec advisories are detected by a scheduled audit, reported to one tracking issue, and block only the pull request that introduces them

- **Status**: Accepted
- **Date**: 2026-09-01

## Context

Until this ADR, `cargo audit` ran in exactly one place in this repository:
step 3 of `.claude/commands/dependabot-review.md`. That step is reached only
while auditing an **open Dependabot pull request**, so the repo's only
advisory detector was conditional on a bot having an open PR for the affected
crate. Nothing in `.github/workflows/` ran `cargo audit` or `cargo-deny`
(`grep -rn 'cargo audit\|cargo-deny' .github/` returned nothing across the 42
workflow files), and there was no `deny.toml`.

That coupling has two failure modes, and both have already fired.

**An advisory is published against a version already in `Cargo.lock`.** No
dependency change happens, so no Dependabot PR opens, so nothing looks.
RUSTSEC-2026-0187 (stack overflow in `lopdf` via deeply nested PDF objects,
CVSS 7.5, `AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H`) was published **2026-06-21**
and fixed in `lopdf` 0.42.0. This repo reached `lopdf` 0.42.0 only when
[#2750](https://github.com/koedame/chordsketch/pull/2750) (`pdf-extract`
0.10.0 → 0.12.0, opened 2026-06-28) merged on **2026-08-31**, after the MSRV
question it was blocked on was settled in
[#2774](https://github.com/koedame/chordsketch/issues/2774) /
[ADR-0044](0044-pre-1.0-breaking-changes-are-expected.md). For those **71
days** the advisory was visible only to whoever happened to re-run the
Dependabot audit on a PR that was already known to be blocked. No mechanism
would have raised it if that PR had been closed instead of parked.

**The backlog silences the detector exactly when it is longest.** Dependabot
stops opening PRs for an ecosystem once five of its PRs are open — the
comment at the top of `.github/dependabot.yml` records this, and the outage
is measurable: the `cargo` ecosystem produced no pull request between
[#2771](https://github.com/koedame/chordsketch/pull/2771) (2026-07-19) and
[#2785](https://github.com/koedame/chordsketch/pull/2785) (2026-08-30), a
42-day gap that ended only when the open PRs were cleared. During those 42
days the repository had no advisory detection at all.

Two further facts shaped the design.

**`Cargo.lock` does not record why a crate is in the graph.** The motivating
advisory was in `lopdf`, reached only through `pdf-extract`, which is declared
under `[dev-dependencies]` in `crates/render-pdf/Cargo.toml:28-35` — it
extracts text from generated PDFs for unicode golden fixtures. That advisory
could not reach a user of any published artefact; it could only affect the
test suite. `cargo audit` cannot make that distinction, because the lockfile
it reads does not carry it.

**The lockfile is not clean today, and some of it cannot be fixed here.**
Querying [OSV](https://osv.dev)'s batch API with the 749 packages in
`Cargo.lock` on 2026-09-01 returns three RustSec advisories that are actual
vulnerabilities — RUSTSEC-2026-0194 and RUSTSEC-2026-0195 (`quick-xml`
0.38.4, patched in 0.41.0) and RUSTSEC-2026-0009 (`time` 0.3.45, patched in
0.3.47) — plus roughly two dozen informational ones, most of them the
unmaintained GTK3 binding stack that `chordsketch-desktop` pulls in through
Tauri. `quick-xml` 0.38 → 0.41 is a semver-incompatible bump this repo does
not control. A design that turns any advisory into a red `main` would
therefore start red and stay red.

## Decision

`.github/workflows/dependency-audit.yml` runs `cargo audit`, and four
sub-decisions define what happens with the result.

1. **Tool: `cargo audit`, not `cargo-deny`.** The gap being closed is
   advisory detection. `cargo audit` is also the tool
   `.claude/commands/dependabot-review.md` already invokes, so the scheduled
   sweep and the PR-time audit cannot disagree about what counts as a
   finding.

2. **Triggers: a daily `schedule`, plus `workflow_dispatch`, plus a
   `paths`-scoped `pull_request`.** The schedule is the load-bearing one —
   it is the only trigger that can see an advisory published against an
   unchanged lockfile. The `pull_request` filter names the inputs that decide
   the verdict (`Cargo.toml`, `Cargo.lock`, the per-crate manifests,
   `.cargo/audit.toml`, the workflow, and the report script plus its tests),
   not a transitive dependency set.

3. **Reporting: the scheduled run maintains one rolling GitHub issue and
   never fails; a pull request fails only for what it introduces.** A
   scheduled run with findings opens (or rewrites the body of) a single issue
   titled "Security advisories in Cargo dependencies", labelled
   `dependencies` / `priority:high`, and closes it when the lockfile and the
   ignore list are both clean. A `pull_request` run subtracts the base
   branch's `cargo audit` result and fails only if the diff adds a
   vulnerability — or leaves a stale entry in `.cargo/audit.toml`.
   Informational advisories (unmaintained / unsound) never fail a run and
   never open an issue; they are listed in the job summary and in the issue
   body when one exists.

4. **Dev-only advisories are labelled, not exempted.** Every finding carries
   a scope column derived from `cargo tree --workspace --edges normal,build
   --target all`: `runtime` if the crate is reachable without a
   `[dev-dependencies]` edge, `dev/test-only` otherwise. The label drives
   triage priority; it does not change whether a finding blocks. A dev-only
   advisory that genuinely does not need fixing is muted the same way as any
   other — through an ignore entry whose `why:` line states the dev-only
   reasoning.

The ignore list lives in `.cargo/audit.toml`, and each entry carries its
rationale and expiry as comments directly above the id:

```toml
ignore = [
  # why: transitively pinned by tauri; no compatible release yet
  # review-by: 2026-12-01
  "RUSTSEC-2026-0194",
]
```

`scripts/audit-advisories.py` enforces that shape. A missing `why:`, a
missing or malformed `review-by:`, or a review date that has passed is
reported exactly like an advisory: the daily run opens the tracking issue and
the next dependency-touching pull request fails. The list ships empty — no
advisory is muted by this ADR.

## Rationale

**Why the schedule cannot be optional.** An advisory's publication date is
independent of this repository's activity. Any detector keyed to a diff is
structurally blind to the 71-day case above, and `Cargo.lock` changes are
exactly what stops during a Dependabot backlog. A daily sweep is the only
trigger whose cadence matches the failure mode, which is the same
failure-mode-to-detector alignment [ADR-0041](0041-readme-smoke-scoped-to-readme-prs.md)
applied to `readme-smoke.yml` — there the registry sweep moved off PRs onto a
cron; here the advisory sweep moves onto one.

**Why the scheduled run stays green.** Three unfixable-today advisories are
in `Cargo.lock` right now. Had the sweep been allowed to fail, its first run
would have been red and would have stayed red until an upstream crate this
repo does not control released a compatible version — and a permanently red
scheduled workflow reports nothing, because nobody reads a signal that is
always on. An issue that opens, updates, and closes itself carries the same
information with a state a reader can act on.

**Why a pull request is judged only on what it adds.** A contributor
changing `Cargo.lock` cannot fix `quick-xml`'s major-version gap, and
blocking them on it would produce the "red for a condition the author did not
cause and cannot fix" pattern ADR-0041 measured on `readme-smoke.yml` (186 of
187 failing jobs). Subtracting the base branch's result leaves exactly the
class the PR gate can act on: this diff moved a dependency onto a version
with a known advisory. That is also the case `/dependabot-review` audits
today, so the gate makes the manual audit's step 3 structural.

**Why the ignore list is enforced rather than merely documented.** The
incident this ADR responds to is not "an advisory existed" but "an advisory
was invisible for 71 days". An ignore list with no expiry reproduces exactly
that: it converts a visible finding into an invisible one, permanently, with
no event scheduled to revisit it. Making a passed `review-by` date itself a
finding means muting an advisory buys a bounded amount of quiet and nothing
more.

## Consequences

**Positive.**

- An advisory published against an unchanged lockfile is detected within 24
  hours, independent of Dependabot's state. The `lopdf` case would have
  produced an issue on 2026-06-22 instead of surfacing inside a blocked PR's
  audit.
- A dependency bump onto a known-vulnerable version fails CI on the pull
  request that proposes it, including a Dependabot PR, instead of relying on
  a maintainer invoking `/dependabot-review`.
- `main` cannot be turned red by an advisory nobody can fix, so the signal
  keeps its meaning.
- The scope column tells a triager whether a finding ships to users or only
  runs in the test suite, without them having to trace the dependency graph
  by hand.

**Negative, accepted.**

- The scheduled sweep's verdict lives in an issue, not in a red check. If the
  issue is ignored, the advisory is ignored — the workflow raises the signal,
  it does not enforce a response. The self-closing behaviour is what keeps
  the issue's state honest enough to be worth reading.
- `cargo tree --edges normal,build` treats a proc-macro or build-script
  dependency as `runtime` even though it does not ship in a release artefact.
  The label errs toward over-reporting, which is the safe direction for a
  triage aid.
- Licence and duplicate-dependency policy remain unenforced (see the
  `cargo-deny` alternative below).
- One more daily workflow run. The job installs a prebuilt `cargo-audit` and
  compiles nothing, so it holds no `Swatinem/rust-cache` entry and no macOS
  slot.

**Mitigation / watch signal.** Revisit if the tracking issue accumulates
findings nobody triages, or if an entry in `.cargo/audit.toml` has its
`review-by` date pushed forward more than twice — both indicate the reporting
path has stopped producing decisions.

## Alternatives considered

- **`cargo-deny` instead of `cargo audit`.** It covers advisories *and*
  licences *and* duplicate dependencies, and the licence axis is genuinely
  relevant here (CLAUDE.md's "License Policy" splits the SDK layer as MIT and
  a future application layer as AGPL-3.0-only). Rejected for now on scope:
  the ticket-driving problem is advisory blindness, licence policy is not
  currently violated by anything, and `cargo-deny`'s licence and bans
  sections need a `deny.toml` allowlist covering all 749 lockfile entries
  before its first run is green. Adopting it later is a `deny.toml` plus a
  tool swap in one workflow, and the reporting, scope, and ignore-hygiene
  layers in `scripts/audit-advisories.py` are tool-agnostic.
- **`rustsec/audit-check` (the RustSec-published action).** It runs the same
  scanner and can file issues, but it files one issue per advisory per run
  and offers no way to express the two project-specific decisions this ADR
  makes: dev-vs-runtime scope and an ignore list with enforced review dates.
  A rolling issue plus a small script keeps those decisions in the
  repository rather than in an action's defaults.
- **Fail the build on any advisory, scheduled or not.** Structurally
  simplest, and it would have made `main` red from the first run for
  `quick-xml` and `time` with no fix available. Rejected as the
  always-on-signal failure mode described above.
- **Schedule only, no `pull_request` trigger.** Cheaper, and the ticket
  treated the PR run as optional. Rejected because it leaves a one-day window
  in which a merged bump onto a vulnerable version is undetected, and because
  the PR run is what makes `/dependabot-review`'s advisory step structural
  rather than a manual habit.
- **Add the job to `ci.yml`.** `ci.yml` already carries nine jobs and runs on
  every PR; this check is meaningful only when the dependency graph changes,
  and it needs `issues: write` for the scheduled path, which `ci.yml`'s
  fail-closed `contents: read` default deliberately withholds.

## References

- `.github/workflows/dependency-audit.yml` — the workflow this ADR backs.
- `scripts/audit-advisories.py` and `scripts/test_audit_advisories.py` — the
  scope, base-branch subtraction, and ignore-hygiene logic.
- `.cargo/audit.toml` — the ignore list and the contract for adding to it.
- [`dependency-advisories.md`](../../.claude/rules/dependency-advisories.md)
  — the operational rule this ADR produced.
- `.claude/commands/dependabot-review.md` step 3 — the pre-existing,
  PR-conditional advisory check that this workflow makes unconditional.
- `.github/dependabot.yml` — the five-open-PR limit that silences the
  ecosystem's updates, recorded in its own header comment.
- [#2774](https://github.com/koedame/chordsketch/issues/2774) /
  [#2750](https://github.com/koedame/chordsketch/pull/2750) /
  [ADR-0044](0044-pre-1.0-breaking-changes-are-expected.md) — the MSRV
  decision that kept RUSTSEC-2026-0187 unfixed for 71 days.
- [ADR-0041](0041-readme-smoke-scoped-to-readme-prs.md) — the
  failure-mode-to-detector alignment and the enumerable-inputs test this
  workflow's triggers reuse.
- Watch signal: an untriaged tracking issue, or an ignore entry whose
  `review-by` date is extended more than twice.
