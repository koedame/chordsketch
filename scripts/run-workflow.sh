#!/usr/bin/env bash
# Generic Claude Code workflow orchestrator.
#
# Drives a phase-based workflow defined under .claude/workflows/<name>/.
# Each phase is a Markdown prompt that Claude Code executes via `claude -p`;
# inter-phase state lives in .claude/workflow-state/<name>/context.json.
#
# See .claude/workflows/README.md for the layout contract and how to add
# new workflows.
set -euo pipefail

# Run from the repository root regardless of where the script is invoked from.
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
cd "$REPO_ROOT"

WORKFLOW_NAME=""
RESUME=false
MAX_ITERS=50
PER_PHASE_TIMEOUT_SECS=3600

usage() {
  cat <<EOF
Usage: $0 <workflow-name> [--resume] [--max-iters N] [--per-phase-timeout SEC]

Arguments:
  workflow-name           Directory name under .claude/workflows/

Flags:
  --resume                Continue from the saved current-phase.txt instead
                          of resetting to the workflow's entryPhase.
  --max-iters N           Hard cap on phase transitions (default 50). Guards
                          against infinite loops from a malformed phase output.
  --per-phase-timeout S   Wall-clock cap per phase invocation, in seconds
                          (default 3600).

Workflow files expected at:
  .claude/workflows/<workflow-name>/workflow.json
  .claude/workflows/<workflow-name>/phases/<phase>.md

Runtime state written to:
  .claude/workflow-state/<workflow-name>/
    current-phase.txt
    context.json
    logs/<timestamp>-<phase>.log
    lock                  (flock target; prevents concurrent runs)
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --resume) RESUME=true; shift ;;
    --max-iters) MAX_ITERS="$2"; shift 2 ;;
    --per-phase-timeout) PER_PHASE_TIMEOUT_SECS="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "unknown flag: $1" >&2; usage >&2; exit 1 ;;
    *)
      if [[ -n "$WORKFLOW_NAME" ]]; then
        echo "unexpected positional argument: $1" >&2; exit 1
      fi
      WORKFLOW_NAME="$1"; shift ;;
  esac
done

if [[ -z "$WORKFLOW_NAME" ]]; then
  echo "workflow name required" >&2
  usage >&2
  exit 1
fi

WORKFLOW_DIR=".claude/workflows/$WORKFLOW_NAME"
STATE_DIR=".claude/workflow-state/$WORKFLOW_NAME"
WORKFLOW_JSON="$WORKFLOW_DIR/workflow.json"
LOCK_FILE="$STATE_DIR/lock"

# --- Validation ------------------------------------------------------------

command -v claude >/dev/null || { echo "claude CLI not in PATH" >&2; exit 1; }
command -v jq >/dev/null || { echo "jq required" >&2; exit 1; }

# Prefer GNU 'timeout'; fall back to 'gtimeout' on macOS coreutils.
# If neither is installed, run without a per-phase timeout — long-running
# phases will be the operator's responsibility to interrupt.
if command -v timeout >/dev/null; then
  TIMEOUT_BIN="timeout"
elif command -v gtimeout >/dev/null; then
  TIMEOUT_BIN="gtimeout"
else
  TIMEOUT_BIN=""
  echo "[orchestrator] warning: no 'timeout'/'gtimeout' on PATH; per-phase timeout disabled" >&2
  echo "[orchestrator]          install GNU coreutils ('brew install coreutils') to enable" >&2
fi

if [[ ! -d "$WORKFLOW_DIR" ]]; then
  echo "workflow not found: $WORKFLOW_DIR" >&2
  exit 1
fi
if [[ ! -f "$WORKFLOW_JSON" ]]; then
  echo "workflow.json missing: $WORKFLOW_JSON" >&2
  exit 1
fi

jq -e '.entryPhase and .phases and .terminalPhases' "$WORKFLOW_JSON" >/dev/null \
  || { echo "workflow.json missing required keys (entryPhase / phases / terminalPhases)" >&2; exit 1; }

mkdir -p "$STATE_DIR/logs"

# --- Concurrency lock ------------------------------------------------------
# flock is part of util-linux and ships everywhere on Linux but is absent
# from macOS by default. If it's missing we surface a warning and run
# without lock protection — the single-maintainer workstation case is the
# norm and the user is expected to not double-start the same workflow by
# hand. `brew install flock` provides it on macOS.

if command -v flock >/dev/null; then
  exec 9>"$LOCK_FILE"
  if ! flock -n 9; then
    echo "another orchestrator is already running for workflow '$WORKFLOW_NAME'" >&2
    echo "(lock file: $LOCK_FILE)" >&2
    exit 1
  fi
else
  echo "[orchestrator] warning: flock not on PATH; concurrent-run protection disabled" >&2
  echo "[orchestrator]          install with 'brew install flock' on macOS to enable" >&2
fi

# --- Initial state ---------------------------------------------------------

if [[ "$RESUME" == false ]] || [[ ! -f "$STATE_DIR/current-phase.txt" ]]; then
  ENTRY=$(jq -r '.entryPhase' "$WORKFLOW_JSON")
  echo "$ENTRY" > "$STATE_DIR/current-phase.txt"
  echo '{}' > "$STATE_DIR/context.json"
  echo "[orchestrator] fresh start: workflow=$WORKFLOW_NAME entryPhase=$ENTRY"
else
  echo "[orchestrator] resuming workflow=$WORKFLOW_NAME at phase=$(cat "$STATE_DIR/current-phase.txt")"
fi

# Tempfile for the assembled prompt; cleaned up on exit.
PROMPT_FILE=$(mktemp -t cc-wf-prompt.XXXXXX)
trap 'rm -f "$PROMPT_FILE"' EXIT

# --- Helpers ---------------------------------------------------------------

phase_file() { jq -r --arg p "$1" '.phases[$p].file // empty' "$WORKFLOW_JSON"; }
phase_is_terminal() { jq -e --arg p "$1" '.terminalPhases | index($p)' "$WORKFLOW_JSON" >/dev/null; }
phase_is_declared() { jq -e --arg p "$1" '.phases[$p] // empty | length > 0' "$WORKFLOW_JSON" >/dev/null; }

# Build the prompt for a phase invocation into $PROMPT_FILE.
# Body comes from the phase markdown, plus an orchestrator-appended tail
# that lists the required final actions.
build_prompt() {
  local phase="$1"
  local phase_md="$2"
  local context_snapshot="$3"

  : > "$PROMPT_FILE"
  cat "$phase_md" >> "$PROMPT_FILE"
  {
    printf '\n\n---\n## Orchestrator-injected workflow context\n\n'
    printf 'Workflow name: %s\n' "$WORKFLOW_NAME"
    printf 'Current phase: %s\n' "$phase"
    printf 'State directory (relative to repo root): %s\n\n' "$STATE_DIR"
    printf 'Read live state from disk before deciding anything; this snapshot\n'
    printf 'is what the orchestrator saw at phase start and may be stale by\n'
    printf 'the time you read context.json yourself:\n\n'
    printf '```json\n%s\n```\n\n' "$context_snapshot"
  } >> "$PROMPT_FILE"
  cat <<'PROMPT_TAIL' >> "$PROMPT_FILE"
## Required final actions

Before you stop, perform every one of the following:

1. Atomically write the updated state to `<state-dir>/context.json`
   (substitute the orchestrator-supplied path above). Write to
   `<state-dir>/context.json.tmp` first, then `mv` it over the real path.
   Do not leave the file half-written if you are interrupted.
2. Write the chosen next phase name to `<state-dir>/current-phase.txt`
   (single identifier, no trailing prose). Valid next-phase identifiers
   are listed in this workflow's `workflow.json` under `phases.<current>.next`.
3. If you encountered a halt condition, set `next_phase` to `"HALT"` in
   context.json AND write `HALT` to current-phase.txt, AND include a
   one-sentence `halt_reason` field in context.json.

The orchestrator will refuse to advance if context.json is not updated
during this phase, so finishing without performing these writes is a
self-inflicted halt.
PROMPT_TAIL
}

run_phase() {
  local phase="$1"
  local rel
  rel=$(phase_file "$phase")
  if [[ -z "$rel" ]]; then
    echo "[orchestrator] no file declared for phase '$phase' in workflow.json" >&2
    return 1
  fi
  local file="$WORKFLOW_DIR/$rel"
  if [[ ! -f "$file" ]]; then
    echo "[orchestrator] phase file missing: $file" >&2
    return 1
  fi

  local log
  log="$STATE_DIR/logs/$(date -u +%Y-%m-%dT%H-%M-%SZ)-${phase}.log"
  echo "[orchestrator] phase=$phase log=$log"

  local context_before
  context_before=$(cat "$STATE_DIR/context.json")

  build_prompt "$phase" "$file" "$context_before"

  local rc=0
  if [[ -n "$TIMEOUT_BIN" ]]; then
    "$TIMEOUT_BIN" "$PER_PHASE_TIMEOUT_SECS" \
      claude --dangerously-skip-permissions -p "$(cat "$PROMPT_FILE")" \
      >>"$log" 2>&1 || rc=$?
  else
    claude --dangerously-skip-permissions -p "$(cat "$PROMPT_FILE")" \
      >>"$log" 2>&1 || rc=$?
  fi

  if [[ $rc -ne 0 ]]; then
    if [[ $rc -eq 124 ]]; then
      echo "[orchestrator] phase '$phase' exceeded ${PER_PHASE_TIMEOUT_SECS}s timeout" >&2
    else
      echo "[orchestrator] claude -p exited $rc on phase '$phase' (see $log)" >&2
    fi
    return 1
  fi

  # Detect "phase forgot to write context.json" by content comparison;
  # mtime is unreliable on macOS where filesystem mtime resolution is 1s
  # and a fast phase can complete in <1s after the orchestrator's read.
  local context_after
  context_after=$(cat "$STATE_DIR/context.json")
  if [[ "$context_after" == "$context_before" ]]; then
    echo "[orchestrator] phase '$phase' did not update context.json (see $log)" >&2
    return 1
  fi

  if ! jq empty "$STATE_DIR/context.json" 2>/dev/null; then
    echo "[orchestrator] context.json is not valid JSON after phase '$phase' (see $log)" >&2
    return 1
  fi
}

# --- Main loop -------------------------------------------------------------

ITER=0
while [[ $ITER -lt $MAX_ITERS ]]; do
  PHASE=$(tr -d '[:space:]' < "$STATE_DIR/current-phase.txt")

  if phase_is_terminal "$PHASE"; then
    case "$PHASE" in
      HALT)
        REASON=$(jq -r '.halt_reason // "no reason given"' "$STATE_DIR/context.json")
        echo "[orchestrator] HALT: $REASON"
        exit 2
        ;;
      *)
        echo "[orchestrator] workflow finished at terminal phase: $PHASE"
        exit 0
        ;;
    esac
  fi

  if ! phase_is_declared "$PHASE"; then
    echo "[orchestrator] phase '$PHASE' is neither declared in workflow.json nor a terminal phase" >&2
    exit 1
  fi

  if ! run_phase "$PHASE"; then
    echo "[orchestrator] phase '$PHASE' failed; halting" >&2
    exit 1
  fi

  ITER=$((ITER + 1))
done

echo "[orchestrator] max iterations ($MAX_ITERS) reached without hitting a terminal phase" >&2
exit 1
