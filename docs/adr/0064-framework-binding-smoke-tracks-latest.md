# 0064. The framework-binding smoke jobs track the `latest` dist-tag

- **Status**: Accepted
- **Date**: 2026-09-12

## Context

`@chordsketch/react` was documented as an npm install from 2026-04, and
`@chordsketch/{react-ui,vue,svelte}` from the day each was added. None of the
four were on npm. `npm install @chordsketch/vue` returned a 404 for months
while `docs/sdk/tasks/embed-{react,vue,svelte}.md` and two package READMEs
told readers to run it. They were published on 2026-09-12.

Nothing in CI could have caught that. `react.yml`, `react-ui.yml`, `vue.yml`
and `svelte.yml` build and test each package **from the workspace**, which
says nothing about the registry. The post-release rollup
(`scripts/check-release-channels.py`) does query npm, but the four channels
registered in `ci/release-channels.toml` carry `expected_version = "skip"`:
the rollup's only assertion is "the registry's newest version equals the
release tag", and these packages version on their own cadence, so the entries
exist to record the channel rather than to check it. `skip` performs no HTTP
request at all.

`readme-smoke.yml` is the workflow that does talk to registries, daily. Its
two existing npm jobs pin an exact version in a job-level `env:` block and
tolerate a release-cut window with a probe-and-skip step, because
`@chordsketch/wasm` and `@chordsketch/wasm-export` ship in lockstep with the
Rust workspace — `scripts/check-version-consistency.py` reads both pins and
fails the PR if either drifts from the canonical crate version.

The framework bindings are not in that lockstep. At the time of writing the
workspace is 0.5.0, `@chordsketch/react` is 0.4.0, and the other three are
0.1.0.

## Decision

`README.md` `## Installation` gains the four install commands, and
`readme-smoke.yml` gains one job per package — `npm-react`, `npm-react-ui`,
`npm-vue`, `npm-svelte` — as `.claude/rules/readme-sync.md` requires of any
command listed there.

Each job installs **the `latest` dist-tag**, by running the literal command
the README documents, with no version pin, no probe-and-skip step, and no
entry in `check-version-consistency.py`'s `_SMOKE_NPM_PINS`.

Beyond `npm install` exiting 0, each job asserts that the published tarball
loads and renders: `<Transpose>` server-rendered to the design-system markup
(`<Button>` / `<Badge>` for the wasm-free `react-ui`), the package's `version`
export, and that the stylesheet subpath every quick start imports resolves.
`@chordsketch/svelte` ships uncompiled `.svelte` sources (ADR-0052), so its
job renders through a Vite SSR build — the same compiler step a consumer's
bundler performs — rather than importing the package straight from Node.

## Rationale

- A pin on a package outside the workspace lockstep is a pin nothing bumps. It
  is invisible to `check-version-consistency.py` by construction, and a release
  cut does not touch it, so it would freeze on one release and keep asserting
  it while the `latest` that users actually install rotted unwatched. That is
  the failure this ADR exists to close, reintroduced one level down.
- Tracking `latest` is also what makes the job the README's test rather than a
  test of its own: the README's command has no version in it.
- No pin means no release-cut window. There is no version that can be ahead of
  the registry, so none of the `::notice::`-and-skip machinery the two pinned
  jobs need applies here.
- The assertions are deliberately shallow — one component, one stylesheet
  path. The engine behind these packages is already covered by `npm-wasm` and
  by each package's own workflow; what was missing was any statement about
  the registry.

## Consequences

- A package that is unpublished, yanked, or published broken turns the daily
  cron red and opens the tracking issue `report-failure` manages. On a pull
  request the four jobs run only under the workflow's `paths:` filter, the
  same as every other job in it (ADR-0041).
- A binding that renames the design-system class or changes `<Transpose>`'s
  markup breaks the smoke on the first day the new version is published,
  after the PR that changed it merged green. The assertion is then updated
  against the published artifact — the one-release lag is inherent to a
  registry watchdog and is why the job is on a daily cron rather than
  gating the PR.
- **Negative**: `latest` is a moving target, so a job can go red for a publish
  no open PR contains. That is the same shape as the twelve other
  published-artifact jobs in this workflow and is what ADR-0041 already
  accounts for.

## Alternatives considered

**Pin each package the way `npm-wasm` does.** Consistent with the two jobs
directly above it in the file, and it would make the smoke deterministic.
Rejected for the first rationale point: the pin would have no bumper. The two
existing pins work because a release cut moves them and a CI guard fails the PR
when it does not — neither mechanism reaches a package that versions off-cycle.

**Assert that the registry's `latest` equals the version in
`packages/<name>/package.json`.** Detects a publish that never happened, which
is exactly the original failure. Rejected: it reopens the release-cut window
the pinned jobs have to paper over, and it reopens it permanently rather than
for the length of one PR, because these packages are published on their own
cadence — the repo is expected to sit ahead of the registry for weeks.

**Teach `check-release-channels.py` an "exists and is public" mode** — a third
verdict between tag-equality and `skip`, so the rollup covers the five `skip`
channels. Rejected as the primary answer: the rollup runs at release time (and
daily via `release-verify.yml`), but an existence check is not an install, and
`readme-sync.md` requires the README's commands to be *executed* by CI
regardless. The two are not exclusive; if the `skip` channels need coverage for
packages that are not in `README.md` — `@chordsketch/chordpro-lite` is the one
today — that mode is the right place for it.

## References

- ADR-0008 — npm publishing is a maintainer-local manual step, which is why a
  package can be advertised before it exists.
- ADR-0029 — `@chordsketch/react-ui` carries no wasm dependency, which is why
  its smoke asserts `<Button>` / `<Badge>` instead of `<Transpose>`.
- ADR-0041 — the measurement behind this workflow's `paths:` filter and its
  daily cron; published-artifact jobs fail for reasons a PR did not cause.
- ADR-0052 — `@chordsketch/svelte` publishes sources, which is why its smoke
  goes through a bundler.
- `.claude/rules/readme-sync.md` — every command under `## Installation` must
  be exercised by `readme-smoke.yml`.
- **Watch signal**: if a binding's markup churns often enough that updating the
  assertion becomes routine maintenance, narrow the assertion to the package's
  `version` export and the stylesheet path rather than dropping the job.
