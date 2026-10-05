#!/usr/bin/env python3
"""Pushing to the shared tap must survive another job pushing first.

One release fans out to `koedame/homebrew-tap` from three jobs
(`post-release.yml`'s Homebrew CLI formula, `desktop-release.yml`'s cask and
Desktop formula) and to `koedame/scoop-bucket` from a fourth. They run at the
same time, each cloning the repository, committing a different file and
pushing. The one that pushes second is rejected as non-fast-forward, which
failed `Update Homebrew Desktop Formula` on the v0.8.0 release.

These tests run each of those `Push to ...` step bodies against local bare
repositories, with a competing push landing between the step's clone and its
push, under the shell wrapper the runner uses.

Usage:
    python3 -m unittest scripts/test_tap_push_retry.py

Set `BASH` to override the interpreter (default: `bash` on `PATH`).
"""
from __future__ import annotations

import os
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS_DIR))
from _action_yml import iter_step_runs  # noqa: E402

REPO_ROOT = SCRIPTS_DIR.parent
WORKFLOWS = REPO_ROOT / ".github" / "workflows"

BASH = os.environ.get("BASH") or "bash"
BASH_PATH = shutil.which(BASH)
GIT_PATH = shutil.which("git")

RUNNER_ARGS = ["--noprofile", "--norc", "-eo", "pipefail"]

# Homebrew CLI formula, Desktop cask, Desktop formula, Scoop. Asserted as a
# floor so a scanner bug cannot quietly reduce this suite to nothing.
MIN_PUSH_STEPS = 4


def push_steps() -> list[tuple[str, str, str]]:
    """`(workflow, step name, body)` for every step that pushes to the tap or bucket."""
    found = []
    for workflow in ("post-release.yml", "desktop-release.yml"):
        text = (WORKFLOWS / workflow).read_text(encoding="utf-8")
        for name, body in iter_step_runs(text):
            if "git push" in body and ("homebrew-tap.git" in body or "scoop-bucket.git" in body):
                found.append((workflow, name, body))
    return found


def git(*args: str, cwd: Path, env: dict[str, str]) -> None:
    subprocess.run([GIT_PATH, *args], cwd=cwd, env=env, check=True, capture_output=True, text=True)


class TapPushRetryTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        if BASH_PATH is None or GIT_PATH is None:
            raise unittest.SkipTest("bash and git are required")
        cls.steps = push_steps()

    def test_every_push_to_the_tap_is_covered(self) -> None:
        self.assertGreaterEqual(len(self.steps), MIN_PUSH_STEPS)

    def run_step(self, body: str, rivals: int) -> tuple[subprocess.CompletedProcess, Path]:
        """Run `body` while `rivals` competing pushes land before its own push."""
        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, tmp, True)
        env = {
            **os.environ,
            "GIT_CONFIG_GLOBAL": str(tmp / "gitconfig"),
            "GIT_CONFIG_SYSTEM": os.devnull,
            "GIT_TERMINAL_PROMPT": "0",
            "VERSION": "9.9.9",
            "TAP_TOKEN": "token",
        }
        remote = tmp / "remote.git"
        git("init", "--bare", "-b", "main", str(remote), cwd=tmp, env=env)
        seed = tmp / "seed"
        git("clone", str(remote), str(seed), cwd=tmp, env=env)
        git("config", "user.name", "seed", cwd=seed, env=env)
        git("config", "user.email", "seed@example.com", cwd=seed, env=env)
        (seed / "README").write_text("tap\n", encoding="utf-8")
        git("add", "README", cwd=seed, env=env)
        git("commit", "-m", "seed", cwd=seed, env=env)
        git("push", "origin", "HEAD:main", cwd=seed, env=env)

        for repo in ("homebrew-tap", "scoop-bucket"):
            url = f"https://x-access-token:token@github.com/koedame/{repo}.git"
            git("config", "--global", "--add", f"url.{remote}.insteadOf", url, cwd=tmp, env=env)

        # A `git` that lets a competing job push just before each of the
        # step's first `rivals` pushes, so the step's own push is rejected.
        shim_dir = tmp / "bin"
        shim_dir.mkdir()
        counter = tmp / "rivals-left"
        counter.write_text(str(rivals), encoding="utf-8")
        shim = shim_dir / "git"
        shim.write_text(
            f"""#!/bin/bash
if [ "${{1:-}}" = push ] && [ "$(cat {counter})" -gt 0 ]; then
  n=$(cat {counter})
  echo $((n - 1)) > {counter}
  rival={tmp}/rival-$n
  {GIT_PATH} clone -q {remote} "$rival"
  {GIT_PATH} -C "$rival" -c user.name=rival -c user.email=rival@example.com \\
    commit -q --allow-empty -m "rival $n"
  {GIT_PATH} -C "$rival" push -q origin HEAD:main
fi
exec {GIT_PATH} "$@"
""",
            encoding="utf-8",
        )
        shim.chmod(shim.stat().st_mode | stat.S_IEXEC)
        env["PATH"] = f"{shim_dir}{os.pathsep}{env['PATH']}"

        work = tmp / "work"
        work.mkdir()
        # The steps copy a generated file from the parent of the clone.
        for generated in ("chordsketch.rb", "chordsketch-desktop.rb", "chordsketch.json"):
            (work / generated).write_text("generated\n", encoding="utf-8")
        script = work / "step.sh"
        script.write_text(body + "\n", encoding="utf-8")
        proc = subprocess.run(
            [BASH_PATH, *RUNNER_ARGS, str(script)],
            cwd=work, env=env, capture_output=True, text=True,
        )
        return proc, remote

    def log(self, remote: Path) -> str:
        return subprocess.run(
            [GIT_PATH, "-C", str(remote), "log", "--format=%s", "main"],
            capture_output=True, text=True, check=True,
        ).stdout

    def test_a_push_rejected_because_another_job_pushed_first_is_retried(self) -> None:
        for workflow, name, body in self.steps:
            with self.subTest(workflow=workflow, step=name):
                proc, remote = self.run_step(body, rivals=2)
                self.assertEqual(0, proc.returncode, proc.stderr)
                log = self.log(remote)
                self.assertIn("rival 1", log)
                self.assertIn("rival 2", log)
                self.assertIn("Update chordsketch", log, "the step's own commit was lost")

    def test_a_push_that_is_never_accepted_fails_the_step_with_a_message(self) -> None:
        for workflow, name, body in self.steps:
            with self.subTest(workflow=workflow, step=name):
                proc, _ = self.run_step(body, rivals=100)
                self.assertNotEqual(0, proc.returncode)
                self.assertIn("could not push", proc.stderr)


if __name__ == "__main__":
    unittest.main()
