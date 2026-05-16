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

## Required plugins

The `pr-review` phase depends on the `pr-review-toolkit` plugin from
the official [Claude Code plugin marketplace](https://github.com/anthropics/claude-code/tree/main/plugins)
for its specialist review sub-agents: `code-reviewer`,
`silent-failure-hunter`, `pr-test-analyzer`, `comment-analyzer`, and
`type-design-analyzer`. The `preconditions` phase verifies the plugin
is installed via `claude plugins list` and HALTs with an actionable
`halt_reason` if it is missing, per
[`.claude/rules/workflow-discipline.md`](../../rules/workflow-discipline.md)
§"Required external dependencies".

Install if needed (qualify with the marketplace name if multiple
marketplaces are configured on the host — the bare form below assumes
the official marketplace is the only one or the default):

```bash
claude plugins install pr-review-toolkit
```

No other phase depends on plugin-provided sub-agents; `preconditions`,
`issue-selection`, and `implementation` use only the built-in
`Explore`, `Plan`, and `general-purpose` `subagent_type` values.

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
| `HALT` | A precondition / safety check failed. Inspect `halt_reason` in `context.json`. See "HALT triggers" below for the canonical enumeration. |

## HALT triggers

The phases' own `## HALT conditions (explicit enumeration)` sections
remain the source of truth; this list mirrors them so a maintainer
reading the workflow contract from the top sees every reason the
orchestrator might stop early.

- **`preconditions`**: `gh` unauthenticated or wrong user; current
  branch is not `main`; running from a worktree; working tree is
  dirty; another open PR by the current user against `main` exists;
  `pr-review-toolkit` plugin is not installed.
- **`issue-selection`**: target issue not authored by the expected
  user, or hard preconditions on the candidate set fail.
- **`implementation`**: local validation (`cargo fmt --check`,
  `cargo clippy -- -D warnings`, `cargo test --workspace`, plus any
  workflow-specific smoke) cannot be made green; a forbidden action
  would be required to satisfy the issue.
- **`pr-review`**: remote branch already exists at push time; CI
  does not settle within the bounded wait (30 min default); review
  iteration cap (3) is hit with findings outstanding; a finding's
  root-cause fix genuinely cannot be produced inside this session
  (cross-team coordination, upstream dependency not yet landed,
  maintainer judgement on a contested trade-off — but NOT ADR
  authorship, which is the in-PR root-cause fix for findings that
  trigger [`.claude/rules/adr-discipline.md`](../../rules/adr-discipline.md));
  `Skill` resolution for `review` or `security-review` fails — the
  fan-out's two required surfaces are non-optional; a forbidden
  action would be required to complete the PR.

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
