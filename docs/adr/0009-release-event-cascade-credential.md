# 0009. Release event cascading requires a non-GITHUB_TOKEN credential

- **Status**: Accepted
- **Date**: 2026-04-26

## Context

Eight workflows in `.github/workflows/` listen for the
`release: [published]` event:

- `docker.yml` — pushes Docker images to GHCR + Docker Hub.
- `napi.yml` — builds `.node` artefacts and uploads platform tarballs
  to the GitHub Release (publish itself is maintainer-local per
  [ADR-0008](0008-npm-publishing-is-local.md)).
- `npm-publish.yml` — verifies the `@chordsketch/wasm` build path
  on tagged commits (publish is maintainer-local per ADR-0008).
- `npm-publish-tree-sitter.yml` — same, for `tree-sitter-chordpro`.
- `post-release.yml` — fans out to Homebrew, AUR, Scoop, Snap,
  Flathub, CocoaPods, Swift PM, Chocolatey.
- `readme-smoke.yml` — verifies every install path on every release.
- `release-verify.yml` — verifies release artefact integrity.
- `vscode-extension.yml` — publishes the VS Code / Open VSX extension.

Each is a downstream link in the release pipeline. The intended flow:

1. Maintainer pushes a `v*` tag.
2. `release.yml` (triggered by `push: tags: v*`) builds CLI binaries
   and uploads them to a GitHub Release via `gh release create`.
3. The release is published, the `release: [published]` event fires,
   and the eight workflows above all run automatically.

## Problem discovered

A `gh run list` audit on 2026-04-26 found that **none of the eight
workflows have ever run on a `release` event** — every successful
run was either a `workflow_dispatch` (manually invoked) or another
trigger. This holds across every release tag from `v0.2.0` through
`v0.3.0` and `desktop-v0.3.0`.

The cause is documented in GitHub's own Actions docs:

> When you use the repository's `GITHUB_TOKEN` to perform tasks,
> events triggered by the `GITHUB_TOKEN`, with the exception of
> `workflow_dispatch` and `repository_dispatch`, will not create
> a new workflow run.
>
> — <https://docs.github.com/en/actions/security-for-github-actions/security-guides/automatic-token-authentication#using-the-github_token-in-a-workflow>

`release.yml` line 217 sets `GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}`
for the `gh release create` step. The release IS published — it just
cannot trigger downstream workflows because GitHub considers it an
"action by `GITHUB_TOKEN`" and breaks the cascade to prevent
recursive workflow loops.

`desktop-release.yml` has the same defect at line 227 (its
`gh release create` site).

The visible consequence for `desktop-v0.3.0`:

- Tag pushed 2026-04-25, GitHub Release created the same day.
- None of the eight downstream workflows fired on the release event.
- `@chordsketch/wasm@0.3.0` was never published to npm. The README's
  pinned smoke test `npm install '@chordsketch/wasm@0.3.0'` began
  failing on every PR and on the daily smoke schedule.
- Docker images, Homebrew tap, Scoop bucket, AUR, etc. were all
  silently un-updated until manual `workflow_dispatch` recovery on
  2026-04-26.

The defect was previously masked because every prior release was
followed by a manual `workflow_dispatch` of the affected workflows.
The 2026-04-26 audit caught it because `desktop-v0.3.0` had no
manual recovery scheduled. ADR-0008 reduced the npm publishing
workflows to build/verify only, so this ADR's scope is the
remaining seven workflows (docker, post-release, vscode-extension,
release-verify, readme-smoke, plus the build/verify side of
napi/npm-publish/npm-publish-tree-sitter).

## Decision

1. **Use a dedicated GitHub fine-grained Personal Access Token**,
   named `RELEASE_DISPATCH_TOKEN`, for the `gh release create` calls
   in `release.yml` and `desktop-release.yml`.
2. **The PAT scope is minimal:**
   - Repository access: `koedame/chordsketch` only.
   - Permission: `Contents: Read and write` only.
   - No other repository or org permissions.
3. **No fallback to `GITHUB_TOKEN`.** Both workflows fail loud with
   an explicit `::error::` message if `RELEASE_DISPATCH_TOKEN` is
   unset, rather than silently regressing to the broken state. A
   `secrets.RELEASE_DISPATCH_TOKEN || secrets.GITHUB_TOKEN` pattern
   would re-introduce exactly the silent breakage this ADR exists
   to prevent.
4. **Rotation procedure**: a fresh token is issued every 90 days
   (the longest fine-grained PAT lifetime that does not require
   "no expiration" classifier). Rotation is a maintainer action;
   the rule is documented in `docs/releasing.md` §Token rotation.
5. **The token is NOT shared** with `CLAUDE_PAT`,
   `TAP_GITHUB_TOKEN`, or any other PAT in the repo. Each token's
   blast radius is bounded by its own scope.
6. **Only the `gh release create` step uses
   `RELEASE_DISPATCH_TOKEN`.** All other `gh` calls in
   `release.yml` and `desktop-release.yml` (release downloads,
   asset uploads after publication, branch pushes for the updater
   manifest) keep using `GITHUB_TOKEN`. They run *after* the
   release is already published, so they cannot accidentally
   trigger an additional cascade — and using the broader PAT for
   them would unnecessarily widen the credential exposure.

## Rationale

### Why not `workflow_run`?

`workflow_run` is the documented alternative when `GITHUB_TOKEN`
cannot trigger downstream events. Tradeoffs that made it the wrong
fit here:

- `workflow_run` runs against the **default branch HEAD**, not
  the tag's commit. To publish the actual tagged version, every
  downstream workflow needs a manual `actions/checkout` with
  `ref: refs/tags/${TAG}`, and the tag must be derived from the
  `workflow_run` payload. That is eight separate workflow YAML
  edits and eight places where a mistake produces a silently
  wrong publish.
- `workflow_run` only fires on `completed`, not `success`. The
  downstream workflow has to inspect
  `github.event.workflow_run.conclusion` and short-circuit on
  failure. Forgetting that gate produces publishes against a
  partially-failed release.
- The PAT swap is a single-line change in two files. The
  `workflow_run` approach is sixteen-plus lines across eight
  files.

### Why not `push: tags: 'v*'`?

Switching every downstream workflow to `push: tags` triggers them
at the **same time** as `release.yml` itself. The race window is:

- `release.yml` builds artefacts and uploads to the Release.
- A downstream workflow (e.g. `napi.yml`) starts in parallel,
  attempts `gh release download v0.3.0`, gets the artefacts as
  they exist mid-upload — possibly partial, possibly missing.

A `wait-for-release` polling step would close the race, but adds
state to every downstream workflow and another failure mode
(timeout). The PAT swap leaves the existing event-driven
semantics intact.

### Why a fine-grained PAT and not a GitHub App?

A GitHub App would give the cleanest long-term solution: no
expiration, scoped per-event, audited per-installation. The
implementation cost is non-trivial — App registration, installation
token retrieval via JWT in CI, secrets for the App private key plus
ID. For a one-maintainer project the operational complexity
outweighs the rotation-frequency benefit.

If the project ever adds a second maintainer or a public
"contributors-can-release" surface, revisit this in a successor
ADR.

### Why no fallback to `GITHUB_TOKEN`?

The decisive lesson from this incident is that the failure mode is
**silent**: the release publishes, the workflow shows green, and
the missing cascade only surfaces when a downstream channel goes
stale (in this case ten-plus days later — the `desktop-v0.3.0`
auto-update was inert for 36 hours before manual recovery).

A fallback expression `secrets.RELEASE_DISPATCH_TOKEN ||
secrets.GITHUB_TOKEN` re-introduces exactly that silent path the
moment the PAT secret is unset, expired, or rotated incorrectly.

Failing loud — the workflow refuses to run because the secret is
missing — is the desired behaviour. The maintainer fixes the
secret and re-runs.

### Why only the `gh release create` step?

Six other `GH_TOKEN` sites exist in `desktop-release.yml` (lines
316, 434, 468, 528, 590) and they all run after the release is
already created. They read assets, push to a manifest branch, or
upload additional files. None of them fires
`release: [published]` again — that event is one-shot per release.
Switching them to `RELEASE_DISPATCH_TOKEN` would be cargo-culting:
broader PAT exposure for no behavioural benefit. They keep
`GITHUB_TOKEN`.

## Consequences

**Accepted:**

- A new secret to manage with a 90-day rotation cadence. Mitigation:
  the rotation procedure is documented and the PAT's scope is
  minimal, so a missed rotation produces a clear `RELEASE_DISPATCH_TOKEN
  unset` error rather than silent dataloss.
- The release pipeline depends on a maintainer-owned credential
  outside `GITHUB_TOKEN`. If the maintainer's account is
  compromised, the attacker can publish arbitrary content under
  any of the 8 channels. Mitigation: 2FA on the GitHub account,
  PAT scoped to a single repo and a single permission, and the
  publishing channels themselves require their own secondary
  credentials (`DOCKERHUB_TOKEN`, `TAP_GITHUB_TOKEN`, `VSCE_PAT`,
  etc.) which an attacker would still need.

**Gained:**

- All eight release-event workflows function as designed without
  manual `workflow_dispatch` recovery. The publishing pipeline
  becomes observably reliable rather than secretly half-broken.
- The `readme-smoke.yml` daily check becomes a real signal again —
  a green smoke run after a release means the new version is
  actually installable from every channel.
- `release-verify.yml` becomes load-bearing: it catches the case
  where a release publishes but a downstream channel quietly
  fails. Until 2026-04-26 it had never run.

**Mitigations:**

- The fail-fast `Assert RELEASE_DISPATCH_TOKEN is present` step
  (added in this PR's release.yml and desktop-release.yml diffs)
  catches missing-secret cases at workflow start, not at the
  `gh release create` failure point. The error message names the
  ADR and the remediation command.
- Token rotation is a `docs/releasing.md` checklist item; missing
  rotation produces a CI failure on the next release attempt,
  which is louder than silent breakage.

## Alternatives considered

1. **`workflow_run` cascade.** Rejected — see "Why not
   `workflow_run`?" Too much per-workflow state and lost tag
   context.

2. **`push: tags: 'v*'` on every downstream workflow.** Rejected —
   race condition with `release.yml`'s artefact upload, and the
   `wait-for-release` polling adds eight places that can timeout
   wrong.

3. **GitHub App.** Rejected for now — operational complexity
   outweighs the benefit at the project's current scale. Revisit
   if the maintainer count grows.

4. **Reuse `CLAUDE_PAT` or `TAP_GITHUB_TOKEN`.** Rejected — token
   reuse couples blast radii. A compromise of the release token
   should not invalidate the review-bot token, and vice versa.

5. **Continue manual `workflow_dispatch` recovery after every
   release.** Rejected — that is the status quo, and it caused
   the `desktop-v0.3.0` defect by going un-recovered for 36
   hours. Automation that requires a manual recovery step is not
   automation.

## References

- Issue #2276 — this ADR's tracking issue.
- ADR-0008 — npm publishing is local-only. Independent decision
  but in the same release pipeline; cross-reference because both
  touch the publishing flow.
- GitHub Actions docs on `GITHUB_TOKEN` cascade rules:
  <https://docs.github.com/en/actions/security-for-github-actions/security-guides/automatic-token-authentication#using-the-github_token-in-a-workflow>
- `release.yml` line 217 — original `GH_TOKEN: secrets.GITHUB_TOKEN`
  site that this ADR replaces.
- `desktop-release.yml` line 227 — sibling site.
- The 5 other `GH_TOKEN` sites in `desktop-release.yml`
  (316, 434, 468, 528, 590) — intentionally unchanged; see
  Decision step 6.
