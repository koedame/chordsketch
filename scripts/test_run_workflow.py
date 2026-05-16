#!/usr/bin/env python3
"""End-to-end smoke test for `scripts/run-workflow.sh`.

Builds a synthetic repo root in a tempdir containing:
  - a copy of `scripts/run-workflow.sh`,
  - a two-phase `test-wf` workflow,
  - a stub `claude` binary on PATH that emulates a phase run by writing
    the expected state files based on the orchestrator-supplied paths,
then asserts the orchestrator advances through the phases and exits
with the right code and state.

This is a smoke test, not a unit test — it verifies the orchestrator's
plumbing (file layout, state handoff, lock, terminal handling, HALT
path) without actually invoking Claude.
"""
from __future__ import annotations

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
    """Copy the orchestrator into a fake repo root inside `tmp`.

    The fake root only needs the script — the orchestrator computes
    paths relative to its own location, not relative to git metadata.
    """
    repo = tmp / "repo"
    (repo / "scripts").mkdir(parents=True)
    shutil.copy(ORCHESTRATOR, repo / "scripts" / "run-workflow.sh")
    (repo / "scripts" / "run-workflow.sh").chmod(0o755)
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
        "# Phase: step-1\n## Output\nSet next_phase to step-2 or HALT.\n",
        encoding="utf-8",
    )
    (wf_dir / "phases" / "step-2.md").write_text(
        "# Phase: step-2\n## Output\nSet next_phase to done or HALT.\n",
        encoding="utf-8",
    )
    return wf_dir


# The stub claude script reads the prompt (passed via -p), grepps for the
# state directory path (the orchestrator embeds it as
# "State directory (relative to repo root): <path>"), reads the current
# phase, and writes the next state.
#
# Mode controls what the stub does:
#   ADVANCE — write valid transitions: step-1 → step-2 → done
#   HALT_AT_STEP1 — write HALT from step-1
#   NO_WRITE_AT_STEP1 — do nothing (orchestrator should error out)
STUB_CLAUDE = r"""#!/usr/bin/env bash
set -euo pipefail
# Find the -p argument's value.
prompt=""
prev=""
for arg in "$@"; do
  if [[ "$prev" == "-p" || "$prev" == "--print" ]]; then
    prompt="$arg"
  fi
  prev="$arg"
done
# Locate the orchestrator-supplied state-directory path.
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
  *)
    echo "stub-claude: unknown STUB_MODE ${STUB_MODE:-}" >&2
    exit 66
    ;;
esac
exit 0
"""


def _make_stub_claude(repo: Path) -> Path:
    """Install a fake `claude` binary in `<repo>/bin/`."""
    bin_dir = repo / "bin"
    bin_dir.mkdir(parents=True, exist_ok=True)
    stub = bin_dir / "claude"
    stub.write_text(STUB_CLAUDE, encoding="utf-8")
    stub.chmod(stub.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    return stub


def _run_orchestrator(repo: Path, *args: str, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    """Invoke the orchestrator script with `<repo>/bin/` prepended to PATH."""
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
            _make_stub_claude(repo)
            cp = _run_orchestrator(repo, "--help")
            self.assertEqual(cp.returncode, 0, msg=cp.stderr)
            self.assertIn("Usage:", cp.stdout)

    def test_missing_workflow_dir(self) -> None:
        with TemporaryDirectory() as tmp:
            repo = _materialize_repo(Path(tmp))
            _make_stub_claude(repo)
            cp = _run_orchestrator(repo, "nonexistent")
            self.assertEqual(cp.returncode, 1)
            self.assertIn("workflow not found", cp.stderr)

    def test_full_advance_to_terminal(self) -> None:
        with TemporaryDirectory() as tmp:
            repo = _materialize_repo(Path(tmp))
            _make_test_workflow(repo)
            _make_stub_claude(repo)
            cp = _run_orchestrator(repo, "test-wf", env={"STUB_MODE": "ADVANCE"})
            self.assertEqual(cp.returncode, 0, msg=f"stdout: {cp.stdout}\nstderr: {cp.stderr}")
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
            _make_stub_claude(repo)
            cp = _run_orchestrator(repo, "test-wf", env={"STUB_MODE": "HALT_AT_STEP1"})
            self.assertEqual(cp.returncode, 2, msg=f"stdout: {cp.stdout}\nstderr: {cp.stderr}")
            self.assertIn("HALT: forced halt for test", cp.stdout)

    def test_missing_state_update_is_detected(self) -> None:
        with TemporaryDirectory() as tmp:
            repo = _materialize_repo(Path(tmp))
            _make_test_workflow(repo)
            _make_stub_claude(repo)
            cp = _run_orchestrator(repo, "test-wf", env={"STUB_MODE": "NO_WRITE_AT_STEP1"})
            self.assertEqual(cp.returncode, 1, msg=f"stdout: {cp.stdout}\nstderr: {cp.stderr}")
            self.assertTrue(
                re.search(r"did not update context\.json", cp.stderr),
                msg=cp.stderr,
            )

    def test_resume_picks_up_saved_phase(self) -> None:
        """A `--resume` run should not reset to entryPhase."""
        with TemporaryDirectory() as tmp:
            repo = _materialize_repo(Path(tmp))
            _make_test_workflow(repo)
            _make_stub_claude(repo)
            # Seed state as if step-1 had completed.
            state_dir = repo / ".claude" / "workflow-state" / "test-wf"
            state_dir.mkdir(parents=True)
            (state_dir / "current-phase.txt").write_text("step-2", encoding="utf-8")
            (state_dir / "context.json").write_text(
                json.dumps({"step1": "ran"}), encoding="utf-8"
            )
            cp = _run_orchestrator(
                repo,
                "test-wf",
                "--resume",
                env={"STUB_MODE": "ADVANCE"},
            )
            self.assertEqual(cp.returncode, 0, msg=f"stdout: {cp.stdout}\nstderr: {cp.stderr}")
            self.assertIn("resuming", cp.stdout)
            self.assertIn("workflow finished at terminal phase: done", cp.stdout)


if __name__ == "__main__":
    unittest.main()
