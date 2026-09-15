# 0068. Releases run through one script that proves every channel can publish before the tag is pushed

- **Status**: Accepted (the local crates.io and npm publish of Decisions 1, 2 and 4 moved into CI by ADR-0069 on 2026-09-15)
- **Date**: 2026-09-14

## Context

A workspace release reaches about thirty registries along two paths.
Pushing the `vX.Y.Z` / `desktop-vX.Y.Z` tags starts the CI path
(ADR-0039): GitHub Releases, GHCR, Docker Hub, the VS Code Marketplace,
Open VSX, Homebrew, Scoop, AUR, Snap, Chocolatey, PyPI, RubyGems, Maven
Central, CocoaPods and the Swift package. crates.io and every npm package
are published by hand from the maintainer's machine afterwards
(ADR-0008). `docs/releasing.md` described both as a checklist, with a
"pre-release sanity" section in front of it that checked that each
release secret *exists*.

v0.6.0 showed what that checklist cannot prevent. The tag went out with
every sanity check green, and then:

- the Docker Hub copy failed with `unauthorized: personal access token is
  expired`, and the VS Code Marketplace publish with `Access Denied: The
  Personal Access Token used has expired`. Both secrets were present, so
  the presence check had passed; both tokens had been set in April and
  had expired since.
- crates.io and npm waited on the maintainer, who was not at the release
  machine.

The result was a release that is neither out nor not out: 0.6.0 on
fifteen channels, 0.5.0 on Docker Hub, the Marketplace, crates.io and
npm. No channel can take its 0.6.0 back, so the only way forward is to
finish, and every remaining step needs the maintainer's hands — which is
exactly the dependency the checklist had left until after the point of no
return.

Every failure above was knowable before the tag: a token can be asked
whether a service still accepts it, a login can be checked, a crate can be
packaged and a wasm package built without publishing either.

## Decision

1. **`scripts/release.py X.Y.Z` is the release.** It replaces the hand-run
   steps 4-8 of `docs/releasing.md`: push the tags, wait for the tag runs,
   publish the pending crates, publish the pending npm packages, dispatch
   `release-verify.yml`.
2. **Nothing is published until every question answerable without
   publishing has been answered yes.** Before pushing a tag the script
   checks the release commit (at the version, dated CHANGELOG heading,
   version consistency), that `ci.yml` passed on the commit, that no
   registry serves the version yet, that the local crates.io token and
   npm login are live and own the packages, that every pending crate
   packages (`cargo publish --dry-run` over all of them together) and
   every pending npm package builds and packs, and that every CI
   credential is accepted. All failures are reported
   together, and the run exits without side effects.
3. **CI credentials are checked against the services, not for presence.**
   `.github/workflows/release-credentials.yml` resolves each secret the
   way its publish job does and makes a read-only authenticated call:
   a push-scoped Docker Hub registry token, `vsce verify-pat`,
   `ovsx verify-pat`, a Central Portal API call plus a GPG test signature,
   the CocoaPods trunk session, `git push --dry-run` for the GitHub
   tokens, AUR `list-repos`, `snapcraft whoami`. The Chocolatey API key
   and the Tauri updater key have no read-only check and no expiry, so
   those two are checked for presence only.
4. **Local publishing waits for CI to converge.** After the tag runs
   finish, crates.io and npm are published only if every CI-published
   channel serves the version, the GitHub Release exists and Desktop
   Release succeeded. A CI failure that needs a code fix may end in a new
   patch version, and the crates and npm packages of an abandoned version
   would be the most permanent half of it.
5. **The registries are the state.** The script keeps no state file. Each
   run asks every registry what it serves, so a re-run resumes an
   interrupted release from what is missing, and refuses a version that is
   already fully released or that some registry already serves without a
   tag.

## Rationale

The v0.6.0 failures were all of one shape: a precondition that held at no
point during the release, discovered only when the step that needed it ran
after the tag. Moving every such precondition in front of the tag removes
that shape rather than one instance of it. A token that expires between
the preflight and its use is still possible, but the window is the length
of one release instead of the months since the last one.

Checking a token against its service is the only check that would have
caught v0.6.0: `DOCKERHUB_TOKEN` and `VSCE_PAT` were set, non-empty and
scoped correctly. The checks are read-only by construction — verification
endpoints, token requests, a dry-run push that sends no objects — so the
workflow can run on every release, or at any time, without touching a
registry.

The dry runs are the same argument applied to the local path.
`cargo publish` with several `-p` flags (Cargo 1.90+) packages and builds
every crate against a local overlay registry before it uploads the first
one, so a crate that does not package cannot leave the ones before it
published. Running the same command with `--dry-run` in the preflight moves
that failure in front of the tag as well.

Deriving the channel list from `ci/release-channels.toml` keeps the script
from drifting from the rollup that judges the release: the crates it
publishes are the manifest's crates.io channels, every npm channel needs a
publish recipe (a unit test fails otherwise), and "is this channel done"
is answered by the same `verify_channel` that `release-verify.yml` uses.

## Consequences

- A release is one command and one confirmation, plus an npm one-time
  password per package when the account uses 2FA. The script waits
  through the tag runs, so it stays running for as long as the CI publish
  takes.
- The preflight takes minutes, not seconds: it dispatches a workflow
  (Snap's check installs snapcraft) and builds the wasm packages. That is
  the cost of catching a broken build before the tag instead of after.
- crates.io does not reveal a scoped token's scopes, so the script can
  prove the token is live but not that it may `publish-new` a crate that
  has never been published. It says so in the preflight output and names
  the new crates. A token without that scope fails at the new crate's
  upload, after the crates it depends on are already up; that is the one
  local failure the preflight cannot move in front of the tag, and a re-run
  with a corrected token resumes from the new crate.
- A CI channel that failed after the tag is not re-run by the script. The
  per-workflow re-run paths are not idempotent (Open VSX refuses a
  version it already has, `swift.yml` replaces the XCFramework asset and
  its checksum), so the script reports the channel and stops before local
  publishing; the maintainer re-runs it per `docs/releasing.md` step 8 and
  re-runs the script, which resumes.
- winget, MacPorts and nixpkgs stay manual. They are pull requests to
  other projects, not publishes.

## Alternatives considered

- **Keep the checklist and add token rotation reminders.**
  `DOCKERHUB_TOKEN` was already on a documented 90-day rotation cadence
  and expired anyway; a reminder is another thing to forget, and it does
  not cover a revoked token or a wrong scope.
- **Presence checks only, in the script.** This is what the pre-release
  sanity section already did, and it passed on v0.6.0.
- **Move crates.io and npm publishing into CI with trusted publishing.**
  It would remove the maintainer from the release entirely, but it
  reopens ADR-0008 — CI could not create new npm packages, and the first
  publish of a crate still cannot use trusted publishing — and it does not
  address the expired CI tokens, which were the part of v0.6.0 that no
  maintainer action at release time could have fixed. It can be revisited
  on its own; the preflight stays useful either way.
- **Publish locally first, then push the tag.** The local packages would
  then be the ones exposed to a CI failure, and crates.io has no unpublish.
  CI failures after a green credential check are the rarer kind, but the
  crates of an abandoned version are the more permanent kind.
- **Record progress in a state file to resume.** A state file can
  disagree with the registries — after a manual publish, a re-run in CI,
  or on a second machine. Asking the registries is slower by seconds and
  cannot disagree with them.

## References

- ADR-0008 — npm publishing is a maintainer-local manual operation
- ADR-0039 — release fan-out is an explicit `workflow_call` graph
- v0.6.0 release run: https://github.com/koedame/chordsketch/actions/runs/34770974199
- `scripts/release.py`, `scripts/test_release.py`
- `.github/workflows/release-credentials.yml`
- Watch signal: a release failing on a precondition the preflight did not
  check — add the check to the preflight rather than to the checklist.
