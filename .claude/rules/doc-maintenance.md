# Documentation Maintenance

## Policy

Project documentation (`CLAUDE.md`, `.claude/rules/`) is updated via **dedicated PRs**,
not inside feature branches (as per the Shared Files Policy in `parallel-work.md`).

Updates are **event-driven**, not periodic. After a PR merges to `main`, evaluate
whether any of the triggers below apply and, if so, open a dedicated documentation PR
promptly.

This rule covers per-PR documentation hygiene. Release-time
documentation sync (verifying every cross-reference still matches
workspace state before a version bump) is a separate hard gate
defined in [`release-doc-sync.md`](release-doc-sync.md). Per-PR
authors should expect the release-time check to catch any drift
they leave behind here, but should not rely on it — the cost of
fixing drift at release time, against ~30+ accumulated commits, is
much higher than fixing it in the originating PR.

## Update Triggers

| Event | What to update |
|---|---|
| New crate added to workspace | `CLAUDE.md` Architecture table |
| New rule or convention agreed upon | `.claude/rules/` — add new file |
| Build commands or CI pipeline changed | `CLAUDE.md` Build Commands |
| New workflow or process introduced | `.claude/rules/` — add new file |
| Existing rule no longer applies | Remove or update the relevant `.claude/rules/` file |
| Dependency policy changed | `CLAUDE.md` Dependency Policy section |
| Public API contract changes | Doc comment on the affected function/struct |
| Decision warranting an ADR (see [`adr-discipline.md`](adr-discipline.md)) | `docs/adr/` — add ADR file and update index |

## CI Doc Check

`cargo doc --workspace --no-deps` is run in CI with `RUSTDOCFLAGS="-D warnings"`.
Doc warnings (broken intra-doc links, missing `# Safety` sections, etc.) are treated
as errors. Ensure all public items have valid doc comments before pushing.

## Principles

- Keep documentation minimal and accurate — remove stale content rather than
  accumulating it.
- Documentation should describe the current state and rules, not history. Use git
  history for that.
- If a trigger applies but the change is trivial (e.g., a typo fix), it may be batched
  with the next documentation PR rather than requiring its own.
