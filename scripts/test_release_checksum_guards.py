#!/usr/bin/env python3
"""Every release channel must say which checksum it could not find.

`post-release.yml` fans a release out to Homebrew, Scoop, AUR, Flathub and
Chocolatey. Each of those jobs downloads the release's `checksums.txt`, pulls
one or more SHA256 values out of it, and validates them before filling a
packaging template. The validation exists so that a missing or malformed
checksum names itself in the log rather than surfacing later as a package
that installs the wrong bytes.

That message is only worth having if it can be reached. The workflow sets
`defaults.run.shell: bash`, so every step runs under `-eo pipefail`, and
`SHA=$(grep ... | awk ...)` therefore ends the step at the assignment when
`grep` matches nothing — before the validation below it runs. The job failed
with a bare "Process completed with exit code 1", which is the same
unreadable failure the Chocolatey push path cost a release to diagnose by
hand in #1852.

These tests run each of those step bodies against a `checksums.txt` that
holds no recognised target, under the same shell wrapper the runner uses,
and assert the guard actually speaks. Discovery is by content rather than by
a hard-coded list of step names, so a channel added later is held to the same
bar without anyone remembering to register it here.

Usage:
    python3 -m unittest scripts/test_release_checksum_guards.py

Set `BASH` to override the interpreter (default: `bash` on `PATH`).
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS_DIR))
from _action_yml import iter_step_runs  # noqa: E402

REPO_ROOT = SCRIPTS_DIR.parent
WORKFLOW = REPO_ROOT / ".github" / "workflows" / "post-release.yml"

BASH = os.environ.get("BASH") or "bash"
BASH_PATH = shutil.which(BASH)

# The wrapper `defaults.run.shell: bash` resolves to. `pipefail` is the part
# that decides whether a non-matching extraction reaches the guard.
RUNNER_ARGS = ["--noprofile", "--norc", "-eo", "pipefail"]

# A checksums.txt for a release that shipped no target any channel wants —
# the shape of the failure the guards exist to report.
NO_KNOWN_TARGET = f"{'1' * 64}  chordsketch-v9.9.9-riscv64-unknown-none.tar.gz\n"

# One extracting step per publication channel, at the time of writing:
# Homebrew, Scoop, AUR, Flathub. Chocolatey generates through the
# `chocolatey-generate-package` composite action, which
# `test_chocolatey_generate_package.py` covers the same way. Asserted as a
# floor so that a discovery bug cannot quietly reduce this suite to nothing.
MIN_EXTRACTING_STEPS = 4


def extracting_steps() -> list[tuple[str, str]]:
    """Steps that read a SHA out of `checksums.txt`."""
    text = WORKFLOW.read_text(encoding="utf-8")
    return [
        (name, body)
        for name, body in iter_step_runs(text)
        if "checksums.txt" in body and "SHA_" in body
    ]


class ChecksumGuardTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        if BASH_PATH is None:
            raise unittest.SkipTest(f"{BASH!r} not found on PATH")
        cls.steps = extracting_steps()

    def test_every_publication_channel_is_covered(self) -> None:
        self.assertGreaterEqual(
            len(self.steps),
            MIN_EXTRACTING_STEPS,
            "found fewer checksum-extracting steps than there are release channels; "
            "either a channel stopped validating its checksum, or the scanner missed it",
        )

    def test_a_release_missing_the_target_names_the_checksum_in_the_log(self) -> None:
        for name, body in self.steps:
            with self.subTest(step=name):
                with tempfile.TemporaryDirectory() as tmp:
                    work = Path(tmp)
                    (work / "checksums.txt").write_text(NO_KNOWN_TARGET, encoding="utf-8")
                    script = work / "step.sh"
                    script.write_text(body + "\n", encoding="utf-8")

                    proc = subprocess.run(
                        [BASH_PATH, *RUNNER_ARGS, str(script)],
                        cwd=work,
                        # A well-formed version, so the only thing these steps
                        # can object to is the checksum.
                        env={**os.environ, "VERSION": "9.9.9"},
                        capture_output=True,
                        text=True,
                    )

                    self.assertNotEqual(0, proc.returncode, "step accepted a missing checksum")
                    self.assertIn(
                        "missing or invalid SHA256",
                        proc.stderr,
                        "step failed without saying which checksum was missing — the "
                        "bare exit code that #1852 had to diagnose by hand",
                    )


if __name__ == "__main__":
    unittest.main()
