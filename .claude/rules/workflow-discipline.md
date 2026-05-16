# Workflow Discipline

Operational contract for phase-based workflows under
`.claude/workflows/<name>/`, executed by `scripts/run-workflow.sh`. See
[ADR-0018](../../docs/adr/0018-phase-based-shell-orchestrated-workflows.md)
for why this pattern exists and which alternatives it declines.

## When to write a workflow vs. a slash command

| Pattern | Use when |
|---|---|
| Slash command in `.claude/commands/` | The task is **one session**, with at most a self-contained inner loop. Doc audits, dependency reviews of a fixed list, one-shot generation. |
| Workflow in `.claude/workflows/` | The task has **distinct phases** that benefit from independent failure surfaces, `--resume`, or a clean halt boundary. The orchestrator's gain over a single `claude -p` is real only when phase boundaries align with natural decision points (CI wait, review iteration, "do I have a candidate?"). |

Cost of choosing wrongly:

- Workflow for a slash-command-shaped task → over-engineering. Three
  phase files where one prompt would do.
- Slash command for a workflow-shaped task → the failure surface
  expands to the whole task. The maintainer cannot resume from the
  middle; a 30-minute implementation that errors at the review step
  starts over from triage.

When in doubt, start as a slash command and split later. The orchestrator
intentionally takes no dependency on a workflow's internal structure,
so promotion from slash command to workflow is a refactor of phase
content, not a rewrite of plumbing.

## Naming

- **Workflow name** is the directory under `.claude/workflows/`.
  Match `[a-z0-9-]+`. Singular noun-phrase preferred (`autopilot-issue`,
  not `issue-autopilots`). Becomes part of `.claude/workflow-state/`
  paths and the `flock` filename — collisions are silent state
  corruption.
- **Phase name** is the key in `workflow.json`'s `phases` map and the
  value written to `current-phase.txt`. Match `[a-z0-9-]+`. Phase
  names need only be unique inside one workflow — there is no global
  namespace.
- **Terminal phase names** double as exit-state descriptions. Prefer
  verbs or adjectives (`ready-for-merge`, `no-candidate`,
  `dry-run-exit`). Reserve `HALT` for error/abort exits; the
  orchestrator emits exit code `2` and reads `halt_reason` for HALT
  specifically.

## Phase file contract

Every `phases/<phase>.md` MUST be structured so an unfamiliar reader
can answer four questions without reading any other file:

1. **What does this phase do?** A one-line goal at the top.
2. **What does it read?** A list of context.json fields and (optionally)
   environment variables.
3. **What does it do?** Numbered steps. Side effects on the filesystem,
   remote state (GitHub, Cargo registry, etc.), and sub-agents are
   spelled out.
4. **What does it write?** A literal `context.json` schema for the
   fields this phase adds, and an enumeration of valid `next_phase`
   values with the condition under which each is chosen.

The orchestrator appends a generic "Required final actions" block to
every phase invocation (atomic write of `context.json`, write
`current-phase.txt`, HALT discipline). Phase authors should NOT repeat
those instructions verbatim — assume they are present and document only
the workflow-specific contract.

### HALT discipline

A phase MUST set `next_phase` to `"HALT"` and populate `halt_reason`
when, and only when, the workflow cannot safely continue. Examples of
correct HALT triggers:

- A precondition fails (auth, branch, dirty tree).
- A target resource is missing or in the wrong state.
- Local validation cannot be made green within the phase's documented
  retry budget.
- The work uncovered a requirement the workflow cannot satisfy
  (e.g. an ADR is needed; cross-team coordination is needed).

Examples of incorrect HALT triggers:

- A check returned "no candidates." That is a clean exit through a
  named terminal phase (e.g. `no-candidate`), not HALT. Reserve HALT
  for unexpected states.
- A retryable, transient failure (network blip, CI not yet finished).
  Retry within the phase up to the documented budget, then HALT only
  if the budget is exhausted.

`halt_reason` is a single sentence. It is shown verbatim to the
maintainer; write it as if speaking to someone who has not read the
phase prompt.

### Worktree responsibility

Phases that mutate code MUST do so in an isolated `git worktree`. The
worktree may be created by the workflow itself (e.g.
`autopilot-issue`'s `implementation` phase does this) or assumed to
have been created upstream (e.g. a phase that operates on a worktree
recorded in `context.implementation.worktree_path`).

Phases that only read state — preconditions, triage, review collection —
MAY operate on the main checkout.

The orchestrator does not enforce this; it is a discipline matter.
Violating it puts the maintainer's `main` checkout at risk under
`--dangerously-skip-permissions`.

## context.json schema evolution

`context.json` is a workflow-scoped key-value store. Treat its shape as
an evolving but **strictly additive** schema:

- **Adding new keys is always allowed.** A phase that needs a new
  field declares it in the phase file's Output section, and downstream
  phases that consume it should tolerate its absence (treat it as a
  signal that an older phase wrote the file and the new field is
  unavailable).
- **Removing keys is NOT allowed in the same workflow.** A field that
  was once written by phase A and read by phase B remains a contract
  even if A no longer writes it — old `--resume` invocations may
  hand a context.json from a previous run shape to a current phase.
- **Renaming keys is removal-plus-add.** Avoid. If unavoidable, write
  both the old and new key for one workflow revision so context files
  from interrupted runs continue to load.
- **Type changes are forbidden.** A field that was an `int` stays an
  `int`. A field that was an array of objects stays an array of
  objects. If the semantics genuinely need to change, introduce a new
  field and deprecate the old one across two workflow revisions.
- **Cross-workflow sharing is forbidden.** Each workflow's
  context.json is its own namespace. No workflow reads another's
  state directory.

Phase authors who want machine-checkable guarantees can add a JSON
Schema under `.claude/workflows/<name>/context.schema.json` and have
the orchestrator validate against it. The current orchestrator does
not enforce this — until enforcement lands, phase authors and
maintainers cross-check by reading the phase file's Output section.

## Workflow definition (`workflow.json`) requirements

- `entryPhase` MUST appear as a key in `phases`.
- Every value in any `phases.<X>.next` array MUST appear either as a
  key in `phases` or as an entry in `terminalPhases`.
- Every key in `phases` MUST have a `file` whose path resolves to an
  existing `phases/*.md`.
- `terminalPhases` MUST include `HALT`.
- The orchestrator does not currently enforce `next` adherence at
  runtime (Claude could write any string to `current-phase.txt`); it
  enforces only "phase exists or is terminal." Treat `next` as the
  contract a phase author promises to honour.

`scripts/validate-workflow.py` checks every item in this section; run
it before opening a PR that adds or modifies a workflow.

## Logging and observability

Every `claude -p` invocation is logged to
`.claude/workflow-state/<name>/logs/<ISO-8601>-<phase>.log`. The
maintainer's primary debugging tool is `tail -f` on the most recent
log.

Phase prompts SHOULD NOT include any instruction to log to stdout
beyond what `claude -p` naturally produces. Side-effect-based state
(context.json) is the source of truth; logs are for forensics.

## Adding a new workflow

1. Use the `/new-workflow` skill (see
   `.claude/commands/new-workflow.md`) to scaffold the directory
   structure, or copy `autopilot-issue/` as a template and rename.
2. Edit `workflow.json` to declare the phase graph.
3. Write each `phases/*.md` per the contract above.
4. Run `python3 scripts/validate-workflow.py <name>` to verify the
   definition is internally consistent.
5. Smoke-test phase by phase: define a minimal workflow with only the
   first phase and a `HALT` next; verify context.json ends up shaped
   correctly; add the next phase; repeat.
6. Add a row to the relevant doc cross-references per
   [`.claude/rules/doc-maintenance.md`](doc-maintenance.md) (CLAUDE.md
   if the workflow is user-visible; `.claude/workflows/README.md`
   index if one exists).

## Deleting a workflow

1. Remove `.claude/workflows/<name>/` from the repo.
2. Remove any documentation references (CLAUDE.md mentions, README
   indexes).
3. **Do not** purge `.claude/workflow-state/<name>/` for in-flight
   runs on other machines — that directory is per-checkout and
   git-ignored, so it does not survive a delete-from-repo anyway.
4. If the workflow established a project-wide convention (e.g.
   `autopilot-issue`'s "Ready for merge" gate), the convention's
   ADR or rule survives the workflow's deletion; do not delete the
   ADR just because the workflow that motivated it is gone.

## Cross-references

- [`adr-discipline.md`](adr-discipline.md) — when a workflow's design
  warrants a separate ADR.
- [`doc-maintenance.md`](doc-maintenance.md) — when a workflow
  addition triggers a doc update.
- [`pr-workflow.md`](pr-workflow.md) — workflows that produce PRs
  stop at the Ready-for-merge gate; merge is a separate decision.
- [`one-pr-at-a-time.md`](one-pr-at-a-time.md) — workflows that open
  PRs against `main` must respect the serialisation rule.
- [ADR-0018](../../docs/adr/0018-phase-based-shell-orchestrated-workflows.md)
  — the architectural decision this rule operationalises.

## Why

Phase-based workflows are a new project-wide convention as of
2026-05-16. Without a rule file, the next person to add a workflow
will rediscover the contract by reading `autopilot-issue` and
inferring; that path produces drift. The contract above pins the
parts that need to stay consistent across workflows so the
orchestrator stays usable as the workflow count grows.
