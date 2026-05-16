# Claude Code Workflows

Multi-phase autonomous workflows driven by `scripts/run-workflow.sh`. Each
workflow is a directed graph of phases; each phase is a Markdown prompt
that Claude Code executes via `claude -p` (non-interactive print mode).
State is passed between phases through a JSON file on disk; the
orchestrator never inspects model output directly.

This sits alongside one-shot slash commands in `.claude/commands/`. Use a
workflow when the task naturally splits into phases with possible halt
or branch points; use a slash command when the task is a single
self-contained operation.

## Layout

```
.claude/workflows/<name>/
  workflow.json         # phase metadata: entryPhase, phases, terminalPhases
  phases/<phase>.md     # one prompt per phase
  README.md             # optional human-readable description

.claude/workflow-state/<name>/   # gitignored — created by the orchestrator
  current-phase.txt              # name of the next phase to execute
  context.json                   # JSON state object passed phase-to-phase
  logs/<timestamp>-<phase>.log   # full `claude -p` stdout/stderr per phase
  lock                           # flock target preventing concurrent runs
```

## workflow.json contract

```json
{
  "name": "<name>",
  "description": "<one-line summary>",
  "entryPhase": "<phase>",
  "phases": {
    "<phase>": {
      "file": "phases/<phase>.md",
      "next": ["<phase>", "<phase>", "HALT"]
    }
  },
  "terminalPhases": ["<phase>", "HALT"]
}
```

- `entryPhase` must appear in `phases` (it is the workflow's start).
- `next` is a documentation hint listing valid transitions out of each
  phase. The orchestrator does not currently enforce this list against
  the value Claude writes to `current-phase.txt`; treat it as the
  contract a phase author must honour.
- `terminalPhases` are exit states. Reaching any of them ends the run.
  `HALT` is reserved for error/abort exits; everything else is treated
  as a successful terminal.

## Per-phase prompt contract

Every phase Markdown file must end with prose instructing Claude to:

1. Atomically rewrite `<state-dir>/context.json` (write to `.tmp`, then
   `mv`).
2. Write the next phase name to `<state-dir>/current-phase.txt`.
3. If halting, set `next_phase` to `"HALT"` in context.json AND write
   `HALT` to current-phase.txt AND set a one-sentence `halt_reason`.

`scripts/run-workflow.sh` appends a generic "Required final actions"
block to every phase invocation, so individual phase files do not need
to repeat those instructions verbatim — they only need to declare what
each `context.json` field should hold.

## Invocation

```bash
./scripts/run-workflow.sh <name>                 # fresh run
./scripts/run-workflow.sh <name> --resume        # continue from current-phase.txt
./scripts/run-workflow.sh <name> --max-iters 20  # tighter loop cap
./scripts/run-workflow.sh <name> --per-phase-timeout 1800
```

Exit codes:
- `0` — workflow reached a non-HALT terminal phase
- `1` — orchestrator-level error (missing file, invalid state, lock held)
- `2` — workflow reached `HALT`; see `halt_reason` in context.json

## Safety notes

- The orchestrator invokes `claude --dangerously-skip-permissions`. Phase
  prompts run with no tool-permission prompts at all. Run only on
  machines / accounts you control, and prefer to keep mutations
  contained to a git worktree the workflow itself creates.
- Workflows are exclusive: the flock under `<state-dir>/lock` prevents
  concurrent runs of the same workflow. Different workflows can run in
  parallel because each has its own state directory.
- `context.json` lives outside git. A botched run can be retried from
  scratch by deleting the workflow's `workflow-state/<name>/` directory.

## Adding a new workflow

1. Create `.claude/workflows/<your-name>/` with `workflow.json` and
   `phases/*.md`. Pick phase names that are unique within the workflow
   (no global registry required — workflow name is the namespace).
2. Each phase prompt should:
   - Declare its inputs (which context.json fields it reads, env vars).
   - State the goal and steps.
   - Declare its outputs (which context.json fields it writes, what
     valid `next_phase` values it may pick).
   - Enumerate HALT conditions explicitly so they are easy to audit.
3. Smoke-test phase by phase: run with a workflow that has only that
   phase declared, verify `context.json` ends up shaped correctly,
   then add the next phase.
4. Reference rules in `.claude/rules/` from inside the phase prompts
   when the rule's enforcement matters during that phase. CLAUDE.md
   is auto-loaded, so global rules apply without needing to inline
   them.
