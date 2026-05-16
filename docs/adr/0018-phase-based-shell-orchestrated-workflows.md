# 0018. Phase-based shell-orchestrated workflows

- **Status**: Accepted
- **Date**: 2026-05-16

## Context

Several long-running autonomous tasks emerged on the project's wishlist
during the 2026-05 cycle, the canonical example being "find an open
issue authored by a specific user, implement it, drive review to
convergence, stop at a Ready-for-merge gate." None of the existing
in-repo automation primitives quite fit:

- Slash commands under `.claude/commands/` execute as a single
  monolithic `claude` session. They are ideal for one-shot operations
  (`/doc-quality-check`, `/dependabot-review`), but the longer the
  prompt grows, the harder it is to control where the session halts
  or branches, and the harder it is for the maintainer to resume from
  a specific point after an interruption. A session that picks an
  issue, implements it, and drives review across CI waits and review
  iterations would be tens of pages of Markdown and would not survive
  a single dropped network connection.
- `.github/workflows/*.yml` (GitHub Actions) is the right home for CI
  and release automation, but not for orchestrating Claude Code
  itself. The Action runner does not host a Claude Code session;
  invoking Claude from an Action requires the
  `anthropics/claude-code-action`, which is a different execution
  surface than the maintainer-driven workstation flow and has produced
  silent failures in the past (ADR-0016 §Context cites
  `claude-review` exiting in 19–28 s with no review signal).
- The Dependabot path uses a *skill* (ADR-0016) — a slash command
  that drives many PRs sequentially in one session. That pattern fits
  short, parallel, structurally identical work. It does not fit a
  workflow whose phases differ in shape (precondition probe vs. CI
  wait vs. review iteration) and that benefits from a clean state
  handoff between them.

Three external tools were also evaluated:

1. **CC Workflow Studio** (`breaking-brake/cc-wf-studio`) — a VS Code
   extension that renders Claude Code workflows as a visual graph and
   exports them as Markdown slash commands. The execution model is
   still a single `claude` session, so the slash-command-monolith
   problem above is not solved. The extension exposes an MCP server
   for AI-driven editing, but the server is process-bound to the
   Claude Code session that VS Code's "Edit with AI" button spawns;
   it is not reachable from a Claude Code session running outside
   the integrated terminal. The maintainer prefers Claude Code
   outside the integrated terminal, which makes the AI-editing path
   unusable in practice.
2. **n8n** — a general-purpose workflow runner. Excellent for SaaS
   integration and deterministic node execution, but every node that
   needs Claude's judgement (triage, implementation, review) becomes
   an HTTP node calling the Anthropic API, which discards Claude
   Code's native primitives (sub-agents, skills, MCP, hooks,
   permission allowlist, CLAUDE.md auto-load). n8n is a reasonable
   *peer* of this workflow runner — fine for cron triggers and
   notifications — but a poor substitute for it.
3. **Claude Agent SDK** — fits the long-running orchestrated-agent
   shape exactly, but requires writing the orchestrator as a
   programmatic SDK consumer (TypeScript or Python). For the
   immediate use cases this is more code than the problem warrants
   and introduces a runtime that needs its own deployment story.

## Decision

Use a **phase-based shell-orchestrated workflow** runner, stored in-repo:

1. **`scripts/run-workflow.sh`** is a single generic Bash orchestrator.
   It takes a workflow name as its argument, validates the workflow
   definition, then loops: read the current phase name from a state
   file, invoke `claude --dangerously-skip-permissions -p` with the
   phase's Markdown prompt, verify the phase updated the state file,
   advance.

2. **`.claude/workflows/<name>/`** holds each workflow's definition:
   - `workflow.json` declares `entryPhase`, `phases` (each with `file`
     and `next`), and `terminalPhases`.
   - `phases/*.md` are individual prompts.
   - `README.md` (optional) documents the workflow.

3. **`.claude/workflow-state/<name>/`** is the runtime state directory,
   git-ignored, containing `current-phase.txt`, `context.json`,
   `logs/`, and a `flock` lock file. The orchestrator never inspects
   the model's stdout to decide what to do next — it inspects the
   state file the phase wrote.

4. **`.claude/rules/workflow-discipline.md`** codifies the operational
   contract: how a phase declares its outputs, when HALT is mandatory,
   how the context.json schema is allowed to evolve, how workflow and
   phase names interact, and what the maintainer-versus-Claude
   responsibility split looks like.

## Rationale

**Phase-by-phase execution survives interruption.** Each phase is its
own `claude -p` invocation. A dropped network connection, a OOM kill,
or a maintainer's Ctrl-C kills only the in-flight phase, not the
workflow. `--resume` reads the saved `current-phase.txt` and continues.
Monolithic slash commands cannot do this without bespoke checkpoint
logic; the workflow runner gets it for free from the design.

**State files beat stdout parsing.** `claude -p` mixes prose with any
machine-readable output Claude chooses to produce, and that prose drifts
between model versions. A phase prompt that says "write the next phase
name to `current-phase.txt`" produces a stable, parseable side effect
the orchestrator can rely on. The orchestrator reads no model output to
decide control flow — it only checks file mtimes and `jq empty` on
context.json.

**Shell, not SDK, matches the project's tone.** This repo's existing
tooling is `cargo`, `python3 scripts/*.py`, and `gh`. A Bash
orchestrator that consumes the same `claude` CLI the maintainer uses
interactively keeps the runtime story simple. There is no separate
language toolchain to install, no service to deploy. The orchestrator
is 250 lines of POSIX-ish Bash and can be read end-to-end in five
minutes.

**Claude Code primitives stay native.** Because each phase runs as a
real `claude` invocation in the real repo, every `.claude/rules/` file,
sub-agent definition, skill, and MCP server is available to the phase
without translation. The phase prompts cite rule files by relative
path; no plumbing required to make them load.

**Per-workflow namespace prevents collisions.** Workflow names are the
top-level namespace; phase names only need to be unique inside a
workflow. State directories mirror the same structure. Two workflows
can run concurrently (different state directories, different locks);
two instances of the *same* workflow cannot (the `flock` blocks).
This scales to the planned multi-workflow future (adding new workflows
incrementally) without a global registry.

## Consequences

**Positive**

- Each phase is short, focused, and individually editable. Adding a
  step is a new phase file plus a `next` entry; no refactor of any
  other phase.
- Workflow definitions are reviewable as data (`workflow.json`) plus
  prose (`phases/*.md`), not as code.
- The same `claude` binary that powers the maintainer's interactive
  sessions powers the workflow runner, so primitives never diverge.

**Negative**

- `claude --dangerously-skip-permissions` is the runner's default.
  Phases run with no tool prompts at all. Mitigated by: phase prompts
  push mutating operations into git worktrees they themselves create,
  the `flock` prevents concurrent runs from racing on the same repo,
  and the maintainer can replace `--dangerously-skip-permissions`
  with a project-scoped `permissions.allow` list when the catalogue
  of phase actions stabilises. Recorded as a watch signal in the
  References section.
- No structured execution dashboard. The runtime story is `tail -f`
  on per-phase log files under `.claude/workflow-state/<name>/logs/`.
  Acceptable while the workflow count is small; revisit if it grows
  past a handful.
- The orchestrator is Bash. Long-term, a Python rewrite may be
  warranted if the orchestrator itself accumulates feature surface
  (retry policies, branching, parallel phases). Watch signal: more
  than ~400 lines of orchestrator code.

## Alternatives considered

- **Monolithic slash command.** The original prototype lived at
  `.claude/commands/autopilot-issue.md`. Removed when this ADR
  landed. The single-session execution model could not represent
  "wait for CI, then review, then iterate" without effectively
  reinventing a phase loop inside the prompt body. Rejected for the
  reasons in §Context.
- **CC Workflow Studio.** Rejected because the AI-editing path is
  process-bound to the VS Code integrated-terminal Claude Code
  session, which is not the maintainer's preferred environment, and
  because the export target is still a single-session slash command.
  Visual graphs are nice; the underlying execution model is the same
  problem.
- **n8n.** Rejected as a substitute. Documented as a complement: cron
  triggers and notifications still belong in n8n (or GitHub Actions);
  Claude orchestration belongs here.
- **Claude Agent SDK.** Strong fit for the long-running shape, but
  requires a separate Python/TypeScript codebase, deployment story,
  and observability surface. Reconsider once the workflow count is
  large enough that the SDK's programmatic ergonomics outweigh Bash
  simplicity. Watch signal: ~4+ workflows or any workflow whose
  control flow exceeds what `workflow.json` can express cleanly.

## References

- `scripts/run-workflow.sh` — the orchestrator.
- `.claude/workflows/README.md` — runtime layout contract.
- `.claude/rules/workflow-discipline.md` — phase-author rules.
- `.claude/workflows/autopilot-issue/` — first production workflow.
- ADR-0013 (conditional bot-driven merge) — the workflow stops at
  "Ready for merge"; the merge itself is a separate decision gated by
  ADR-0013's four-clause check.
- ADR-0016 (Dependabot review skill) — sibling pattern for
  short-parallel work that does not need phase decomposition.
- `breaking-brake/cc-wf-studio` — evaluated and declined; see
  §Alternatives considered.
- `n8n.io` — evaluated and declined as a substitute; complementary
  use remains in scope.
- `https://docs.anthropic.com/en/docs/claude-code/sdk` — Claude Agent
  SDK; deferred to a future revisit if scale warrants.

**Watch signals that warrant revisiting this ADR:**

- Orchestrator code grows past ~400 lines or accumulates retry /
  branching / parallel-phase logic.
- Number of declared workflows exceeds ~4, OR a workflow's `next`
  graph stops being acyclic without acrobatics.
- A phase needs to run outside the maintainer's workstation (e.g.
  triggered by an external event), which would force migration to a
  hosted runner.
- A real-world incident where `--dangerously-skip-permissions`
  enables damage that a project-scoped `permissions.allow` list
  would have caught.
