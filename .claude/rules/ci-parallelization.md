# CI Parallelization and Fan-in Discipline

Codifies the patterns discovered during the CI parallelization audit
(see issues #1461–#1465). Apply these rules when adding or modifying any
`.github/workflows/*.yml` file.

## 1. Fan-in discipline

A job's `needs:` MUST list only the jobs whose artifacts the downstream job
actually downloads or depends on. Do NOT use `needs:` as a coarse
"wait for phase X" barrier.

**Ask for every `needs:` edge:** "What file does this job read that would not
exist without the upstream job?" Only jobs that produce such files belong in
`needs:`.

**Antipattern:** if job B consumes only the linux-x64 artifact, it MUST NOT
`needs:` Windows or macOS build cells — those cells produce artifacts B never
reads, so the edge only adds unnecessary blocking time.

**Worked example (ruby.yml, kotlin.yml after #1461):**
```yaml
generate-and-test:
  needs: [build-native-linux-x64]   # only linux-x64 artifact is consumed here
  ...

publish:
  needs: [build-native-linux-x64, build-native-others, generate-and-test]
  # publish needs ALL artifacts, so all edges are legitimate
```

## 2. `rust-cache` — frequency-aware

Every Rust-compiling job (any step that invokes `cargo build/test/clippy/doc`,
or a tool that internally runs cargo: maturin, napi-rs, wasm-pack, cross) SHOULD
include `Swatinem/rust-cache` with a meaningful `shared-key` — **unless** the
workflow runs less often than once per 7 days.

GitHub Actions cache entries are evicted by LRU after 7 days of inactivity.
Cache additions to infrequent workflows deliver no wall-clock benefit and add
YAML noise.

**Required (workflows that run at least weekly):**
`ci.yml`, `wasm.yml`, `python.yml`, `ruby.yml`, `kotlin.yml`, `swift.yml`,
`napi.yml`, `ffi.yml`, `deploy-playground.yml`, `readme-smoke.yml`

**Intentionally omitted (infrequent — cache expires before next run):**
- `release.yml` — ~every 10 days on version tags
- `desktop-release.yml` — fires on `desktop-v*` tag pushes; expected
  cadence comparable to `release.yml` and below the 7-day cache TTL
- `npm-publish.yml` — a few times per month
- `extended-tests.yml` — dispatch-only, rarely invoked

Workflows in the "intentionally omitted" category SHOULD have a YAML comment
explaining the frequency-based rationale so future contributors do not
re-propose adding cache.

The `shared-key` SHOULD include the target triple when the job compiles for a
specific target, to avoid cache thrashing across targets:
```yaml
- uses: Swatinem/rust-cache@...
  with:
    shared-key: kotlin-x86_64-unknown-linux-gnu
```

### Tool-version single source of truth

Tool versions that multiple workflows pin SHOULD live in exactly one
location so a bump in one place does not leave others behind. Current
registered tools:

| Tool | Canonical location |
|---|---|
| `wasm-pack` | `.github/actions/install-wasm-pack/action.yml`, `inputs.version` fallback (#2225) |

New workflows that need `wasm-pack` MUST consume the composite action
(`uses: ./.github/actions/install-wasm-pack`) rather than re-pinning the
version in a workflow-level `env:` block. Adding a new tool to this list
means: create a `.github/actions/install-<tool>/action.yml` composite,
move every workflow's version pin into it, and append the entry here in
the same PR.

## 3. Public-repo parallelism

Because this repository is public, runner minutes are free. When a job performs
N independent units of work that each take non-trivial time, prefer a matrix
split with N runners over a sequential loop — **unless** measured evidence shows
that warm-cache sharing between units dominates per-runner setup overhead.

`swift.yml` is a documented case where this trade-off is non-obvious: the
workflow runs approximately every 4 hours (warm cache almost always), so 5
sequential targets on one runner complete in ~31 s while 5 parallel cells would
each pay runner boot + cache restore independently. Any proposed matrix split for
`swift.yml` MUST measure both the cold-cache and warm-cache cases before merging.
See #1465 for the tracking issue.

## 4. Measure before shipping workflow performance changes

PRs that claim to improve CI wall-clock MUST include before/after numbers from
representative runs (one per workflow touched), gathered via:

```bash
gh run view <run-id> --json jobs -R koedame/chordsketch
```

A PR that says "this makes CI faster" without concrete numbers is not
reviewable.

## 5. Concurrency groups are required on every macOS-bearing workflow

Every workflow that includes a `runs-on: macos-*` job MUST declare a
top-level `concurrency:` block keyed by the PR number (falling back to
`github.ref` for non-PR events) and cancel PR runs in-progress.
Recommended shape:

```yaml
concurrency:
  group: <workflow-name>-${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}
```

The `cancel-in-progress` expression is gated on the `pull_request`
event so that `main` pushes, tag pushes, `workflow_dispatch`, and
`release` events always run to completion — only PR force-pushes /
rebases cancel stale runs.

Use this exact group-key pattern — `github.event.pull_request.number
|| github.ref` — for all newly added workflows. Every existing
workflow in this repo uses this canonical shape; the older
`github.head_ref || github.run_id` form is no longer present and
MUST NOT be reintroduced when adding or modifying a `concurrency:`
block.

**Why:** GitHub-hosted runners are capped at 5 concurrent macOS jobs
on the Free / Pro / Team plans
(https://docs.github.com/en/actions/reference/actions-limits). When a
PR is rebased (or a GitHub Merge Queue speculative-merge failure
pushes the author to re-queue — see
[ADR-0003](../../docs/adr/0003-github-merge-queue.md) for the
queue's role in this picture), the old run continues occupying
macOS slots while the new run starts behind it in the 5-job queue.
Without cancel-in-progress, N pushes to one PR produce N parallel
macOS pipelines competing for the same ceiling.

### Release/tag-triggered workflows

`release.yml` and `post-release.yml` are macOS-bearing but NEVER
participate in PR force-push cancellation (they are triggered by tag
pushes or by `release.types=[published]`). The PR-scoped
cancel-in-progress expression is therefore irrelevant; what matters
is that a second tag push or a re-dispatched `workflow_dispatch`
MUST NOT cancel a release that is already in flight — a partial
release with only some platform archives would silently degrade
every downstream install path.

These workflows therefore use a minimal variant:

```yaml
concurrency:
  group: release-${{ inputs.tag || github.ref }}  # or post-release-${{ ... }}
  cancel-in-progress: false
```

This keeps §5 applied to every macOS-bearing workflow while
preserving the "always run to completion" guarantee for the release
pipeline.

Covered macOS-bearing workflows as of 2026-04-26:

- **PR-scoped cancel-in-progress** (main §5 shape): `ci.yml`,
  `swift.yml`, `python.yml`, `ruby.yml`, `kotlin.yml`, `napi.yml`,
  `github-action-ci.yml`, `desktop-build.yml`, `readme-smoke.yml`.
- **`cancel-in-progress: false`** (release/tag-triggered variant):
  `release.yml`, `post-release.yml`, `desktop-release.yml`.

`ffi.yml` and `vscode-extension.yml` carry concurrency blocks too,
but they are Linux-only — their groups guard against redundant
`ubuntu-latest` builds on PR rebase / force-push, not the macOS
5-job ceiling. They are not required by §5; their presence is a
defense-in-depth measure against stale-run pileups on Linux
capacity and is orthogonal to the macOS-cap motivation documented
here.

When adding a new workflow that touches macOS, append its group name
to the appropriate bucket above in the same PR that introduces the
workflow.

## 6. Workflow frequency is a first-class design input

Before adding a cache layer, a matrix split, or any optimization to a workflow,
verify how often it actually runs:

```bash
gh run list --workflow <file>.yml -R koedame/chordsketch --limit 100 --json createdAt
```

If the workflow runs less than weekly, most caching optimizations will be
ineffective — the cache expires before the next run uses it.
