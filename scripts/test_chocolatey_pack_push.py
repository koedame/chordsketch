#!/usr/bin/env python3
"""Behaviour tests for the `chocolatey-pack-push` composite action.

The PowerShell in `.github/actions/chocolatey-pack-push/action.yml` is what
stands between a Chocolatey moderation queue and a failed release: it turns
`choco push`'s single exit code 1 into "already published" (409), "blocked by
moderation" (403), or a genuine failure, and it decides whether the release
job goes green. That code runs on `windows-latest` and only during a release
fan-out, so a regression in it is invisible until the next release breaks —
which is how the 403 handling came to exist in only one of the two callers in
the first place (#1852).

These tests lift each `run:` body out of `action.yml` and execute it under
`pwsh` with `choco` and the Chocolatey feed replaced by stubs, reproducing
the runner's wrapper (see `_RUNNER_PRELUDE`). They assert the exit code and
the workflow-command annotations for every branch.

Scope: the action's control flow, not Chocolatey itself. The step bodies run
on Linux `pwsh` here rather than `windows-latest`; what they exercise is HTTP
status handling, string matching against captured output, and exit codes,
none of which is platform-specific. `choco` is never invoked for real.

Usage:
    python3 -m unittest scripts/test_chocolatey_pack_push.py

Set `PWSH` to override the interpreter (default: `pwsh` on `PATH`). The whole
module skips when no `pwsh` is available, so the repo's other Python unit
tests still run on a machine without PowerShell.
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
ACTION_YML = REPO_ROOT / ".github" / "actions" / "chocolatey-pack-push" / "action.yml"

PWSH = os.environ.get("PWSH") or "pwsh"
PWSH_PATH = shutil.which(PWSH)

VERSION = "0.6.0"
NUPKG = f"chordsketch.{VERSION}.nupkg"

# What GitHub wraps around an inline `shell: pwsh` body: the runner invokes
# `pwsh -command ". '<file>'"` with `$ErrorActionPreference = 'stop'`
# prepended and the $LASTEXITCODE propagation appended.
#
# `$PSNativeCommandUseErrorActionPreference` is deliberately NOT set here —
# it defaults to $false in every shipping PowerShell (7.4 through 7.6, per
# about_Preference_Variables), so leaving it alone is what reproduces the
# runner. `STRICT_NATIVE_PRELUDE` below opts a test into the enabled mode,
# which is the ambient setting the Push step's local pins exist to survive.
_RUNNER_PRELUDE = """\
$ErrorActionPreference = 'stop'
"""
STRICT_NATIVE_PRELUDE = "$PSNativeCommandUseErrorActionPreference = $true\n"

# `exit N` inside a dot-sourced script does NOT propagate N through
# `pwsh -command ". '<file>'"` — the process reports 1 for any non-zero N
# (measured on pwsh 7.4.2; `-File` propagates, `-command` does not). The
# runner uses the `-command` form, so tests assert "non-zero" plus the
# annotation that names the real code, never the code itself.
_RUNNER_EPILOGUE = """
if ((Test-Path -LiteralPath variable:\\LASTEXITCODE)) { exit $LASTEXITCODE }
"""


_ACTION_TEXT = ACTION_YML.read_text(encoding="utf-8") if ACTION_YML.exists() else ""


class _Result:
    def __init__(self, code: int, out: str, outputs: dict[str, str], choco_log: str):
        self.code = code
        self.out = out
        self.outputs = outputs
        self.choco_log = choco_log


class _StepTestCase(unittest.TestCase):
    """Runs one step body under pwsh in a scratch workspace."""

    step_name = ""

    @classmethod
    def setUpClass(cls) -> None:
        if PWSH_PATH is None:
            raise unittest.SkipTest(f"{PWSH!r} not found on PATH")
        cls.body = extract_step_run(_ACTION_TEXT, cls.step_name)

    def run_step(
        self,
        *,
        env: dict[str, str] | None = None,
        feed: str = "",
        choco_pack_exit: int = 0,
        choco_pack_creates: bool = True,
        choco_push_exit: int = 0,
        choco_push_output: str = "",
        make_nupkg: bool = False,
        strict_native: bool = False,
    ) -> _Result:
        with tempfile.TemporaryDirectory() as tmp:
            work = Path(tmp)
            pkg = work / "choco-pkg"
            (pkg / "tools").mkdir(parents=True)
            (pkg / "chordsketch.nuspec").write_text("<package/>", encoding="utf-8")
            if make_nupkg:
                (pkg / NUPKG).write_text("stub", encoding="utf-8")

            github_output = work / "github_output"
            github_output.touch()
            choco_log = work / "choco.log"

            bindir = work / "bin"
            bindir.mkdir()
            stub = bindir / "choco"
            stub.write_text(
                "#!/bin/sh\n"
                'printf "%s\\n" "$*" >> "$CHOCO_LOG"\n'
                'if [ "$1" = "pack" ]; then\n'
                '  [ "$CHOCO_PACK_CREATES" = "1" ] && : > "$CHOCO_NUPKG"\n'
                '  exit "$CHOCO_PACK_EXIT"\n'
                "fi\n"
                'if [ "$1" = "push" ]; then\n'
                '  [ -n "$CHOCO_PUSH_OUTPUT" ] && printf "%s\\n" "$CHOCO_PUSH_OUTPUT"\n'
                '  exit "$CHOCO_PUSH_EXIT"\n'
                "fi\n"
                "exit 99\n",
                encoding="utf-8",
            )
            stub.chmod(0o755)

            script = work / "step.ps1"
            prelude = _RUNNER_PRELUDE + (STRICT_NATIVE_PRELUDE if strict_native else "")
            script.write_text(
                prelude + feed + "\n" + self.body + _RUNNER_EPILOGUE,
                encoding="utf-8",
            )

            proc_env = {
                **os.environ,
                "PATH": f"{bindir}{os.pathsep}{os.environ.get('PATH', '')}",
                "GITHUB_OUTPUT": str(github_output),
                "CHOCO_LOG": str(choco_log),
                "CHOCO_NUPKG": str(pkg / NUPKG),
                "CHOCO_PACK_EXIT": str(choco_pack_exit),
                "CHOCO_PACK_CREATES": "1" if choco_pack_creates else "0",
                "CHOCO_PUSH_EXIT": str(choco_push_exit),
                "CHOCO_PUSH_OUTPUT": choco_push_output,
                # PowerShell needs this to start without a full ICU install.
                "DOTNET_SYSTEM_GLOBALIZATION_INVARIANT": os.environ.get(
                    "DOTNET_SYSTEM_GLOBALIZATION_INVARIANT", "1"
                ),
            }
            for key in ("CHOCOLATEY_API_KEY", "ON_MISSING_KEY", "ON_FORBIDDEN", "VERSION"):
                proc_env.pop(key, None)
            proc_env.update(env or {})

            proc = subprocess.run(
                [PWSH_PATH, "-NoLogo", "-NoProfile", "-Command", f". '{script}'"],
                cwd=work,
                env=proc_env,
                capture_output=True,
                text=True,
                timeout=120,
            )
            outputs = {}
            for line in github_output.read_text(encoding="utf-8").splitlines():
                if "=" in line:
                    key, _, value = line.partition("=")
                    outputs[key] = value
            return _Result(
                proc.returncode,
                proc.stdout + proc.stderr,
                outputs,
                choco_log.read_text(encoding="utf-8") if choco_log.exists() else "",
            )


class ExtractorTest(unittest.TestCase):
    """The extractor must fail loudly rather than yield a vacuous body."""

    def test_every_step_body_is_found(self):
        for name, marker in (
            ("Resolve push preconditions", "on-missing-key must be"),
            ("Pack", "choco pack"),
            ("Push", "403 \\(Forbidden\\)"),
        ):
            with self.subTest(step=name):
                self.assertIn(marker, extract_step_run(_ACTION_TEXT, name))

    def test_unknown_step_raises(self):
        with self.assertRaises(AssertionError):
            extract_step_run(_ACTION_TEXT, "No Such Step")

    def test_step_without_run_block_raises(self):
        with self.assertRaises(AssertionError):
            extract_step_run("    - name: Bare\n      uses: ./somewhere\n", "Bare")


class PreconditionsTest(_StepTestCase):
    step_name = "Resolve push preconditions"

    def test_key_present_sets_push_true(self):
        r = self.run_step(env={"CHOCOLATEY_API_KEY": "k", "ON_MISSING_KEY": "skip", "ON_FORBIDDEN": "warn"})
        self.assertEqual(r.code, 0, r.out)
        self.assertEqual(r.outputs.get("push"), "true")

    def test_key_present_with_fail_disposition_still_pushes(self):
        r = self.run_step(env={"CHOCOLATEY_API_KEY": "k", "ON_MISSING_KEY": "fail", "ON_FORBIDDEN": "fail"})
        self.assertEqual(r.code, 0, r.out)
        self.assertEqual(r.outputs.get("push"), "true")

    def test_missing_key_with_skip_is_green_and_sets_push_false(self):
        r = self.run_step(env={"CHOCOLATEY_API_KEY": "", "ON_MISSING_KEY": "skip", "ON_FORBIDDEN": "warn"})
        self.assertEqual(r.code, 0, r.out)
        self.assertEqual(r.outputs.get("push"), "false")
        self.assertIn("skipping Chocolatey push", r.out)
        self.assertNotIn("::error::", r.out)

    def test_missing_key_with_fail_errors(self):
        r = self.run_step(env={"CHOCOLATEY_API_KEY": "", "ON_MISSING_KEY": "fail", "ON_FORBIDDEN": "fail"})
        self.assertEqual(r.code, 1, r.out)
        self.assertIn("::error::CHOCOLATEY_API_KEY is not set", r.out)
        self.assertNotIn("push", r.outputs)

    def test_missing_key_with_fail_names_the_command_that_sets_it(self):
        r = self.run_step(env={"CHOCOLATEY_API_KEY": "", "ON_MISSING_KEY": "fail", "ON_FORBIDDEN": "fail"})
        self.assertIn("gh secret set CHOCOLATEY_API_KEY", r.out)

    def test_unknown_on_missing_key_is_rejected(self):
        r = self.run_step(env={"CHOCOLATEY_API_KEY": "k", "ON_MISSING_KEY": "skipp", "ON_FORBIDDEN": "warn"})
        self.assertEqual(r.code, 1, r.out)
        self.assertIn("::error::on-missing-key must be 'skip' or 'fail', got 'skipp'", r.out)

    def test_disposition_matching_is_case_insensitive(self):
        # `-notin` / `-eq` compare strings case-insensitively in PowerShell, so
        # `Skip` is accepted and behaves as `skip`. Pinned because both the
        # validation and the later dispositions rely on that agreeing: a
        # case-sensitive validator with case-insensitive dispositions (or the
        # reverse) would accept a value it then failed to act on.
        r = self.run_step(env={"CHOCOLATEY_API_KEY": "", "ON_MISSING_KEY": "Skip", "ON_FORBIDDEN": "WARN"})
        self.assertEqual(r.code, 0, r.out)
        self.assertEqual(r.outputs.get("push"), "false")

    def test_unknown_on_forbidden_is_rejected_before_any_push(self):
        # The point of validating here: `on-forbidden` is not read until a
        # push has already been refused, so a typo would otherwise only
        # surface on the one run that hits a 403.
        r = self.run_step(env={"CHOCOLATEY_API_KEY": "k", "ON_MISSING_KEY": "skip", "ON_FORBIDDEN": "warm"})
        self.assertEqual(r.code, 1, r.out)
        self.assertIn("::error::on-forbidden must be 'warn' or 'fail', got 'warm'", r.out)


class PackTest(_StepTestCase):
    step_name = "Pack"

    def test_pack_success(self):
        r = self.run_step(env={"VERSION": VERSION}, make_nupkg=False, choco_pack_creates=True)
        self.assertEqual(r.code, 0, r.out)
        self.assertIn("pack chordsketch.nuspec", r.choco_log)

    def test_pack_failure_reports_the_exit_code(self):
        r = self.run_step(env={"VERSION": VERSION}, choco_pack_exit=3, choco_pack_creates=False)
        self.assertNotEqual(r.code, 0, r.out)
        self.assertIn("::error::choco pack failed with exit code 3", r.out)

    def test_pack_reads_the_exit_code_rather_than_throwing(self):
        # Guards the assumption the step is written against: with the runner's
        # ambient preferences a failing native command does not throw, so the
        # `if ($LASTEXITCODE -ne 0)` branch below it is reachable and the
        # annotation actually gets emitted. Under the strict preference it
        # would throw first and the diagnosis would be lost, which is why the
        # Push step pins the preference locally and this step does not need to.
        r = self.run_step(env={"VERSION": VERSION}, choco_pack_exit=3, choco_pack_creates=False)
        self.assertIn("choco pack failed with exit code 3", r.out)
        self.assertNotIn("NativeCommandExitException", r.out)

    def test_pack_success_without_a_nupkg_is_caught(self):
        r = self.run_step(env={"VERSION": VERSION}, choco_pack_exit=0, choco_pack_creates=False)
        self.assertEqual(r.code, 1, r.out)
        self.assertIn(f"::error::choco pack reported success but {NUPKG} is missing", r.out)


def _feed(status: int | None) -> str:
    """A stub `Invoke-WebRequest`; `None` means the host is unreachable."""
    if status is None:
        return (
            "function Invoke-WebRequest {\n"
            "  [CmdletBinding()] param([string]$Uri, [switch]$SkipHttpErrorCheck)\n"
            "  throw 'No such host is known.'\n"
            "}\n"
        )
    return (
        "function Invoke-WebRequest {\n"
        "  [CmdletBinding()] param([string]$Uri, [switch]$SkipHttpErrorCheck)\n"
        f"  [pscustomobject]@{{ StatusCode = {status} }}\n"
        "}\n"
    )


class PushTest(_StepTestCase):
    step_name = "Push"

    BASE = {"CHOCOLATEY_API_KEY": "k", "ON_FORBIDDEN": "warn", "VERSION": VERSION}

    def push(self, **kw):
        env = {**self.BASE, **kw.pop("env", {})}
        kw.setdefault("make_nupkg", True)
        return self.run_step(env=env, **kw)

    def test_version_already_on_the_feed_short_circuits_without_pushing(self):
        r = self.push(feed=_feed(200))
        self.assertEqual(r.code, 0, r.out)
        self.assertIn("::notice::chordsketch 0.6.0 is already on the Chocolatey", r.out)
        self.assertEqual(r.choco_log, "", "choco must not be invoked when the feed already has it")

    def test_feed_404_proceeds_to_push(self):
        r = self.push(feed=_feed(404), choco_push_exit=0)
        self.assertEqual(r.code, 0, r.out)
        self.assertIn("::notice::Pushed chordsketch 0.6.0", r.out)
        self.assertIn("push", r.choco_log)

    def test_unreadable_feed_warns_and_pushes_anyway(self):
        r = self.push(feed=_feed(500), choco_push_exit=0)
        self.assertEqual(r.code, 0, r.out)
        self.assertIn("::warning::Could not read the Chocolatey feed (HTTP 500)", r.out)
        self.assertIn("push", r.choco_log)

    def test_unreachable_feed_warns_and_pushes_anyway(self):
        r = self.push(feed=_feed(None), choco_push_exit=0)
        self.assertEqual(r.code, 0, r.out)
        self.assertIn("::warning::Could not reach the Chocolatey feed", r.out)
        self.assertIn("push", r.choco_log)

    def test_conflict_is_success(self):
        r = self.push(
            feed=_feed(404),
            choco_push_exit=1,
            choco_push_output="Response status code does not indicate success: 409 (Conflict).",
        )
        self.assertEqual(r.code, 0, r.out)
        self.assertIn("::notice::The repository already holds chordsketch 0.6.0", r.out)

    def test_forbidden_with_warn_is_green(self):
        r = self.push(
            feed=_feed(404),
            choco_push_exit=1,
            choco_push_output="Response status code does not indicate success: 403 (Forbidden).",
        )
        self.assertEqual(r.code, 0, r.out)
        self.assertIn("::warning::choco push was refused with HTTP 403", r.out)
        self.assertNotIn("::error::", r.out)

    def test_forbidden_with_fail_is_red_with_the_same_diagnosis(self):
        r = self.push(
            env={"ON_FORBIDDEN": "fail"},
            feed=_feed(404),
            choco_push_exit=1,
            choco_push_output="Response status code does not indicate success: 403 (Forbidden).",
        )
        self.assertEqual(r.code, 1, r.out)
        self.assertIn("::error::choco push was refused with HTTP 403", r.out)

    def test_forbidden_names_the_retry_command_for_this_version(self):
        # The annotation is the only place the operator is told how to
        # publish once the moderation queue drains, so the tag has to be the
        # version in hand rather than a placeholder.
        r = self.push(
            feed=_feed(404),
            choco_push_exit=1,
            choco_push_output="Response status code does not indicate success: 403 (Forbidden).",
        )
        self.assertIn(
            "gh workflow run chocolatey-retry.yml -R koedame/chordsketch -f tag=v0.6.0", r.out
        )
        self.assertIn("community.chocolatey.org/packages/chordsketch/0.6.0", r.out)

    def test_forbidden_is_still_diagnosed_under_the_strict_native_preference(self):
        # The Push step pins $PSNativeCommandUseErrorActionPreference locally.
        # With the ambient preference enabled and those pins removed, the
        # failing `choco push` would throw before its output could be read and
        # every branch below it would be unreachable. This asserts the pins do
        # their job rather than trusting the comment that says they do.
        r = self.push(
            feed=_feed(404),
            choco_push_exit=1,
            choco_push_output="Response status code does not indicate success: 403 (Forbidden).",
            strict_native=True,
        )
        self.assertEqual(r.code, 0, r.out)
        self.assertIn("::warning::choco push was refused with HTTP 403", r.out)
        self.assertNotIn("NativeCommandExitException", r.out)

    def test_other_failure_propagates_the_exit_code(self):
        r = self.push(
            feed=_feed(404),
            choco_push_exit=7,
            choco_push_output="Something else went wrong.",
        )
        self.assertNotEqual(r.code, 0, r.out)
        self.assertIn("::error::choco push failed with exit code 7", r.out)


if __name__ == "__main__":
    unittest.main()
