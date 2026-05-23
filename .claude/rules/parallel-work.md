# Parallel Work Rules

## Git Worktree Isolation (opt-in)

Worktrees are the isolation mechanism for **concurrent** work — when more than
one Claude Code instance, tmux pane, or maintainer is actively editing the
repository at the same time. They are NOT required for routine single-session
work; the main checkout plus a feature branch is enough when nothing else is
editing in parallel.

When a worktree IS used:

- One worktree per concurrent instance — never modify files outside your own
  worktree.
- Worktree location: `../chordsketch-wt/issue-{N}-{slug}/`.
- Each worktree has its own `target/` directory — no build lock contention.

The `autopilot-issue` workflow always creates its own worktree because it
batches multiple issues into one branch and isolates the failure surface; that
behaviour is owned by the workflow and does not change with this rule.

## Setup for a New Task

Default (single instance, no concurrent work):

```bash
# From the main repo checkout
git fetch origin
git checkout -b issue-{N}-{slug} origin/main
```

When you actually need worktree isolation (concurrent instances, autopilot,
keeping `main` checked out while you build):

```bash
# From the main repo checkout
git fetch origin
git worktree add ../chordsketch-wt/issue-{N}-{slug} -b issue-{N}-{slug} origin/main
cd ../chordsketch-wt/issue-{N}-{slug}
```

## Cleanup after PR Merge

Branch-only flow:

```bash
git checkout main && git pull --ff-only
git branch -d issue-{N}-{slug}
```

Worktree flow:

```bash
git worktree remove ../chordsketch-wt/issue-{N}-{slug}
git branch -d issue-{N}-{slug}
```

## Port Allocation (for future dev servers)

- If a task needs a network port: use `3000 + issue_number`
  (e.g., issue #5 -> port 3005).
- This prevents port conflicts between parallel instances.

## Shared Files Policy

- `CLAUDE.md`, `.claude/rules/`, `.github/` — coordinate via separate PRs, never
  modify in a feature branch unless that is the PR's purpose.
- `Cargo.toml` workspace changes (adding crates) — one PR at a time, rebase other
  branches after merge.

## Rebase Protocol

When another PR merges to `main` and your branch has conflicts:

```bash
git fetch origin
git rebase origin/main
# resolve conflicts if any
git push --force-with-lease
```
