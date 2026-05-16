# Workflow: autopilot-issue

Single-iteration autonomous handler for `unchidev`-authored issues.

## Phases

```
preconditions
   ├── issue-selection ──┬── implementation ──┬── pr-review ── ready-for-merge ✅
   │                     │                    └── dry-run-exit ✅
   │                     └── no-candidate ✅
   └── HALT 🛑
```

Every non-terminal phase can also exit to `HALT` if a precondition is
violated mid-run. The orchestrator stops on the first failure; the
worktree (if any) is preserved for inspection.

## Inputs

- `AUTOPILOT_DRY_RUN=1` — skip push/PR steps; exit after local
  validation with `dry-run-exit`.
- `AUTOPILOT_ISSUE_NUMBER=<N>` — target a specific issue (must still be
  authored by `unchidev`); skip triage scoring.

Both are read from the environment by the `preconditions` phase and
recorded in `context.json` as `dry_run` (bool) and `target_issue` (int
or null). Downstream phases read those fields, not the env vars.

## Invocation

```bash
# Full flow up to the Ready-for-merge gate
./scripts/run-workflow.sh autopilot-issue

# Dry run: stop after local validation
AUTOPILOT_DRY_RUN=1 ./scripts/run-workflow.sh autopilot-issue

# Target a specific unchidev-authored issue
AUTOPILOT_ISSUE_NUMBER=1234 ./scripts/run-workflow.sh autopilot-issue

# Resume after a previous failure / HALT (uses saved current-phase.txt)
./scripts/run-workflow.sh autopilot-issue --resume
```

## Terminal phases

| Phase | Meaning |
|-------|---------|
| `ready-for-merge` | PR is open, CI green, auto-review converged. Maintainer must execute the squash merge per ADR-0013. |
| `no-candidate` | No `unchidev`-authored issue cleared the triage criteria. Clean exit; nothing to do. |
| `dry-run-exit` | Local implementation green; worktree retained. No PR opened. |
| `HALT` | A precondition / safety check failed. Inspect `halt_reason` in `context.json`. |

## context.json schema (evolving)

Initial keys written by `preconditions`:

```json
{
  "started_at": "<ISO 8601>",
  "dry_run": false,
  "target_issue": null
}
```

Subsequent phases extend the object — phase markdown declares which
keys it writes. See each `phases/*.md` "Output" section.

## Merge gate

The workflow stops at `ready-for-merge`. The actual `gh pr merge --squash`
is held for the maintainer per
[`.claude/rules/pr-workflow.md`](../../rules/pr-workflow.md) §"Bot-driven
merge: conditional permission" and
[ADR-0013](../../../docs/adr/0013-conditional-bot-driven-merge.md). The
workflow's job ends when the four-clause merge gate is provably
satisfiable; it does not assume the per-session permission required to
press the button.
