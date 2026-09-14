# 0070. Publishability is checked on every pull request, by the same definitions the release uses

- **Status**: Accepted
- **Date**: 2026-09-15

## Context

Two v0.6.0 failures were discovered only when a registry was asked to take
the release:

- crates.io refused `chordsketch-render-pdf` with HTTP 413. It packaged to
  15.6 MiB against a 10 MiB limit because test PDFs had been packaged with
  it, and five of the ten crates were already published when the sixth
  was refused (fixed in #2898).
- The VS Code Marketplace and Open VSX publish jobs failed with
  `tsup: not found` (exit 127) in an `npm ci` step that no pull request
  ever ran, because those jobs only run on a tag (fixed in #2886).

In both cases the code was correct and the repository was nevertheless
unable to publish, and nothing said so between the commit that caused it
and release day. ADR-0068 moved the checks it could in front of the tag,
but its preflight runs once per release, on the maintainer's machine: it
catches the problem on the day it is least convenient to fix, and only for
the packages that release happens to publish.

Two warnings had also been printed and ignored for the same reason — they
were only warnings: `npm publish` rewrote `repository.url` in four
packages, and `cargo package` reported a yanked `Cargo.lock` entry
(`fastrand 2.4.0`, still on `main` when this was written).

## Decision

1. **A required status check, `Publishable`, runs on every pull request,
   every push to `main` and nightly.** It lives in
   `.github/workflows/publishable.yml`, has no `paths:` filter, and is one
   aggregate job that `needs` every per-channel job, so adding a channel
   does not touch branch protection. The nightly run catches what changes
   without a commit: a dependency yanked, a published range that stops
   matching.
2. **The conditions are defined once, in `scripts/_publish_checks.py`, and
   `scripts/release.py` imports them.** The release preflight runs the same
   functions on the release commit, refuses a commit on which
   `publishable.yml` did not pass, and publishes the npm tarballs it
   checked. `docs/publishing-requirements.md` is the human-readable table
   of every condition, its primary source and the function that checks it.
3. **For each package, the check is the publish path minus the upload:**
   build, pack with the tool the release uses, run that tool's dry run,
   inspect the packed artifact, and where the package can be loaded
   without a bundler or a native compile, install it into an empty project
   and load it. Steps that only a publish job runs are moved into a script
   the job and the check both call (the napi staging is the first:
   `crates/napi/scripts/stage-release-tarballs.sh`).
4. **Every warning from a publish tool fails the check**, except the two
   cargo prints on every dry run of a version already on crates.io.
5. **Every package carries only what it declares:** forbidden file names
   and credential patterns fail, and any file over 1 MiB must be declared
   on its package (a declaration that no longer matches also fails).

## Rationale

A precondition that is checked only when it is needed will fail when it
is needed. Checking it on the change that breaks it puts the failure in
front of the person who can fix it, while the change is small, instead of
in front of the maintainer halfway through a release that cannot be taken
back.

One definition for the pull request and the release is what makes the
pull-request check trustworthy. If the preflight kept its own copy, a fix
to one would leave the other passing packages the other refuses, which is
the drift this decision exists to remove.

No `paths:` filter, because a required check must report on every pull
request and because deciding which paths can affect packaging is exactly
the guess that failed: the render-pdf crate grew through test fixtures,
and the Marketplace job broke through another package's install script.

Warnings fail because a publish tool's warning describes something the
registry is already doing differently from what the repository says —
rewriting a manifest, accepting a yanked dependency — and a warning nobody
is made to read is not read.

## Consequences

- Every pull request pays for a `cargo publish --dry-run` of the published
  crates, two release wasm builds, a debug napi build and the npm installs
  — Linux runners only, cached per job.
- On a pull request only the host's native code can be built, so a Linux
  x86_64 build stands in for the other targets of every multi-platform
  artifact — the napi platform packages, the platform VSIXes' language
  server, the gem's and the jar's native libraries, the arm64 container
  image. Those artifacts are staged, packed and checked exactly as at
  release, but only the Linux x86_64 build is loaded. Each release job runs
  the same check against the real per-target builds before it uploads.
- The container image check pulls its pinned Alpine base from Docker Hub on
  every pull request — the registry dependency ADR-0062 declined for the
  from-source `Dockerfile`. The difference is that the release image is a
  published artifact: a registry hiccup failing a pull request is the
  lesser cost next to an image that cannot be built on release day.
- Publish-tool dependencies (the npm registry, crates.io's index, PyPI,
  RubyGems, Maven Central) are in the path of every pull request for the
  same reason.
- The version being published is not checked for uniqueness on a pull
  request: between releases every pull request is at a version that is
  already published. The release preflight still refuses a version a
  registry already serves.
- A package added to `ci/release-channels.toml` without a definition fails
  the self-test job, so it cannot be published unchecked.

## Alternatives considered

- **Extend the release preflight only.** It runs once per release, on one
  machine, for pending packages only — the situation that produced both
  failures.
- **Run each publish workflow's tag-only jobs on pull requests with the
  upload skipped.** Those workflows are `paths:`-filtered, so they cannot
  back a required check, and removing their filters would run every
  channel's full platform matrix on every pull request.
- **Make each existing `paths:`-filtered workflow required.** A required
  check that does not run leaves the pull request pending forever.
