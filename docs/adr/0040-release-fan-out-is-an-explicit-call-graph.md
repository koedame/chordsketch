# 0040. Release fan-out is an explicit call graph, not a `release: published` broadcast

- **Status**: Accepted
- **Date**: 2026-08-30

## Context

The library release pipeline had two entry points and one broadcast:

```
push tag v*         → release.yml         ─┐
push tag desktop-v* → desktop-release.yml ─┘→ gh release create
                                             → release: [published]
                                                → 8 workflows, no filter
```

The entry points are fine. `push: tags:` is filtered by GitHub itself, so
`release.yml` has never seen a `desktop-v*` tag and `desktop-release.yml`
has never seen a `v*` one.

`release: [published]` has no equivalent filter, and no ordering. Eight
workflows subscribed to it — `docker.yml`, `napi.yml`, `npm-publish.yml`,
`npm-publish-tree-sitter.yml`, `post-release.yml`, `readme-smoke.yml`,
`release-verify.yml`, `vscode-extension.yml` — and every release woke all
eight at once. Three independent defects came out of that single edge.

### 1. The tag namespace leaked

`desktop-v0.5.0` started all eight library workflows. Five failed on
`Validate release tag` / `Derive version from git tag`, which enforce the
`v<major>.<minor>.<patch>` CLI form: `docker.yml`, `npm-publish.yml`,
`npm-publish-tree-sitter.yml`, `release-verify.yml`, `napi.yml`.
`desktop-v0.4.0` failed the same way. Only `post-release.yml` had a guard
(a `detect-tag-type` job added in #2079); the other seven never got one.

### 2. Publish and verify raced

`release-verify.yml` queries every registry for the released version. It
was woken by the *same* event as the workflows that do the publishing, so
it read the registries while they were still writing. Measured on
`v0.5.0`:

| Job | Time (UTC) |
|---|---|
| `Verify open-vsx` records FAIL | 08:30:28–08:30:36 |
| `Publish to Open VSX Registry` starts | 08:31:16 |
| Open VSX serves 0.5.0 | 08:31:36 |
| `Rollup summary` aggregates the stale FAIL → red | 08:31:19 |

The verify job read the registry 40 seconds before the publish job even
started, and there is no wait or retry anywhere in that workflow.

### 3. Failures were masked

`vscode-extension.yml` carried `continue-on-error: true` on
`build-platform`, `publish`, and `publish-openvsx`. On `desktop-v0.5.0`
nine of that workflow's ten jobs failed — all seven `build-platform`
matrix cells plus both publish jobs; only the tag-agnostic `Build &
Package Extension` CI job passed — and the run was still reported ✅.
The "five workflows failed" count above is therefore an undercount.

The three compound. On `v0.5.0`, `Publish to Open VSX Registry` genuinely
failed — and was green because of (3), while `release-verify` was red
because of (2), i.e. the one workflow that should have caught it was
already red for unrelated reasons. `release-verify` has failed 12 of its
13 runs; a permanently red check is one nobody reads.

`desktop-release.yml` already had the shape this ADR generalises: its
downstream work (`update-cask`, `publish-updater-manifest`) hangs off
`needs: [release]` in the same run and has never used the release event.
The library release was the outlier.

## Decision

**Replace the `release: [published]` broadcast with an explicit call graph
rooted at the tag-filtered entry point.**

1. **`release.yml` orchestrates.** After the `release` job creates the
   GitHub Release, it calls each downstream workflow with
   `uses: ./.github/workflows/<name>.yml` and `needs: [release]`. It
   exports `tag` (v-prefixed, already format-validated) and `version`
   (bare) as job outputs; those are the whole contract.

2. **The six publishing workflows become reusable.** `docker.yml`,
   `napi.yml`, `npm-publish.yml`, `npm-publish-tree-sitter.yml`,
   `post-release.yml`, and `vscode-extension.yml` drop `release:` and gain
   `workflow_call`. `workflow_dispatch` stays on all six as the
   re-run-one-channel entry point.

3. **`inputs.tag` is the release-mode discriminator**, not the event name.
   Under `workflow_call` the `github.event_name` a callee sees is the
   *caller's* (`push`, for a tag push), which is indistinguishable from a
   push to `main`. `napi.yml` and `vscode-extension.yml` are dual-purpose
   (PR CI + release), so they gate their release-only jobs on
   `inputs.tag != ''`.

4. **`post-release.yml`'s `detect-tag-type` job is deleted.** Tag routing
   now happens once, at the entry point, for all channels.

5. **`release-verify.yml` leaves the release path entirely** and runs on
   `schedule` (daily 07:00 UTC) + `workflow_dispatch`. Its `gh release
   list` fallback is filtered to `^v[0-9]` so a scheduled run cannot pick
   up a `desktop-v*` tag. `docs/releasing.md` gains an explicit dispatch
   step at the end of the checklist.

6. **`readme-smoke.yml` drops `release:`** and keeps its daily cron, PR,
   and dispatch triggers.

7. **`continue-on-error: true` is removed from all three
   `vscode-extension.yml` jobs.** A failed matrix cell now fails the job,
   skips the publish jobs, and turns the release run red.

8. **`RELEASE_DISPATCH_TOKEN` is retired.** Both `gh release create` calls
   go back to `GITHUB_TOKEN`. This supersedes ADR-0009, whose entire
   subject was making the broadcast fire.

## Rationale

### Why the call graph fixes all three defects at the root

- **Namespace.** The graph is rooted at `release.yml`, whose `push: tags:
  v*` filter GitHub evaluates. A `desktop-v*` push cannot reach any node
  in it. This is not a guard that has to be repeated in each workflow and
  can be forgotten in the next one — the eighth workflow to be added
  inherits it by being in the graph.
- **Ordering.** `needs: [release]` is the ordering, expressed once.
- **Masking.** With the fan-out under one run, a failed publish colours
  the release run directly, so `continue-on-error` is no longer buying
  anything that would otherwise be invisible.

The alternative fix — adding
`startsWith(github.event.release.tag_name, 'v')` to each of the eight —
addresses defect 1 only, leaves 2 and 3 untouched, and adds an eighth
copy of a condition that has to stay in sync by hand.

### Why the PAT goes

ADR-0009's decision existed for exactly one reason: GitHub suppresses the
`release: published` event for releases created by `GITHUB_TOKEN`, so the
broadcast never fired. With no subscribers left, the PAT buys nothing and
costs a 90-day rotation whose miss is a hard release blocker (the
fail-loud assert ADR-0009 mandated). Keeping a credential whose purpose
has been removed is strictly worse than removing it.

`desktop-release.yml` used the same PAT for the same reason, and never
needed it either — its downstream jobs were always in-graph.

### Why `release-verify` moved off the release path instead of to the end of the graph

Ordering it after the publish jobs would fix the Open VSX race, but not
the rest of the red. Most of the channels in `ci/release-channels.toml`
are not published by this graph at all:

- crates.io (9 crates) and every npm package are published by hand
  *after* the tag (`docs/releasing.md` steps 6–7, ADR-0008).
- PyPI / RubyGems / Maven Central are published by `python.yml` /
  `ruby.yml` / `kotlin.yml`, which fire on the same `push: tags: v*` and
  race the release rather than following it.

"Has every channel converged?" is therefore not answerable at tag time
under any ordering, and asking it there is what produced the 12/13 red.
A daily sweep answers it correctly and goes green on its own once the
maintainer finishes the checklist; a red day *during* an unfinished
release is an accurate report, not noise. The release-time question —
"did this run's publishes work?" — is answered by the run itself now that
decision 7 has removed the masking.

### Known limitation, deliberately not addressed here

`python.yml`, `ruby.yml`, `kotlin.yml`, and `swift.yml` still trigger
independently on `push: tags: v*`. They are correctly tag-filtered (they
have never misfired on `desktop-v*`) but they are not ordered against the
release. The visible cost is `post-release.yml`'s `update-swift-package`
job, which polls up to 30 minutes for the xcframework asset that
`swift.yml` uploads in a parallel run. Folding those four into the graph
would remove that poll. It is a separate change with its own blast radius
and is not bundled here.

## Consequences

**Accepted:**

- One release is now one workflow run with roughly 50 jobs instead of nine
  runs. Deep-linking to "the Docker run for v0.5.0" becomes "the docker
  job group inside the v0.5.0 release run". The run limit is 256 jobs, so
  there is headroom, but a future channel addition should re-check.
- A failed VS Code matrix cell now blocks the extension publish entirely
  rather than publishing the remaining platforms. This is intentional
  (fail closed, and loudly) and matches `release.yml`'s own `build` job,
  but it is stricter than the #1795 behaviour it replaces.
- Removing `continue-on-error` from the environment-gated publish jobs
  means a missing `vscode-marketplace` / `open-vsx` environment fails the
  release. The pre-release checklist already requires those environments
  to exist; a fork without them will see a red release job.
- `release-verify` no longer writes its channel table into the release
  body at publication time. The first scheduled run after the maintainer
  finishes publishing writes it instead — later, but accurate, where the
  old table recorded "nothing is published yet".

**Gained:**

- `desktop-v*` releases cannot start library workflows. This is
  structural, not a guard to maintain.
- Publish-then-verify ordering exists where it is needed and is not
  claimed where it cannot hold.
- A failed publish is visible in the run that performed it.
- One fewer long-lived credential and one fewer rotation deadline that
  can block a release.
- Tag validation and version derivation happen once, at the entry point,
  instead of being re-derived in eight workflows from three different
  sources (`inputs.tag`, `github.event.release.tag_name`,
  `github.ref_name`).

**Mitigations:**

- `actionlint` resolves `uses: ./.github/workflows/*.yml` and fails on a
  missing `workflow_call` trigger or an unsupplied required input, so the
  graph is statically checked.
- Each callee keeps its `Validate release tag` step. The `workflow_call`
  path arrives pre-validated; the check is what guards the
  user-supplied `workflow_dispatch` path.
- Each caller job grants the union of the permissions its callee's jobs
  declare. A called workflow can only narrow the caller's token, so
  under-granting is a silent publish failure — this is the one part of
  the wiring that static analysis does not catch.

## Alternatives considered

1. **Per-workflow tag guards** (`startsWith(github.event.release.tag_name,
   'v')` in each of the eight). Rejected — fixes one of three defects,
   and creates an eighth hand-synchronised copy of the same condition.
   `release-verify.yml` would additionally need the guard repeated on its
   `always()` summary job, since a skipped dependency still runs it.

2. **Keep the broadcast, add a `wait-for-publish` step to
   `release-verify`.** Rejected — a poll is a band-aid over a missing
   ordering edge, it cannot know what it is waiting for (some channels
   are published by hand hours later), and it introduces a timeout as a
   new failure mode.

3. **`workflow_run` cascade.** Rejected for the same reasons ADR-0009
   gave: it runs against the default branch HEAD rather than the tag, and
   fires on `completed` rather than `success`, so every downstream
   workflow needs a conclusion check it can forget. `workflow_call`
   passes the tag explicitly and inherits failure propagation for free.

4. **Move everything to `push: tags: v*`.** Rejected — this is the option
   ADR-0009 rejected, and correctly: the downstream workflows would then
   race `release.yml`'s asset upload, which is the same class of bug as
   defect 2. `workflow_call` from `needs: [release]` gets tag filtering
   *and* ordering; `push: tags:` gets only the filtering.

5. **Keep `RELEASE_DISPATCH_TOKEN` as a no-op.** Rejected — the rotation
   is a live release blocker (a missed rotation fails the assert step)
   with nothing on the other side of the trade.

## References

- ADR-0009 — superseded by this ADR. Its problem statement (the
  `GITHUB_TOKEN` anti-recursion rule) is still accurate; only the chosen
  remedy is replaced.
- ADR-0008 — npm publishing is maintainer-local. The reason
  `release-verify` cannot be green at tag time.
- `desktop-release.yml` — the in-graph shape this ADR generalises to the
  library release.
- GitHub Actions docs, reusable workflows:
  <https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows>
- GitHub Actions docs, `GITHUB_TOKEN` cascade rule:
  <https://docs.github.com/en/actions/security-for-github-actions/security-guides/automatic-token-authentication#using-the-github_token-in-a-workflow>
- Watch signal: adding a ninth publishing channel. It joins the graph as
  a `needs: [release]` caller job; it must not reintroduce a
  `release: [published]` trigger.
- Watch signal: the job count of a release run approaching 256.
