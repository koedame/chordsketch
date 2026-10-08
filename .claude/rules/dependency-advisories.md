# Dependency Advisories

`.github/workflows/dependency-audit.yml` scans `Cargo.lock` against the
RustSec database, every `package-lock.json` with `npm audit`, and every
`requirements*.txt` with `pip-audit`, daily, on dispatch, and on any pull
request that changes the dependency graph. [ADR-0048](../../docs/adr/0048-scheduled-rustsec-audit.md)
records why it is shaped this way.

## Where a finding shows up

| Trigger | Outcome |
|---|---|
| `schedule` / `workflow_dispatch` | Opens or updates one rolling issue — "Security advisories in Cargo dependencies" — and closes it when the lockfile and the ignore list are clean. The run itself stays green. |
| `pull_request` | Fails **only** for a vulnerability the diff introduces (the base branch's result is subtracted), or a stale entry in `.cargo/audit.toml`. |

Informational advisories (`unmaintained` / `unsound`) never fail a run and
never open the issue. They appear in the job summary, and in the issue body
when one is open for another reason.

## When a pull request fails this check

The diff moved a crate onto a version with a known advisory. In order of
preference:

1. **Move to a patched version.** The report names the patched range.
2. **Pick a different version of the dependency you were bumping**, if the
   advisory arrived through a transitive edge you can route around.
3. **Mute it** — only when neither of the above is reachable from this PR.

## npm and Python

The `npm` job runs `scripts/audit-npm.py` over every lockfile `git ls-files`
returns (no list to extend). It follows the table above with its own issue,
"Security advisories in npm dependencies", and only `high` / `critical`
advisories count. When a pull request fails it:

1. Run `npm audit fix` in the failing lockfile's directory (add
   `--package-lock-only` if you do not want `node_modules` touched).
2. If the fix needs a semver-major bump, make it in `package.json`. If a
   transitive dependency of a dev tool is pinned upstream, an `overrides`
   entry (see `packages/vscode-extension/package.json`) is acceptable;
   write down in the PR which upstream release lets it go.
3. There is no ignore list for npm. An advisory with no patched release is
   inherited by the base branch and does not block pull requests.

The `python` job fails on any `pip-audit` finding on every trigger; bump the
pin in `requirements*.txt`.

## Muting an advisory

Add it to `.cargo/audit.toml` with both comments on their own lines,
immediately above the id:

```toml
ignore = [
  # why: transitively pinned by tauri; no compatible release yet
  # review-by: 2026-12-01
  "RUSTSEC-2026-0194",
]
```

- **`why:`** states why the advisory cannot be fixed here **and** why leaving
  it is safe. "Not exploitable in our usage" needs the reason it is not.
- **`review-by:`** is a real date you expect to know more by — an upstream
  release, the next MSRV window. Prefer weeks over months.
- A dev-only advisory is muted the same way as any other; the scope is an
  argument that goes in the `why:` line, not an exemption.

`scripts/audit-advisories.py` checks the shape: a missing `why:`, a missing
or malformed `review-by:`, or a date that has passed is reported exactly like
an advisory. A mute therefore expires on its own instead of becoming
permanent.

## Reading the scope column

`runtime` means the crate is reachable from a workspace member without a
`[dev-dependencies]` edge, so it ships in a published artefact.
`dev/test-only` means it is reached only through dev edges — the failure mode
is bounded by the test suite. The column sets triage priority; it never
changes whether a finding blocks.

## Running it locally

```bash
cargo install cargo-audit --locked   # once
cargo audit
python3 scripts/audit-npm.py         # every package-lock.json
```

The workflow's extra layers (scope, base-branch subtraction, ignore hygiene)
run through `scripts/audit-advisories.py`; see the workflow for the exact
invocation.

## Related

- [`root-cause-fixes.md`](root-cause-fixes.md) — an ignore entry is a
  documented, expiring deferral, not a fix. Reaching for one before checking
  for a patched version is the band-aid this rule's `why:` requirement is
  meant to expose.
- `.claude/commands/dependabot-review.md` step 3 — the PR-conditional
  advisory check this workflow makes unconditional.
