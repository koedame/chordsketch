#!/usr/bin/env bash
# Generic Claude Code workflow orchestrator.
#
# Drives a phase-based workflow defined under .claude/workflows/<name>/.
# Each phase is a Markdown prompt that Claude Code executes via `claude -p`;
# inter-phase state lives in .claude/workflow-state/<name>/context.json.
#
# See .claude/workflows/README.md for the layout contract and how to add
# new workflows.
#
# Exit codes (also surfaced as the orchestrator's overall exit code):
#   0   workflow reached a non-HALT terminal phase
#   1   orchestrator-level error (missing file, invalid state, invalid arg)
#   2   workflow reached HALT — see halt_reason in context.json
#   3   phase did not update context.json
#   4   phase produced invalid JSON in context.json
#   124 phase exceeded the per-phase timeout

set -euo pipefail

# Require bash; this script uses [[ ]], BASH_SOURCE, arrays, etc.
if [[ -z "${BASH_VERSION:-}" ]]; then
  echo "bash required to run this script" >&2
  exit 1
fi

# Re-anchor to the actual repository root via git, not via $0's path. The
# script can be invoked from anywhere (worktrees, symlinks, packaged copies);
# the only invariant we trust is "I am inside a git checkout of chordsketch."
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
if REPO_ROOT=$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null); then
  cd "$REPO_ROOT"
else
  echo "run-workflow.sh must be invoked from inside a git checkout" >&2
  exit 1
fi

WORKFLOW_NAME=""
RESUME=false
FORCE=false
MAX_ITERS=50
PER_PHASE_TIMEOUT_SECS=3600

# Workflow- and phase-name regex. Kept in sync with
# scripts/validate-workflow.py:NAME_PATTERN and
# .claude/rules/workflow-discipline.md §"Naming".
NAME_REGEX='^[a-z0-9-]+$'

usage() {
  cat <<EOF
Usage: $0 <workflow-name> [--resume] [--force] [--max-iters N] [--per-phase-timeout SEC]

Arguments:
  workflow-name           Directory name under .claude/workflows/.
                          Must match $NAME_REGEX.

Flags:
  --resume                Continue from the saved current-phase.txt instead
                          of resetting to the workflow's entryPhase. Takes
                          precedence over --force when both are set: a
                          present current-phase.txt always resumes.
  --force                 Permit a fresh start that overwrites a non-empty
                          existing context.json. Without this flag, the
                          orchestrator refuses to clobber in-flight state.
                          Ignored if --resume is also set.
  --max-iters N           Hard cap on phase transitions (positive integer;
                          default 50). Guards against runaway loops.
  --per-phase-timeout S   Wall-clock cap per phase invocation, in seconds
                          (non-negative integer; default 3600).

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

require_positive_int() {
  # require_positive_int <flag-name> <value>
  if [[ ! "$2" =~ ^[1-9][0-9]*$ ]]; then
    echo "$1 requires a positive integer, got: $2" >&2
    exit 1
  fi
}

require_non_negative_int() {
  if [[ ! "$2" =~ ^[0-9]+$ ]]; then
    echo "$1 requires a non-negative integer, got: $2" >&2
    exit 1
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --resume) RESUME=true; shift ;;
    --force) FORCE=true; shift ;;
    --max-iters)
      [[ $# -ge 2 ]] || { echo "--max-iters requires a value" >&2; exit 1; }
      require_positive_int "--max-iters" "$2"
      MAX_ITERS="$2"; shift 2 ;;
    --per-phase-timeout)
      [[ $# -ge 2 ]] || { echo "--per-phase-timeout requires a value" >&2; exit 1; }
      require_non_negative_int "--per-phase-timeout" "$2"
      PER_PHASE_TIMEOUT_SECS="$2"; shift 2 ;;
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

# Hard boundary check: workflow name becomes part of every state-directory
# and lock path. An unvalidated name allows directory traversal (e.g.
# "../../etc/passwd"), which combined with --dangerously-skip-permissions
# would let a malicious or mis-typed workflow read/write outside the repo's
# .claude/ tree. The validator's NAME_PATTERN is the single source of
# truth; mirror it here.
if [[ ! "$WORKFLOW_NAME" =~ $NAME_REGEX ]]; then
  echo "invalid workflow name: $WORKFLOW_NAME (must match $NAME_REGEX)" >&2
  exit 1
fi

WORKFLOW_DIR=".claude/workflows/$WORKFLOW_NAME"
STATE_DIR=".claude/workflow-state/$WORKFLOW_NAME"
WORKFLOW_JSON="$WORKFLOW_DIR/workflow.json"
LOCK_FILE="$STATE_DIR/lock"

# --- External-tool requirements ------------------------------------------
# These are all hard requirements. The orchestrator runs Claude Code with
# `--dangerously-skip-permissions`, which means it MUST keep its own
# safety net (lock + timeout) intact. A silent fallback would degrade the
# documented guarantee in .claude/workflows/README.md "Workflows are
# exclusive: the flock under <state-dir>/lock prevents concurrent runs"
# without the operator noticing.

command -v claude >/dev/null || { echo "claude CLI not in PATH" >&2; exit 1; }
command -v jq >/dev/null || { echo "jq required" >&2; exit 1; }
command -v flock >/dev/null \
  || { echo "flock required (install GNU util-linux or 'brew install flock' on macOS)" >&2; exit 1; }

if command -v timeout >/dev/null; then
  TIMEOUT_BIN="timeout"
elif command -v gtimeout >/dev/null; then
  TIMEOUT_BIN="gtimeout"
else
  echo "timeout/gtimeout required (install GNU coreutils or 'brew install coreutils' on macOS)" >&2
  exit 1
fi

if [[ ! -d "$WORKFLOW_DIR" ]]; then
  echo "workflow not found: $WORKFLOW_DIR" >&2
  exit 1
fi
if [[ ! -f "$WORKFLOW_JSON" ]]; then
  echo "workflow.json missing: $WORKFLOW_JSON" >&2
  exit 1
fi

validate_workflow_json() {
  jq -e '.entryPhase and .phases and .terminalPhases' "$WORKFLOW_JSON" >/dev/null \
    || { echo "workflow.json missing required keys (entryPhase / phases / terminalPhases)" >&2; return 1; }
}
validate_workflow_json || exit 1

# Phase logs now capture projected stream-json tool-use arguments
# (Bash commands, sub-agent prompts, URLs) that a phase may legitimately
# pass on a command line — including the host's `$GH_TOKEN` whenever a
# tool call constructs a `https://x-access-token:…@github.com/…` URL.
# Force 0700 / 0600 on every file the orchestrator writes from here on so
# the state tree is owner-only, regardless of the maintainer's interactive
# umask. The jq projection also redacts known GitHub credential shapes
# before tee-ing to the log; the umask is the primary control, redaction
# is defence in depth.
umask 077
mkdir -p "$STATE_DIR/logs"

# --- Concurrency lock ----------------------------------------------------

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "another orchestrator is already running for workflow '$WORKFLOW_NAME'" >&2
  echo "(lock file: $LOCK_FILE)" >&2
  exit 1
fi

# --- Cleanup trap --------------------------------------------------------
# Tempfile lives inside the workflow's state directory (not $TMPDIR) so a
# crashed-mid-phase run leaves a discoverable artefact alongside the logs,
# and so the prompt content (which embeds context.json) never escapes the
# gitignored state tree.
PROMPT_FILE=$(mktemp "$STATE_DIR/prompt.XXXXXX")
chmod 600 "$PROMPT_FILE"

# Process group of the currently-running phase pipeline, or empty when no
# phase is running. Populated by run_phase before `wait`, cleared after.
PHASE_PGID=""

# SIGTERM → SIGKILL escalation budget for terminate_phase_group. Five
# iterations × 0.2 s ≈ 1 s gives claude's SIGTERM handler time to flush
# its final stream-json frame and any in-flight tool subprocess (git push,
# cargo build) time to release its temp files. Tune upward if `<log>`
# shows truncated final frames after Ctrl-C.
PHASE_TERM_GRACE_ITERS=5
PHASE_TERM_GRACE_SLEEP_SECS=0.2

# Terminate the phase pipeline's entire process group on Ctrl-C / SIGTERM
# / SIGHUP. claude (and any tool it spawned: git, gh, sub-agents) sits in
# this group; without the negative-PID form below, signaling only the
# subshell would leave the descendants reparented to init and the
# orchestrator's terminal would still appear hung.
terminate_phase_group() {
  if [[ -z "$PHASE_PGID" ]]; then
    return 0
  fi
  local pgid="$PHASE_PGID"
  PHASE_PGID=""
  echo "[orchestrator] terminating phase pipeline (pgid=$pgid)..." >&2
  kill -TERM "-$pgid" 2>/dev/null || true
  # Grace period before escalating to SIGKILL. `kill -0` returns non-zero
  # on either ESRCH (process gone — we're done) or EPERM (a privileged
  # descendant we can't signal — fall through to SIGKILL so we don't
  # silently leak it). Parse stderr to distinguish the two; ESRCH ends
  # the loop early, EPERM keeps iterating until the SIGKILL line below.
  local i err
  for ((i = 0; i < PHASE_TERM_GRACE_ITERS; i++)); do
    if err=$(kill -0 "-$pgid" 2>&1); then
      sleep "$PHASE_TERM_GRACE_SLEEP_SECS"
      continue
    fi
    case "$err" in
      *"No such process"*|*"no such process"*) return 0 ;;
      *) ;;  # EPERM or other — keep waiting, then SIGKILL
    esac
    sleep "$PHASE_TERM_GRACE_SLEEP_SECS"
  done
  kill -KILL "-$pgid" 2>/dev/null || true
}

# install_signal_traps / mask_signal_traps bracket the narrow windows in
# run_phase where PHASE_PGID is stale (empty pre-fork; just-cleared
# post-wait). Without the mask, a SIGINT arriving in those windows would
# trigger terminate_phase_group with a stale PHASE_PGID and either orphan
# the just-spawned subshell or no-op on a dead pgid while the orchestrator
# exits. Bash queues signals while their trap is `''`; reinstalling the
# real trap fires any queued signal against the now-populated PHASE_PGID.
install_signal_traps() {
  trap 'terminate_phase_group; exit 130' INT
  trap 'terminate_phase_group; exit 143' TERM
  trap 'terminate_phase_group; exit 129' HUP
}
mask_signal_traps() {
  trap '' INT TERM HUP
}

# Preserve the original exit code through cleanup. INT/TERM/HUP also fire
# the trap so a Ctrl-C mid-phase does not leak the prompt file (which can
# embed full issue bodies from context.json) and so the phase's process
# group is signaled before the orchestrator exits.
trap 'rc=$?; terminate_phase_group; rm -f "$PROMPT_FILE"; exit "$rc"' EXIT
install_signal_traps

# --- Initial state -------------------------------------------------------
# Log the claude binary version at startup so the operator can confirm
# which CLI is driving the workflow. evidence-based-claims.md: knowing
# which `claude` ran matters when reviewing logs later.
echo "[orchestrator] claude version: $(claude --version 2>/dev/null || echo '<unknown>')"

if [[ "$RESUME" == false ]] || [[ ! -f "$STATE_DIR/current-phase.txt" ]]; then
  # Refuse to clobber non-trivial in-flight state without explicit --force.
  if [[ -f "$STATE_DIR/context.json" ]] && [[ "$(cat "$STATE_DIR/context.json")" != "{}" ]] && [[ "$FORCE" == false ]]; then
    echo "refusing fresh start: $STATE_DIR/context.json is non-empty" >&2
    echo "  pass --resume to continue from current-phase.txt, or --force to overwrite" >&2
    exit 1
  fi
  ENTRY=$(jq -r '.entryPhase' "$WORKFLOW_JSON")
  echo "$ENTRY" > "$STATE_DIR/current-phase.txt"
  echo '{}' > "$STATE_DIR/context.json"
  echo "[orchestrator] fresh start: workflow=$WORKFLOW_NAME entryPhase=$ENTRY"
else
  echo "[orchestrator] resuming workflow=$WORKFLOW_NAME at phase=$(cat "$STATE_DIR/current-phase.txt")"
fi

# --- Helpers -------------------------------------------------------------

phase_file() { jq -r --arg p "$1" '.phases[$p].file // empty' "$WORKFLOW_JSON"; }
phase_is_terminal() { jq -e --arg p "$1" '.terminalPhases | index($p)' "$WORKFLOW_JSON" >/dev/null; }
phase_is_declared() { jq -e --arg p "$1" '.phases[$p] // empty | length > 0' "$WORKFLOW_JSON" >/dev/null; }

# Compare two context.json strings under canonical jq normalisation so that
# whitespace-only or key-order rewrites are not treated as semantic changes
# and, conversely, a phase that re-saved byte-identical content is detected.
context_unchanged() {
  local before_canon after_canon
  before_canon=$(printf '%s' "$1" | jq -S . 2>/dev/null || true)
  after_canon=$(jq -S . "$STATE_DIR/context.json" 2>/dev/null || true)
  [[ -n "$before_canon" && "$before_canon" == "$after_canon" ]]
}

# Build the prompt for a phase invocation into $PROMPT_FILE.
build_prompt() {
  local phase="$1"
  local phase_md="$2"
  local context_snapshot="$3"

  {
    cat "$phase_md"
    printf '\n\n---\n## Orchestrator-injected workflow context\n\n'
    printf 'Workflow name: %s\n' "$WORKFLOW_NAME"
    printf 'Current phase: %s\n' "$phase"
    printf 'State directory (relative to repo root): %s\n\n' "$STATE_DIR"
    printf 'Live state at phase start (you may re-read context.json yourself;\n'
    printf 'the orchestrator holds the only lock on this workflow so no\n'
    printf 'concurrent writer exists):\n\n'
    printf '```json\n%s\n```\n\n' "$context_snapshot"
    cat <<'PROMPT_TAIL'
## Required final actions

Before you stop, perform every one of the following:

1. Atomically write the updated state to `<state-dir>/context.json`
   (substitute the orchestrator-supplied path above). Write to
   `<state-dir>/context.json.tmp` first, then `command mv` it over the
   real path. Use `command mv` (NOT plain `mv`) so any `alias
   mv='mv -i'` in the user's interactive shell does not turn the
   rename into an interactive y/n prompt that hangs the phase
   indefinitely; the inner shell has no stdin, so a prompted `mv -i`
   blocks forever. Do not leave the file half-written if you are
   interrupted.
2. Write the chosen next phase name to `<state-dir>/current-phase.txt`
   on a single line (no trailing prose). Valid next-phase identifiers are
   listed in this workflow's `workflow.json` under `phases.<current>.next`
   or `terminalPhases`. The orchestrator parses only the first non-empty
   line; anything after it is ignored, so put rationale in the context.json
   instead.
3. If you encountered a halt condition, write `HALT` to current-phase.txt
   AND include a one-sentence `halt_reason` field in context.json.
   `halt_reason` is what the maintainer sees on the orchestrator's
   terminal output; write it as if speaking to someone who has not read
   the phase prompt.

The orchestrator refuses to advance if context.json is not semantically
updated during this phase, so finishing without performing the writes is a
self-inflicted halt. context.json comparison is canonical (jq -S), so
reformatting alone does not count as an update.
PROMPT_TAIL
  } > "$PROMPT_FILE"
}

dump_log_tail_on_failure() {
  local log="$1"
  echo "[orchestrator] --- last 30 lines of $log ---" >&2
  tail -n 30 "$log" >&2 || true
  echo "[orchestrator] --- end of log tail ---" >&2
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
  local start_ts
  start_ts=$(date +%s)
  echo "[orchestrator] phase=$phase started=$(date -u '+%Y-%m-%dT%H:%M:%SZ') log=$log"

  local context_before
  context_before=$(cat "$STATE_DIR/context.json")

  build_prompt "$phase" "$file" "$context_before"

  # Drive claude in streaming mode so the operator sees per-turn progress
  # instead of staring at a silent terminal until the phase finishes. The
  # stream is line-delimited JSON; jq projects each event into a human-
  # readable line (tool calls, assistant text, final result), and tee
  # mirrors that projection into the phase log so terminal and log carry
  # the same story. claude's stderr is appended to the log directly for
  # forensics.
  #
  # `jq -rR` reads raw lines and parses each via `fromjson` INSIDE the
  # `try ... catch empty` block. A bare `jq -r 'try (.type) catch empty'`
  # only catches errors evaluating the program against an already-parsed
  # value — a single non-JSON line still trips jq's parser and exits 5,
  # propagating as a phase failure under pipefail. The `try (fromjson |
  # ...)` shape moves parsing inside the catch boundary so a stray frame
  # (truncated NDJSON from a hard-killed claude; an interleaved warning;
  # a future stream-json format change) is silently dropped instead of
  # turning a successful phase into a spurious failure.
  #
  # An `awk 'length < …'` pre-filter caps any single line to ~1 MiB so a
  # pathological frame (e.g. a tool_result with megabytes of grep output)
  # cannot drive jq to OOM. `fflush()` keeps awk line-buffered through the
  # pipe so progress stays real-time.
  #
  # The `redact` jq def scrubs known GitHub credential shapes (ghp_ /
  # gho_ / ghs_ / ghu_ / github_pat_ / x-access-token:) from string
  # fields a phase might pass on a Bash command line or in a sub-agent
  # prompt. The umask 077 above keeps the log owner-only as the primary
  # control; redaction is defence in depth for the case where a phase
  # writes the log into an artifact bundle.
  #
  # The pipeline runs in a backgrounded subshell with `set -m` so it
  # gets its own process group (PGID == subshell PID). The orchestrator
  # then `wait`s on the subshell; `wait` is interruptible by signals,
  # so a Ctrl-C in the terminal immediately runs the INT trap, which
  # signals the whole phase process group via terminate_phase_group.
  # Without this isolation a claude process that ignores SIGINT (or any
  # long-running tool subprocess) would keep the foreground pipeline
  # alive and the orchestrator would appear unkillable from the
  # terminal until claude returned on its own.
  #
  # Inside the subshell, `set +m` switches job control back off so the
  # pipeline stages stay co-grouped under the subshell. `set -o pipefail`
  # makes the subshell's exit status the rightmost non-zero exit in the
  # pipeline; the leftmost stage is claude, so timeout(1)'s 124 (or any
  # claude failure) propagates intact to the orchestrator's rc==124
  # branch instead of being masked by a downstream stage's success.
  #
  # mask_signal_traps wraps the fork → PHASE_PGID assignment so a signal
  # in that one-statement window cannot orphan the just-spawned subshell.
  # install_signal_traps then re-arms the real handlers; any signal
  # queued during the mask fires the trap with PHASE_PGID populated.
  local rc=0
  mask_signal_traps
  set -m
  (
    set +m
    set -o pipefail
    "$TIMEOUT_BIN" "$PER_PHASE_TIMEOUT_SECS" \
      claude --dangerously-skip-permissions --verbose \
        --output-format=stream-json -p "$(cat "$PROMPT_FILE")" \
        2>>"$log" \
      | awk 'length < 1048576 { print; fflush() }' \
      | jq -rR --unbuffered '
          def redact:
            gsub("ghp_[A-Za-z0-9_]{20,}"; "[REDACTED]")
            | gsub("gho_[A-Za-z0-9_]{20,}"; "[REDACTED]")
            | gsub("ghs_[A-Za-z0-9_]{20,}"; "[REDACTED]")
            | gsub("ghu_[A-Za-z0-9_]{20,}"; "[REDACTED]")
            | gsub("github_pat_[A-Za-z0-9_]+"; "[REDACTED]")
            | gsub("x-access-token:[^@\\s]+"; "[REDACTED]");
          def norm:
            gsub("\\s+"; " ") | sub("^ +"; "") | sub(" +$"; "");
          try (
            fromjson |
            if .type == "assistant" then
              (.message.content // [])[] |
              if .type == "text" and ((.text // "") | length) > 0 then
                "[claude] " + (.text | norm | redact | .[0:240])
              elif .type == "tool_use" then
                "[tool]  " + .name + (
                  .input as $i |
                  if   ($i.command // null)     then ": " + ($i.command     | norm | redact | .[0:160])
                  elif ($i.file_path // null)   then ": " + ($i.file_path   | .[0:200])
                  elif ($i.path // null)        then ": " + ($i.path        | .[0:200])
                  elif ($i.description // null) then ": " + ($i.description | norm | redact | .[0:160])
                  elif ($i.prompt // null)      then ": " + ($i.prompt      | norm | redact | .[0:160])
                  elif ($i.url // null)         then ": " + ($i.url         | redact | .[0:160])
                  elif ($i.query // null)       then ": " + ($i.query       | norm | .[0:160])
                  elif ($i.pattern // null)     then ": " + ($i.pattern     | .[0:160])
                  else "" end
                )
              else empty end
            elif .type == "result" then
              "[claude] result=" + (.subtype // "ok")
              + (if .duration_ms    then " duration=" + (.duration_ms / 1000 | floor | tostring) + "s" else "" end)
              + (if .total_cost_usd then " cost=$"    + (.total_cost_usd | tostring)                   else "" end)
            elif .type == "system" and .subtype == "init" then
              "[claude] session=" + ((.session_id // "?") | tostring | .[0:8])
            else empty end
          ) catch empty
        ' \
      | tee -a "$log"
  ) &
  PHASE_PGID=$!
  set +m
  install_signal_traps

  # `wait <pid>` failing under set -e would abort run_phase; `|| rc=$?`
  # captures the pipefail-aware exit code without disabling errexit so a
  # future edit inside this block cannot leak errexit-off into the main
  # loop the way a `set +e` / `set -e` toggle could.
  wait "$PHASE_PGID" || rc=$?
  # Brief mask while clearing PHASE_PGID — a signal racing this single
  # assignment would otherwise fire terminate_phase_group against a
  # just-finished pgid (harmless ESRCH) which the trap is already happy
  # to no-op, but the symmetry keeps the windows uniformly closed.
  mask_signal_traps
  PHASE_PGID=""
  install_signal_traps
  local elapsed
  elapsed=$(( $(date +%s) - start_ts ))

  if [[ $rc -ne 0 ]]; then
    if [[ $rc -eq 124 ]]; then
      echo "[orchestrator] phase '$phase' exceeded ${PER_PHASE_TIMEOUT_SECS}s timeout after ${elapsed}s (see $log)" >&2
      dump_log_tail_on_failure "$log"
      return 124
    fi
    echo "[orchestrator] claude -p exited $rc on phase '$phase' after ${elapsed}s (see $log)" >&2
    dump_log_tail_on_failure "$log"
    return 1
  fi

  echo "[orchestrator] phase=$phase finished in ${elapsed}s"

  if ! jq empty "$STATE_DIR/context.json" 2>/dev/null; then
    echo "[orchestrator] context.json is not valid JSON after phase '$phase' (see $log)" >&2
    dump_log_tail_on_failure "$log"
    return 4
  fi

  if context_unchanged "$context_before"; then
    echo "[orchestrator] phase '$phase' did not semantically update context.json (see $log)" >&2
    dump_log_tail_on_failure "$log"
    return 3
  fi
}

read_next_phase() {
  # Read only the first non-empty line, capped at 256 bytes so a runaway
  # phase that wrote prose into current-phase.txt does not pull megabytes
  # into memory. Strip surrounding whitespace.
  head -c 256 "$STATE_DIR/current-phase.txt" \
    | awk 'NF { gsub(/^[[:space:]]+|[[:space:]]+$/, "", $0); print; exit }'
}

# --- Main loop -----------------------------------------------------------

ITER=0
while [[ $ITER -lt $MAX_ITERS ]]; do
  # Re-validate workflow.json each iteration so mid-run corruption surfaces
  # with the right error rather than as "unknown phase".
  validate_workflow_json || exit 1

  PHASE=$(read_next_phase)
  if [[ -z "$PHASE" ]]; then
    echo "[orchestrator] $STATE_DIR/current-phase.txt is empty after parsing" >&2
    exit 1
  fi

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

  run_phase "$PHASE" || exit $?

  ITER=$((ITER + 1))
done

echo "[orchestrator] max iterations ($MAX_ITERS) reached without hitting a terminal phase" >&2
exit 1
