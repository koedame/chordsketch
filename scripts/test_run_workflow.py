#!/usr/bin/env python3
"""End-to-end smoke test for `scripts/run-workflow.sh`.

Builds a synthetic repo root in a tempdir (initialised as a git repo so
the orchestrator's `git rev-parse --show-toplevel` resolves), containing:
  - a copy of `scripts/run-workflow.sh`,
  - a two-phase `test-wf` workflow,
  - stub `claude`, `flock`, and `timeout` binaries on PATH that emulate
    real behaviour without invoking the real commands.

Asserts the orchestrator advances through the phases, exits with the
right code, propagates failures rather than masking them, validates
its own inputs, and honours --resume vs --force semantics.

This is a smoke test — it verifies the orchestrator's plumbing without
contacting any real Claude API.
"""
from __future__ import annotations

import fcntl
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

SCRIPTS_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPTS_DIR.parent
ORCHESTRATOR = SCRIPTS_DIR / "run-workflow.sh"


def _materialize_repo(tmp: Path) -> Path:
    """Create a fake repo root and copy the orchestrator into it.

    The fake root is initialised as a git repository because the
    orchestrator anchors `REPO_ROOT` via `git rev-parse --show-toplevel`.
    """
    repo = tmp / "repo"
    (repo / "scripts").mkdir(parents=True)
    shutil.copy(ORCHESTRATOR, repo / "scripts" / "run-workflow.sh")
    (repo / "scripts" / "run-workflow.sh").chmod(0o755)
    # Minimal git init — empty repo is enough for `git rev-parse
    # --show-toplevel` to succeed.
    subprocess.run(
        ["git", "init", "--quiet", str(repo)],
        check=True,
        capture_output=True,
    )
    return repo


def _make_test_workflow(repo: Path, name: str = "test-wf") -> Path:
    """Define a tiny two-phase workflow under the fake repo's .claude/workflows."""
    wf_dir = repo / ".claude" / "workflows" / name
    (wf_dir / "phases").mkdir(parents=True)
    workflow_json = {
        "name": name,
        "description": "smoke-test workflow",
        "entryPhase": "step-1",
        "phases": {
            "step-1": {"file": "phases/step-1.md", "next": ["step-2", "HALT"]},
            "step-2": {"file": "phases/step-2.md", "next": ["done", "HALT"]},
        },
        "terminalPhases": ["done", "HALT"],
    }
    (wf_dir / "workflow.json").write_text(json.dumps(workflow_json), encoding="utf-8")
    (wf_dir / "phases" / "step-1.md").write_text(
        "# Phase: step-1\n## Output\nSet current-phase.txt to step-2 or HALT.\n",
        encoding="utf-8",
    )
    (wf_dir / "phases" / "step-2.md").write_text(
        "# Phase: step-2\n## Output\nSet current-phase.txt to done or HALT.\n",
        encoding="utf-8",
    )
    return wf_dir


# Stub claude. Parses the orchestrator-injected prompt for the state
# directory path, then writes the next state. The stub is deliberately
# NOT a generic reusable claude replacement — a banner comment warns
# anyone who finds the file on disk after a crashed test.
STUB_CLAUDE = r"""#!/usr/bin/env bash
# DO NOT REUSE — TEST STUB. This file is created by
# scripts/test_run_workflow.py to emulate `claude -p`'s side-effects
# without invoking the real CLI. It is permissive on purpose and is
# unsafe to use outside that test harness.
set -euo pipefail

if [[ "${1:-}" == "--version" ]]; then
  echo "stub-claude 0.0.0"
  exit 0
fi

# Find the -p argument's value.
prompt=""
prev=""
for arg in "$@"; do
  if [[ "$prev" == "-p" || "$prev" == "--print" ]]; then
    prompt="$arg"
  fi
  prev="$arg"
done

state_dir=$(printf '%s' "$prompt" \
  | grep -oE 'State directory \(relative to repo root\): [^[:space:]]+' \
  | head -1 \
  | sed 's/^State directory (relative to repo root): //')
if [[ -z "$state_dir" ]]; then
  echo "stub-claude: could not find state dir in prompt" >&2
  exit 64
fi
phase=$(tr -d '[:space:]' < "$state_dir/current-phase.txt")
prior=$(cat "$state_dir/context.json")

case "${STUB_MODE:-ADVANCE}" in
  ADVANCE)
    case "$phase" in
      step-1)
        printf '%s' "$prior" \
          | python3 -c 'import sys, json; d=json.loads(sys.stdin.read() or "{}"); d["step1"]="ran"; print(json.dumps(d))' \
          > "$state_dir/context.json.tmp"
        mv "$state_dir/context.json.tmp" "$state_dir/context.json"
        printf 'step-2' > "$state_dir/current-phase.txt"
        ;;
      step-2)
        printf '%s' "$prior" \
          | python3 -c 'import sys, json; d=json.loads(sys.stdin.read() or "{}"); d["step2"]="ran"; print(json.dumps(d))' \
          > "$state_dir/context.json.tmp"
        mv "$state_dir/context.json.tmp" "$state_dir/context.json"
        printf 'done' > "$state_dir/current-phase.txt"
        ;;
      *)
        echo "stub-claude: unexpected phase $phase" >&2
        exit 65
        ;;
    esac
    ;;
  HALT_AT_STEP1)
    printf '%s' "$prior" \
      | python3 -c 'import sys, json; d=json.loads(sys.stdin.read() or "{}"); d["halt_reason"]="forced halt for test"; print(json.dumps(d))' \
      > "$state_dir/context.json.tmp"
    mv "$state_dir/context.json.tmp" "$state_dir/context.json"
    printf 'HALT' > "$state_dir/current-phase.txt"
    ;;
  NO_WRITE_AT_STEP1)
    # Touch nothing; the orchestrator must detect the missing update.
    :
    ;;
  INVALID_JSON_AT_STEP1)
    printf 'not-json' > "$state_dir/context.json"
    printf 'step-2' > "$state_dir/current-phase.txt"
    ;;
  REFORMAT_ONLY_AT_STEP1)
    # Pretty-print prior context without semantic change. The orchestrator
    # uses canonical jq -S comparison, so this must still register as
    # "did not update."
    printf '%s' "$prior" | jq . > "$state_dir/context.json.tmp"
    mv "$state_dir/context.json.tmp" "$state_dir/context.json"
    printf 'step-2' > "$state_dir/current-phase.txt"
    ;;
  *)
    echo "stub-claude: unknown STUB_MODE ${STUB_MODE:-}" >&2
    exit 66
    ;;
esac
exit 0
"""

# flock and timeout stubs — small wrappers so the test runs even on hosts
# that don't have GNU coreutils / util-linux installed. The stubs are
# transparent: flock acquires (via flock -n on a fd we control) and the
# timeout stub just exec's the inner command.
STUB_FLOCK = r"""#!/usr/bin/env bash
# Test stub: real lock semantics via Python's fcntl. Implements only the
# `flock -n <fd>` invocation used by the orchestrator. Returns 0 on
# acquire, 1 on contention.
set -euo pipefail
nb=false
fd=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -n) nb=true; shift ;;
    -h|--help) echo "stub-flock: -n <fd>"; exit 0 ;;
    *) fd="$1"; shift ;;
  esac
done
if [[ -z "$fd" ]]; then
  echo "stub-flock: missing fd" >&2; exit 1
fi
python3 - "$fd" "$nb" <<'PY'
import fcntl, os, sys
fd = int(sys.argv[1])
nb = sys.argv[2] == "true"
try:
    flags = fcntl.LOCK_EX | (fcntl.LOCK_NB if nb else 0)
    fcntl.flock(fd, flags)
except OSError:
    sys.exit(1)
PY
"""

STUB_TIMEOUT = r"""#!/usr/bin/env bash
# Test stub: parses GNU-timeout-style invocation `timeout <secs> cmd args...`
# and just exec's the inner command. We do not actually enforce the
# timeout — the smoke test's stub claude returns quickly.
set -euo pipefail
secs="$1"; shift
# Validate the seconds arg so we surface 'invalid timeout' the way the
# real timeout does.
if [[ ! "$secs" =~ ^[0-9]+$ ]]; then
  echo "stub-timeout: invalid duration: $secs" >&2; exit 125
fi
exec "$@"
"""


def _write_executable(path: Path, content: str) -> Path:
    path.write_text(content, encoding="utf-8")
    path.chmod(path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    return path


def _make_stubs(repo: Path) -> Path:
    """Install fake `claude`, `flock`, `timeout` binaries in `<repo>/bin/`.

    Real binaries that happen to be on the host PATH would still be picked
    up by `command -v` first, so we prepend the bin dir on the orchestrator
    subprocess's PATH to ensure ours win.
    """
    bin_dir = repo / "bin"
    bin_dir.mkdir(parents=True, exist_ok=True)
    _write_executable(bin_dir / "claude", STUB_CLAUDE)
    _write_executable(bin_dir / "flock", STUB_FLOCK)
    _write_executable(bin_dir / "timeout", STUB_TIMEOUT)
    return bin_dir


def _run_orchestrator(
    repo: Path,
    *args: str,
    env: dict[str, str] | None = None,
) -> subprocess.CompletedProcess[str]:
    """Invoke the orchestrator with `<repo>/bin/` prepended to PATH."""
    base_env = os.environ.copy()
    if env:
        base_env.update(env)
    base_env["PATH"] = f"{repo / 'bin'}{os.pathsep}{base_env.get('PATH', '')}"
    return subprocess.run(
        [str(repo / "scripts" / "run-workflow.sh"), *args],
        capture_output=True,
        text=True,
        env=base_env,
        cwd=str(repo),
        check=False,
    )


class OrchestratorSmokeTests(unittest.TestCase):
    def test_help_flag_exits_zero(self) -> None:
        with TemporaryDirectory() as tmp:
            repo = _materialize_repo(Path(tmp))
            _make_stubs(repo)
            cp = _run_orchestrator(repo, "--help")
            self.assertEqual(cp.returncode, 0, msg=cp.stderr)
            self.assertIn("Usage:", cp.stdout)

    def test_missing_workflow_dir(self) -> None:
        with TemporaryDirectory() as tmp:
            repo = _materialize_repo(Path(tmp))
            _make_stubs(repo)
            cp = _run_orchestrator(repo, "nonexistent")
            self.assertEqual(cp.returncode, 1)
            self.assertIn("workflow not found", cp.stderr)

    def test_full_advance_to_terminal(self) -> None:
        with TemporaryDirectory() as tmp:
            repo = _materialize_repo(Path(tmp))
            _make_test_workflow(repo)
            _make_stubs(repo)
            cp = _run_orchestrator(repo, "test-wf", env={"STUB_MODE": "ADVANCE"})
            self.assertEqual(
                cp.returncode, 0,
                msg=f"stdout: {cp.stdout}\nstderr: {cp.stderr}",
            )
            self.assertIn("workflow finished at terminal phase: done", cp.stdout)
            state = json.loads(
                (repo / ".claude" / "workflow-state" / "test-wf" / "context.json").read_text()
            )
            self.assertEqual(state.get("step1"), "ran")
            self.assertEqual(state.get("step2"), "ran")

    def test_halt_path(self) -> None:
        with TemporaryDirectory() as tmp:
            repo = _materialize_repo(Path(tmp))
            _make_test_workflow(repo)
            _make_stubs(repo)
            cp = _run_orchestrator(repo, "test-wf", env={"STUB_MODE": "HALT_AT_STEP1"})
            self.assertEqual(
                cp.returncode, 2,
                msg=f"stdout: {cp.stdout}\nstderr: {cp.stderr}",
            )
            self.assertIn("HALT: forced halt for test", cp.stdout)

    def test_missing_state_update_returns_dedicated_exit_code(self) -> None:
        with TemporaryDirectory() as tmp:
            repo = _materialize_repo(Path(tmp))
            _make_test_workflow(repo)
            _make_stubs(repo)
            cp = _run_orchestrator(repo, "test-wf", env={"STUB_MODE": "NO_WRITE_AT_STEP1"})
            # Exit code 3 is reserved for "phase did not update context.json".
            self.assertEqual(cp.returncode, 3, msg=cp.stderr)
            self.assertTrue(
                re.search(r"did not semantically update context\.json", cp.stderr),
                msg=cp.stderr,
            )

    def test_invalid_json_returns_dedicated_exit_code(self) -> None:
        with TemporaryDirectory() as tmp:
            repo = _materialize_repo(Path(tmp))
            _make_test_workflow(repo)
            _make_stubs(repo)
            cp = _run_orchestrator(repo, "test-wf", env={"STUB_MODE": "INVALID_JSON_AT_STEP1"})
            self.assertEqual(cp.returncode, 4, msg=cp.stderr)
            self.assertIn("not valid JSON", cp.stderr)

    def test_reformat_only_is_detected_as_no_change(self) -> None:
        """A phase that pretty-prints prior context without changing semantics
        must be detected as a no-update — proving the jq -S canonical
        comparison works, not just byte equality."""
        with TemporaryDirectory() as tmp:
            repo = _materialize_repo(Path(tmp))
            _make_test_workflow(repo)
            _make_stubs(repo)
            # Seed prior context with a non-trivial value so the reformat is
            # semantically a no-op but byte-different.
            state_dir = repo / ".claude" / "workflow-state" / "test-wf"
            state_dir.mkdir(parents=True)
            (state_dir / "current-phase.txt").write_text("step-1", encoding="utf-8")
            (state_dir / "context.json").write_text(
                json.dumps({"prior": "value"}), encoding="utf-8"
            )
            cp = _run_orchestrator(
                repo, "test-wf", "--resume",
                env={"STUB_MODE": "REFORMAT_ONLY_AT_STEP1"},
            )
            self.assertEqual(cp.returncode, 3, msg=cp.stderr)

    def test_resume_does_not_rerun_completed_phase(self) -> None:
        """--resume must read current-phase.txt; the entry phase must not
        re-execute. Use a sentinel value that ADVANCE at step-1 would
        overwrite, then assert it survives."""
        with TemporaryDirectory() as tmp:
            repo = _materialize_repo(Path(tmp))
            _make_test_workflow(repo)
            _make_stubs(repo)
            state_dir = repo / ".claude" / "workflow-state" / "test-wf"
            state_dir.mkdir(parents=True)
            (state_dir / "current-phase.txt").write_text("step-2", encoding="utf-8")
            # Sentinel that ADVANCE@step-1 would overwrite to "ran".
            (state_dir / "context.json").write_text(
                json.dumps({"step1": "seeded-not-overwritten"}),
                encoding="utf-8",
            )
            cp = _run_orchestrator(
                repo, "test-wf", "--resume",
                env={"STUB_MODE": "ADVANCE"},
            )
            self.assertEqual(
                cp.returncode, 0,
                msg=f"stdout: {cp.stdout}\nstderr: {cp.stderr}",
            )
            self.assertIn("resuming", cp.stdout)
            state = json.loads((state_dir / "context.json").read_text())
            # If --resume falsely re-ran step-1, step1 would be "ran".
            self.assertEqual(state["step1"], "seeded-not-overwritten")
            self.assertEqual(state["step2"], "ran")

    def test_fresh_start_refuses_to_clobber_non_empty_context(self) -> None:
        with TemporaryDirectory() as tmp:
            repo = _materialize_repo(Path(tmp))
            _make_test_workflow(repo)
            _make_stubs(repo)
            state_dir = repo / ".claude" / "workflow-state" / "test-wf"
            state_dir.mkdir(parents=True)
            (state_dir / "current-phase.txt").write_text("step-1", encoding="utf-8")
            (state_dir / "context.json").write_text(
                json.dumps({"important": "state"}), encoding="utf-8"
            )
            cp = _run_orchestrator(repo, "test-wf")  # no --resume, no --force
            self.assertEqual(cp.returncode, 1)
            self.assertIn("refusing fresh start", cp.stderr)
            # State must be untouched.
            state = json.loads((state_dir / "context.json").read_text())
            self.assertEqual(state, {"important": "state"})

    def test_force_overrides_non_empty_context(self) -> None:
        with TemporaryDirectory() as tmp:
            repo = _materialize_repo(Path(tmp))
            _make_test_workflow(repo)
            _make_stubs(repo)
            state_dir = repo / ".claude" / "workflow-state" / "test-wf"
            state_dir.mkdir(parents=True)
            (state_dir / "current-phase.txt").write_text("step-1", encoding="utf-8")
            (state_dir / "context.json").write_text(
                json.dumps({"stale": "value"}), encoding="utf-8"
            )
            cp = _run_orchestrator(repo, "test-wf", "--force", env={"STUB_MODE": "ADVANCE"})
            self.assertEqual(cp.returncode, 0, msg=cp.stderr)
            # After full advance the stale field must not be present
            # (--force reset context to {} before the workflow ran).
            state = json.loads((state_dir / "context.json").read_text())
            self.assertNotIn("stale", state)
            self.assertEqual(state["step1"], "ran")
            self.assertEqual(state["step2"], "ran")

    def test_invalid_workflow_name_rejected_at_boundary(self) -> None:
        """Workflow names that escape NAME_REGEX must be rejected before
        any directory creation. Path traversal must be impossible."""
        with TemporaryDirectory() as tmp:
            repo = _materialize_repo(Path(tmp))
            _make_stubs(repo)
            for bad in ("../escape", "ab/cd", "UPPER", "with space", "", "..", "."):
                cp = _run_orchestrator(repo, bad)
                self.assertEqual(
                    cp.returncode, 1,
                    msg=f"bad name {bad!r} accepted; stderr={cp.stderr}",
                )
                # Either invalid-name error or empty-name handling kicks in.
                self.assertTrue(
                    "invalid workflow name" in cp.stderr
                    or "workflow name required" in cp.stderr,
                    msg=f"bad name {bad!r}: {cp.stderr}",
                )

    def test_invalid_max_iters_rejected_at_parse_time(self) -> None:
        with TemporaryDirectory() as tmp:
            repo = _materialize_repo(Path(tmp))
            _make_stubs(repo)
            for bad in ("foo", "0", "-1", "1.5"):
                cp = _run_orchestrator(repo, "test-wf", "--max-iters", bad)
                self.assertEqual(
                    cp.returncode, 1,
                    msg=f"bad --max-iters {bad!r} accepted; stderr={cp.stderr}",
                )
                self.assertIn("--max-iters requires a positive integer", cp.stderr)

    def test_missing_max_iters_value_rejected(self) -> None:
        with TemporaryDirectory() as tmp:
            repo = _materialize_repo(Path(tmp))
            _make_stubs(repo)
            cp = _run_orchestrator(repo, "test-wf", "--max-iters")
            self.assertEqual(cp.returncode, 1)
            self.assertIn("--max-iters requires a value", cp.stderr)

    def test_invalid_per_phase_timeout_rejected(self) -> None:
        with TemporaryDirectory() as tmp:
            repo = _materialize_repo(Path(tmp))
            _make_stubs(repo)
            cp = _run_orchestrator(repo, "test-wf", "--per-phase-timeout", "abc")
            self.assertEqual(cp.returncode, 1)
            self.assertIn(
                "--per-phase-timeout requires a non-negative integer",
                cp.stderr,
            )

    def test_concurrent_run_is_blocked_by_lock(self) -> None:
        """Two parallel orchestrator invocations against the same workflow
        must not both run. The second must exit with the lock-contention
        error."""
        with TemporaryDirectory() as tmp:
            repo = _materialize_repo(Path(tmp))
            _make_test_workflow(repo)
            _make_stubs(repo)

            # Hold the lock from a Python file descriptor so the
            # orchestrator's `flock -n` cannot acquire it.
            state_dir = repo / ".claude" / "workflow-state" / "test-wf"
            state_dir.mkdir(parents=True, exist_ok=True)
            lock_file = state_dir / "lock"
            lock_file.touch()
            holder = open(lock_file, "w")
            try:
                fcntl.flock(holder.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                cp = _run_orchestrator(
                    repo, "test-wf",
                    env={"STUB_MODE": "ADVANCE"},
                )
                self.assertEqual(cp.returncode, 1, msg=cp.stderr)
                self.assertIn(
                    "another orchestrator is already running",
                    cp.stderr,
                )
            finally:
                fcntl.flock(holder.fileno(), fcntl.LOCK_UN)
                holder.close()


if __name__ == "__main__":
    unittest.main()
