# Action Pin Provenance

Every `uses:` reference is SHA-pinned (`scripts/check-action-pins.sh` enforces
it). This rule covers **which** SHA is acceptable.

## Rule

A pin must name a commit that is **reachable from the upstream repository's
default branch** — an ancestor of it, or the branch tip itself.

Do not pin a commit that lives only on a branch or tag the upstream owner
rewrites (`dtolnay/rust-toolchain`'s `stable` / `nightly` / `1.xx` branches,
a moving `v1` release tag, …). Such a commit works today and disappears
without warning: it is not in a fresh clone, so Dependabot's `github_actions`
job errors on it (`error: no such commit <sha>`) and stops updating that
action, and upstream garbage collection can eventually make every workflow
using it fail at once.

Rationale and the incident that produced this rule:
[ADR-0042](../../docs/adr/0042-action-pins-must-be-default-branch-ancestors.md).

## How to check a pin

```bash
gh api repos/<owner>/<repo>/compare/<default-branch>...<sha> --jq .status
```

`behind` or `identical` → the commit is on the default branch, pin it.
`diverged`, or a 404/422 → the commit is not reachable, pick another.

The trailing comment names the ref the SHA came from, so `# master` is the
honest comment for a default-branch pin; `# v1` stays correct when the tag
points at a default-branch commit.

## Toolchain actions

`dtolnay/rust-toolchain` derives the toolchain from the ref name only through
the per-toolchain branches, which are exactly the branches that get rewritten.
Pin `master` and name the toolchain at the call site:

```yaml
- uses: dtolnay/rust-toolchain@<master sha> # master
  with:
    toolchain: stable
```
