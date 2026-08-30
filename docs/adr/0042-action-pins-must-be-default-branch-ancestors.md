# 0042. Action SHA pins must be ancestors of the upstream default branch

- **Status**: Accepted
- **Date**: 2026-08-30

## Context

`scripts/check-action-pins.sh` (run by `check-action-pins.yml` on every PR and
on `main`) requires every `uses:` reference to be pinned to a 40-character
commit SHA. It checks the *shape* of the ref, not where that commit lives in
the upstream repository. Two of the repository's pins pointed at commits that
were reachable only from a ref the upstream owner rewrites:

| Pin | Upstream state on 2026-08-30 |
|---|---|
| `dtolnay/rust-toolchain@29eef336…` (`# stable`) | `diverged` from `master` — it was a tip of the force-pushed `stable` branch |
| `anthropics/claude-code-action@21302532…` (`# v1`) | gone entirely (`GET /repos/…/commits/21302532…` → 422) |

Both still resolve when a workflow runs, because the Actions runner fetches
the action from the upstream repository's object store, which keeps
unreferenced objects alive for a while. They do **not** survive a clone.
Dependabot clones each action repository and runs
`git branch --remotes --contains <pin>` to decide which branch a pinned ref
belongs to. When the object is not in the clone, that command fails:

```
ERROR <job_…> Error processing dtolnay/rust-toolchain (…HelperSubprocessFailed)
ERROR <job_…> error: no such commit 29eef336d9b2848a0b548edc03f92a220660cdb8
…
Dependabot encountered '2' error(s) during execution
```

Every weekly `github_actions` update job failed this way — 7 failures in the
90 days to 2026-08-30, i.e. every run of that ecosystem. The two dependencies
were never checked for updates, so Dependabot could not repair the pins
itself, and the job's exit status was a permanent red.

The upstream action documents the constraint directly ([dtolnay/rust-toolchain
README][rt], "Choice of full-length commit SHA"): *"it is required that you
pick a SHA that is within the history of the master branch. Any commit that is
not within the history of master will eventually get garbage-collected and
your workflows will fail."*

## Decision

A SHA pin must name a commit that is an **ancestor of (or identical to) the
upstream repository's default branch**. Pinning a commit that exists only on a
rewritten branch or a moved tag is not an acceptable pin, even though it
satisfies the 40-hex-character rule.

For `dtolnay/rust-toolchain` this means pinning a `master` commit and passing
the toolchain explicitly:

```yaml
- uses: dtolnay/rust-toolchain@<master sha> # master
  with:
    toolchain: stable
```

The `stable` branch's `action.yml` differs from `master`'s in exactly one way —
it defaults the required `toolchain` input to `stable` — so naming the input at
the call site is behaviour-preserving.

## Rationale

- The failure is silent in the place people look. The workflows kept passing,
  so nothing pointed at the pins; the only signal was a red Dependabot job on
  a page nobody opens.
- It is not self-healing. The dependency that breaks the job is the same one
  the job would have had to update, so the error persists until a human
  re-pins.
- The tail risk is worse than the noise. Actions currently serves these
  objects, but upstream garbage collection can drop them at any time, and
  then every workflow that uses the action fails at once — including release
  workflows, on the day of a release.
- Reachability is a property of the pin, not of the workflow, so it belongs
  with the pinning policy rather than in a per-workflow comment.

## Consequences

- `.claude/rules/action-pin-provenance.md` states the rule for anyone editing
  a `uses:` line, with the `gh api …/compare/<default>...<sha>` check that
  answers it (`behind` or `identical` = good, `diverged` or 404 = bad).
- `dtolnay/rust-toolchain` call sites now pass `toolchain:` explicitly. A call
  site that wants a non-stable toolchain (`ci.yml`'s MSRV matrix already did)
  keeps naming it; nothing derives the toolchain from the ref any more.
- `scripts/check-action-pins.sh` is unchanged: it stays an offline, network-free
  check that every PR can run. Reachability needs a network call per distinct
  pin, which would make a required check depend on the availability of every
  upstream action repository. Dependabot already performs that check weekly —
  the point of this ADR is that its report was being thrown away, not that a
  second checker is needed.

## Alternatives considered

- **Add a network reachability check to `check-action-pins.sh`**: rejected.
  The check would require one `gh api` call per distinct pin on every PR,
  making a required check depend on the availability of every upstream action
  repository. If any upstream is temporarily unreachable, the check fails for
  an unrelated reason. Dependabot already performs this check weekly; the
  correct fix is to keep Dependabot's report actionable (i.e., maintain valid
  pins), not to duplicate the check in CI.

- **Keep pinning to the `stable`/`nightly` branches and accept the risk**:
  rejected. The tail risk of upstream garbage collection is not theoretical —
  `dtolnay/rust-toolchain`'s README explicitly documents the hazard. Accepting
  it in exchange for the convenience of not naming the toolchain at the call
  site is not a good trade.

- **Switch to a different Rust toolchain installer** (e.g., `rustup` invoked
  directly in a `run:` step): not needed. `dtolnay/rust-toolchain` works
  correctly when pinned to a `master` commit; the fix is one line per call
  site, not a toolchain-installer migration.

## References

- [dtolnay/rust-toolchain README — "Choice of full-length commit SHA"][rt]
- Dependabot `github_actions` job failure log (7 consecutive failures,
  2026-04-05 through 2026-08-30) — the error excerpt is reproduced in the
  Context section above.
- PR #2784 — the code change implementing this decision.
- `.claude/rules/action-pin-provenance.md` — the operational rule that
  states this policy for anyone editing a `uses:` line.

[rt]: https://github.com/dtolnay/rust-toolchain#choice-of-full-length-commit-sha
