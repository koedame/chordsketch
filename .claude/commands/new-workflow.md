# New Workflow Scaffold

Create the directory skeleton for a new phase-based workflow under
`.claude/workflows/<name>/`, with placeholder `workflow.json`, two
starter phase files, and a README. The skeleton is intentionally minimal
so the author can fill in real phases without first ripping out
boilerplate.

The required argument is the workflow name in kebab-case: `$ARGUMENTS`

If the argument is empty, missing, or does not match `^[a-z0-9-]+$`,
abort with a single-line error naming the issue. The workflow name
becomes a directory path and a `flock` filename — non-conforming names
are silent state corruption later.

This is a scaffolding skill, not a workflow author. After it runs, the
maintainer (or a separate Claude session) edits the placeholder files
into real phase content per
[`.claude/rules/workflow-discipline.md`](../rules/workflow-discipline.md).

## Preconditions

1. Repository root is the current working directory (or the skill is
   running with the harness's `cwd` set there). `git rev-parse --show-toplevel`
   matches `pwd`.
2. `.claude/workflows/<name>/` does NOT already exist. If it does,
   abort with `workflow '<name>' already exists at <path>`. Do not
   overwrite or merge.
3. `<name>` does not collide with the reserved identifier `HALT`
   (see `.claude/rules/workflow-discipline.md` §"Naming"). Reject if
   matched. The validator's `RESERVED_PHASE_NAMES` is the single
   source of truth — the skill and the validator MUST agree on the
   reserved set.

## Steps

1. Create the directory tree:

   ```
   .claude/workflows/<name>/
     phases/
   ```

2. Write `.claude/workflows/<name>/workflow.json` with this exact
   content, substituting `<name>`:

   ```json
   {
     "name": "<name>",
     "description": "TODO: one-line summary of what this workflow does.",
     "entryPhase": "preflight",
     "phases": {
       "preflight": {
         "file": "phases/preflight.md",
         "next": ["main", "HALT"]
       },
       "main": {
         "file": "phases/main.md",
         "next": ["done", "HALT"]
       }
     },
     "terminalPhases": ["done", "HALT"]
   }
   ```

3. Write `.claude/workflows/<name>/phases/preflight.md` with a
   placeholder phase body that:

   - Has a one-line goal at the top describing what the phase verifies
     (placeholder: `TODO: state the goal in one sentence`).
   - Declares its inputs section (env vars and context.json fields read
     — initially empty).
   - Has a numbered Steps section with a single TODO step.
   - Has an Output section that documents the context.json fields this
     phase will write (initial placeholder: `started_at: <ISO 8601>`)
     and the valid `next_phase` values (`main` on success, `HALT` on
     precondition failure).

4. Write `.claude/workflows/<name>/phases/main.md` with a similar
   placeholder body. Inputs section should mention reading whatever
   `preflight.md` writes. Output writes a `done_at: <ISO 8601>` field
   and sets `next_phase: "done"` on success or `"HALT"` on failure.

5. Write `.claude/workflows/<name>/README.md` with:

   - `# Workflow: <name>` heading.
   - A "Phases" section showing the diagram `preflight → main → done ✅`
     plus the HALT edges.
   - An "Inputs" section (initially empty; populate when the workflow
     gains env-var inputs).
   - An "Invocation" section with `./scripts/run-workflow.sh <name>`.
   - A "Terminal phases" table with `done` (success) and `HALT`
     (error) rows.

6. Run `python3 scripts/validate-workflow.py <name>` to confirm the
   skeleton is internally consistent. The expected output is
   `OK: <name>` and exit code `0`. If it fails, surface the error and
   abort — do not leave a broken skeleton on disk.

7. Print a final summary listing every file created (relative paths)
   and the suggested next steps:

   ```
   Created workflow skeleton: .claude/workflows/<name>/
     workflow.json
     phases/preflight.md
     phases/main.md
     README.md

   Next steps:
   1. Edit phases/preflight.md and phases/main.md to describe real work.
   2. Add or remove phases in workflow.json as needed; re-run
      `python3 scripts/validate-workflow.py <name>` after each change.
   3. Smoke-test with `./scripts/run-workflow.sh <name>` once the
      phases describe actions safe to execute.
   ```

## Output

This skill produces files only; it writes nothing to any
`.claude/workflow-state/` directory. No commits are created. The
maintainer reviews the scaffold, edits it, and commits it as a normal
change.

## Notes

- Do NOT modify any file under `.claude/workflows/` outside the new
  workflow directory. Do not edit `.claude/rules/`, `CLAUDE.md`, or
  the ADR index — those updates are the maintainer's call once the
  workflow's shape stabilises (per
  [`.claude/rules/doc-maintenance.md`](../rules/doc-maintenance.md)
  triggers).
- Do NOT create a corresponding state directory under
  `.claude/workflow-state/<name>/`. The orchestrator creates it on
  first run.
- The skill creates exactly two phase placeholders (`preflight` and
  `main`) regardless of the eventual phase count. Two is enough to
  exercise both an entry phase and a transition; the maintainer
  adds more later.
