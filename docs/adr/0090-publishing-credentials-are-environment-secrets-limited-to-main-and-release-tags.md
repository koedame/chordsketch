# 0090. Publishing credentials are environment secrets, and their environments admit only `main` and release tags

- **Status**: Accepted
- **Date**: 2026-10-29
- **Amends**: [ADR-0001](0001-kotlin-maven-central-publishing-credentials.md)

## Context

ADR-0001 and the comments in `kotlin.yml` and `docker.yml` described the
publishing credentials as scoped to a GitHub environment, so that pull-request
runs and unrelated jobs cannot read them. They were repository secrets: a
repository secret is readable by any workflow in any branch of the repository
through `secrets.NAME`, so the scoping the documents described did not exist.
An environment secret is only handed to a job that names the environment, and
an environment can limit which refs may name it.

Four of the environments had no ref rule at all, so even an environment secret
would have been readable from any branch that wrote `environment:` in a job.

## Decision

1. **Every credential a release publishes with is an environment secret**, in
   the environment of the channel that uses it: `docker-hub`,
   `vscode-marketplace`, `open-vsx`, `maven-central`, `chocolatey`, `snap-store`,
   `aur`, `tap-publish` (the Homebrew tap and Scoop bucket share one token),
   `desktop-signing` and `flathub`. The repository secrets keep only what
   pull-request-driven automation needs: `CLAUDE_PAT` and
   `CLAUDE_CODE_OAUTH_TOKEN`.
2. **Each of those environments admits only `main` and the release tags**
   (`v*`; `desktop-v*` for the desktop channels), through its deployment
   branches and tags rule. The two OIDC-only environments that had no rule
   (`pypi`, `rubygems`) get the same rule so a branch cannot mint a publish
   token either.
3. **A job names exactly one environment.** A job that needed secrets from two
   channels is split (`release-credentials.yml` has one job per environment).
4. **A repository secret that duplicates an environment secret is deleted.**
   An environment secret shadows it only for jobs that name the environment, so
   the leftover would still serve every other job.
5. `docs/releasing.md` lists each secret with its environment, and the
   commands to add a channel.

## Consequences

**Positive**

- A branch pushed to the repository, a pull request from it, and the review
  automation's commits cannot read a publishing credential.
- Rotation and setup commands name the environment, so a rotated value cannot
  land back in the repository list by habit.

**Negative**

- A release from any other ref (a release branch, a fork) cannot publish. Adding
  one means adding the ref to the environments.
- `main` can still read every credential: anything merged to `main` that names
  an environment runs with it. The merge queue and review are the control there.
- `CLAUDE_PAT` stays a repository secret, so a workflow on any branch can read
  it. It cannot move without breaking the pull-request automation.

## Alternatives considered

- **Required reviewers on the environments** — not adopted. The release is a
  single maintainer's action, so an approval is the same person clicking again.
- **One environment holding every credential** — rejected: one job could read
  all of them, and the per-channel names would stop documenting which job uses
  which credential.
