#!/usr/bin/env python3
"""Behaviour tests for the `chocolatey-generate-package` composite action.

The bash in `.github/actions/chocolatey-generate-package/action.yml` turns a
release's `checksums.txt` and the two files under `packaging/chocolatey/`
into the `choco-pkg/` tree that `chocolatey-pack-push` packs. It runs on
`windows-latest` during a release fan-out and nowhere else, so a template
that grows a placeholder the generator does not fill, or a checksum layout
change that stops the extraction matching, would first surface as a broken
release.

These tests lift the step's `run:` body out of `action.yml` and execute it
under bash with the runner's wrapper (`--noprofile --norc -eo pipefail`),
against the repository's real templates in a scratch workspace. Using the
real templates is what makes the "no placeholder survives" case a guard
rather than a restatement of the sed lines: a new `{{...}}` in either
template fails here instead of shipping an unsubstituted install script.

The last case guards the reason this action exists — that both publication
paths call it, rather than carrying copies of the step that drift apart.

Usage:
    python3 -m unittest scripts/test_chocolatey_generate_package.py

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
from _action_yml import extract_step_run  # noqa: E402

REPO_ROOT = SCRIPTS_DIR.parent
ACTION_YML = REPO_ROOT / ".github" / "actions" / "chocolatey-generate-package" / "action.yml"
PACKAGING = REPO_ROOT / "packaging" / "chocolatey"
WORKFLOWS = REPO_ROOT / ".github" / "workflows"

BASH = os.environ.get("BASH") or "bash"
BASH_PATH = shutil.which(BASH)

VERSION = "0.6.0"
SHA = "a" * 64

# What GitHub runs an inline `shell: bash` body with. `-e` and `pipefail`
# both matter here: they decide whether a checksums.txt with no Windows row
# reaches the step's own error message or dies at the assignment.
RUNNER_ARGS = ["--noprofile", "--norc", "-eo", "pipefail"]

OTHER_TARGETS = (
    f"{'1' * 64}  chordsketch-v{VERSION}-x86_64-unknown-linux-gnu.tar.gz\n"
    f"{'2' * 64}  chordsketch-v{VERSION}-aarch64-apple-darwin.tar.gz\n"
)
WINDOWS_ROW = f"{SHA}  chordsketch-v{VERSION}-x86_64-pc-windows-msvc.zip\n"

GENERATED = ("choco-pkg/chordsketch.nuspec", "choco-pkg/tools/chocolateyInstall.ps1")


class _Result:
    def __init__(self, code: int, out: str, err: str, files: dict[str, str], wrote_package: bool):
        self.code = code
        self.out = out
        self.err = err
        self.files = files
        self.wrote_package = wrote_package


class GenerateStepTest(unittest.TestCase):
    """Runs the step body under bash in a scratch workspace."""

    @classmethod
    def setUpClass(cls) -> None:
        if BASH_PATH is None:
            raise unittest.SkipTest(f"{BASH!r} not found on PATH")
        cls.body = extract_step_run(ACTION_YML.read_text(encoding="utf-8"), "Generate package")

    def run_step(self, *, checksums: str, version: str = VERSION) -> _Result:
        with tempfile.TemporaryDirectory() as tmp:
            work = Path(tmp)
            # The real templates, so a placeholder added to either one is
            # visible to these assertions.
            shutil.copytree(PACKAGING, work / "packaging" / "chocolatey")
            (work / "checksums.txt").write_text(checksums, encoding="utf-8")

            script = work / "step.sh"
            script.write_text(self.body + "\n", encoding="utf-8")

            proc = subprocess.run(
                [BASH_PATH, *RUNNER_ARGS, str(script)],
                cwd=work,
                env={**os.environ, "VERSION": version},
                capture_output=True,
                text=True,
            )
            # Read the outputs back before the scratch directory goes away.
            files = {
                relative: (work / relative).read_text(encoding="utf-8")
                for relative in GENERATED
                if (work / relative).exists()
            }
            return _Result(
                proc.returncode, proc.stdout, proc.stderr, files, (work / "choco-pkg").exists()
            )

    def generated(self, result: _Result, relative: str) -> str:
        self.assertIn(relative, result.files, f"{relative} was not written (exit {result.code})")
        return result.files[relative]

    def test_fills_both_templates_with_the_version_and_the_windows_checksum(self) -> None:
        result = self.run_step(checksums=OTHER_TARGETS + WINDOWS_ROW)
        self.assertEqual(0, result.code, result.err)

        nuspec = self.generated(result, "choco-pkg/chordsketch.nuspec")
        self.assertIn(f"<version>{VERSION}</version>", nuspec)

        install = self.generated(result, "choco-pkg/tools/chocolateyInstall.ps1")
        self.assertIn(f"checksum64     = '{SHA}'", install)
        self.assertIn(f"chordsketch-v{VERSION}-x86_64-pc-windows-msvc.zip", install)

    def test_no_placeholder_survives_in_either_generated_file(self) -> None:
        # Fails when a template grows a `{{...}}` the step has no sed rule
        # for — the drift this action exists to keep to one place.
        result = self.run_step(checksums=WINDOWS_ROW)
        self.assertEqual(0, result.code, result.err)
        for relative in GENERATED:
            self.assertNotIn(
                "{{", self.generated(result, relative), f"unsubstituted placeholder in {relative}"
            )

    def test_echoes_both_generated_files_into_the_log(self) -> None:
        result = self.run_step(checksums=WINDOWS_ROW)
        self.assertIn("=== chordsketch.nuspec ===", result.out)
        self.assertIn("=== chocolateyInstall.ps1 ===", result.out)
        self.assertIn(SHA, result.out)

    def test_accepts_uppercase_hex(self) -> None:
        # `sha256sum` writes lowercase, but the guard accepts [0-9a-fA-F];
        # a checksums.txt produced by another tool must not be rejected.
        upper = "B" * 64
        result = self.run_step(
            checksums=f"{upper}  chordsketch-v{VERSION}-x86_64-pc-windows-msvc.zip\n"
        )
        self.assertEqual(0, result.code, result.err)
        self.assertIn(upper, self.generated(result, "choco-pkg/tools/chocolateyInstall.ps1"))

    def test_a_truncated_checksum_fails_before_anything_is_written(self) -> None:
        result = self.run_step(
            checksums=f"{'a' * 63}  chordsketch-v{VERSION}-x86_64-pc-windows-msvc.zip\n"
        )
        self.assertNotEqual(0, result.code)
        self.assertIn("missing or invalid SHA256 for x86_64-pc-windows-msvc", result.err)
        self.assertFalse(result.wrote_package, "choco-pkg was written despite a rejected checksum")

    def test_a_checksums_file_without_the_windows_target_says_so(self) -> None:
        # Regression guard for the shape of failure, not just the fact of
        # it. Extracting the checksum with `grep | awk` made this case exit
        # at the assignment under `-eo pipefail`, so the release log showed
        # a bare "Process completed with exit code 1" and the guard's
        # message never ran - the same unreadable failure #1852 spent a
        # release diagnosing by hand on the push side of this workflow.
        result = self.run_step(checksums=OTHER_TARGETS)
        self.assertNotEqual(0, result.code)
        self.assertIn("missing or invalid SHA256 for x86_64-pc-windows-msvc", result.err)
        self.assertFalse(result.wrote_package, "choco-pkg was written without a Windows checksum")

    def test_a_duplicated_windows_row_fails_rather_than_concatenating(self) -> None:
        # Two matching rows make the extraction yield two lines, which no
        # `checksum64` should ever be. The guard rejects it, and says which
        # value it rejected.
        result = self.run_step(checksums=WINDOWS_ROW + WINDOWS_ROW)
        self.assertNotEqual(0, result.code)
        self.assertIn("missing or invalid SHA256 for x86_64-pc-windows-msvc", result.err)
        self.assertFalse(result.wrote_package, "choco-pkg was written from an ambiguous checksum")


class CallersTest(unittest.TestCase):
    """Both publication paths must go through the action, not a copy of it."""

    CALLERS = ("post-release.yml", "chocolatey-retry.yml")

    def test_both_workflows_call_the_action(self) -> None:
        for name in self.CALLERS:
            text = (WORKFLOWS / name).read_text(encoding="utf-8")
            self.assertIn("uses: ./.github/actions/chocolatey-generate-package", text, name)

    def test_no_workflow_still_generates_the_package_inline(self) -> None:
        for name in self.CALLERS:
            text = (WORKFLOWS / name).read_text(encoding="utf-8")
            self.assertNotIn(
                "packaging/chocolatey/", text, f"{name} generates the package inline again"
            )


if __name__ == "__main__":
    unittest.main()
