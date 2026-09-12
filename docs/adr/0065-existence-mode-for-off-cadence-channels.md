# 0065. `expected_version = "exists"` watches channels no smoke job installs

- **Status**: Accepted
- **Date**: 2026-09-13

## Context

`@chordsketch/chordpro-lite` was published on 2026-09-12 (ADR-0060). Nothing
in this repository then asked npm whether it was still there.

`chordpro-lite.yml` builds, typechecks and tests the package **from the
workspace**, and `ci.yml`'s `directive-catalog-sync` job holds its generated
directive list against the Rust catalog. Neither says anything about the
registry. The post-release rollup (`scripts/check-release-channels.py`) is the
component that does query registries, daily via `release-verify.yml` — but the
channel carried `expected_version = "skip"`, and `skip` issues no HTTP request
at all. An unpublish, or a scope flipped to restricted, would have left
`npm install @chordsketch/chordpro-lite` — the command the package README
opens with — broken with no red anywhere.

ADR-0064 closed the same hole for the four framework bindings by listing them
in README `## Installation` and giving each a daily `readme-smoke.yml` job
that installs the `latest` dist-tag. That route is unavailable here.
`chordpro-lite` is not an install method for ChordSketch; it is a helper for
consumers that already have the engine, listed in README's packages table
rather than under `## Installation`. `.claude/rules/readme-sync.md` ties
`readme-smoke.yml`'s jobs to the commands `## Installation` advertises, so a
job for a package that is not advertised there would be a job with no
corresponding README contract.

`skip` was never a statement that the channel does not matter — the manifest
uses it for two unrelated situations at once: channels with no publish on this
tag (winget, nixpkgs, MacPorts) and channels that publish on their own cadence.
For the second group tag-equality is false while "is it still served" is a
perfectly checkable truth, and `skip` was throwing that away along with it.

## Decision

`expected_version` gains a third value, `"exists"`: the rollup asserts the
package is still publicly served, and asserts nothing about which version that
is. `npm-chordpro-lite` takes it.

For an npm channel the check resolves `registry.npmjs.org/<pkg>/latest`
anonymously and then fetches the first byte of the `dist.tarball` it points
at. The tarball is the byte stream `npm install` downloads and is served from
a different host than the metadata, so resolving the packument alone is not
yet installability.

The four framework bindings stay on `skip`. `readme-smoke.yml` already
installs each of them daily and server-renders a component from the result —
strictly more than an existence probe — so an `exists` entry for them would be
a second, weaker daily assertion about the same fact. Their `skip_reason`
already records where their coverage lives.

`exists` on a kind with no existence checker is a loud failure naming
`_EXISTS_DISPATCH`, not a silent fall-through to the tag-equality checker:
falling through would assert something the manifest did not ask for.

## Rationale

- An existence check is weaker than an install, and for a package the README
  advertises that gap matters — which is why this is not a replacement for
  ADR-0064's jobs. For a package the README does **not** advertise, the
  comparison is not "existence vs install" but "existence vs nothing".
- The failure being watched for is not subtle. An unpublished or
  access-restricted package answers 404; there is no partially-broken state
  between that and what the tarball fetch covers.
- `"exists"` keeps the manifest honest in the other direction too. `skip`
  requires a `skip_reason` excusing the absence of a check; a channel that can
  be checked should not have to write one.
- The mode costs one HTTP round trip on a workflow that already runs 40 of
  them daily, and it reuses the existing matrix cell, artifact and summary row.

## Consequences

- Unpublishing `@chordsketch/chordpro-lite`, or flipping its access to
  restricted, turns the daily `release-verify.yml` run red the next morning
  with a detail line naming the repair (`npm access set status=public`).
- The rollup summary shows the channel as `✅ OK` with the observed version in
  the Observed column and `<exists>` in Expected, where it previously showed
  `<manual>` / `<skip>`.
- A future off-cadence channel on a kind other than npm needs an entry in
  `_EXISTS_DISPATCH` before it can use the mode. That is deliberate: the
  alternative is a checker that silently does nothing.
- `--force-stale` still exercises the red path for these channels, reporting
  `expected=<exists>` rather than a tag the channel never promised.

## Alternatives considered

**List `@chordsketch/chordpro-lite` under README `## Installation` and give it
a `readme-smoke.yml` job, as ADR-0064 did for the four bindings.** The
strongest possible check: it would install the published tarball and call
`detectFormat` on it. Rejected because it inverts the README decision to get a
CI one. `## Installation` answers "how do I install ChordSketch"; this package
is a dependency a consumer adds alongside the engine, and promoting it there to
obtain registry coverage would advertise it as an install method for the
project. The packages table it already sits in is the accurate placement.

**Assert the registry's `latest` equals `packages/chordpro-lite/package.json`.**
Rejected for the reason ADR-0064 rejected it for the bindings: the package is
published on its own cadence, so the repository is expected to sit ahead of the
registry for weeks, and the check would be red for all of them.

**Leave it on `skip` and rely on the package's own workflow.** That is the
state this ADR replaces. `chordpro-lite.yml` verifies the source tree; no
amount of green there says the artifact is still on npm.

## References

- ADR-0008 — npm publishing is a maintainer-local manual step, which is why a
  package can exist in the tree and not on the registry.
- ADR-0060 — `@chordsketch/chordpro-lite` itself: what it is and why it is
  wasm-free.
- ADR-0064 — the same hole closed for the four framework bindings, whose
  Alternatives section named this mode as the right home for packages that are
  not in `README.md`.
- ADR-0049 — the precedent for a rollup verdict that is not binary; `PENDING`
  is unrelated to `exists` but establishes that the manifest describes the
  question, not just the answer.
- `.claude/rules/readme-sync.md` — why `readme-smoke.yml` covers exactly the
  commands `## Installation` lists.
