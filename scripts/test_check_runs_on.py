#!/usr/bin/env python3
"""Tests for `check-runs-on.py`."""
from __future__ import annotations

import contextlib
import importlib.util
import io
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

SCRIPTS_DIR = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("check_runs_on", SCRIPTS_DIR / "check-runs-on.py")
assert _spec is not None and _spec.loader is not None
check_runs_on = importlib.util.module_from_spec(_spec)
sys.modules["check_runs_on"] = check_runs_on
_spec.loader.exec_module(check_runs_on)


def _reasons(source: str) -> list[str]:
    return [reason for _, reason, _ in check_runs_on.find_violations(source)]


class FindViolationsTest(unittest.TestCase):
    def test_runs_on_is_a_literal_label_then_nothing_is_reported(self) -> None:
        self.assertEqual(_reasons("jobs:\n  a:\n    runs-on: ubuntu-24.04\n"), [])

    def test_runs_on_reads_a_matrix_value_then_nothing_is_reported(self) -> None:
        src = "    runs-on: ${{ matrix.runner || matrix.os }}\n"
        self.assertEqual(_reasons(src), [])

    def test_runs_on_reads_a_repository_variable_then_it_is_reported(self) -> None:
        src = "    runs-on: ${{ vars.LINUX_RUNNER || 'ubuntu-24.04' }}\n"
        self.assertEqual(len(_reasons(src)), 1)

    def test_matrix_runner_reads_a_repository_variable_then_it_is_reported(self) -> None:
        src = "        include:\n          - os: x\n            runner: ${{ vars.R || 'a' }}\n"
        self.assertEqual(len(_reasons(src)), 1)

    def test_matrix_os_list_item_reads_a_repository_variable_then_it_is_reported(self) -> None:
        src = "      matrix:\n        os: [a, '${{ vars.R }}']\n"
        self.assertEqual(len(_reasons(src)), 1)

    def test_block_runs_on_has_a_variable_item_then_it_is_reported(self) -> None:
        src = "    runs-on:\n      - ubuntu-24.04\n      - ${{ vars.EXTRA }}\n    steps:\n      - run: echo ${{ vars.OK }}\n"
        self.assertEqual(len(_reasons(src)), 1)

    def test_runs_on_is_a_self_hosted_label_then_it_is_reported(self) -> None:
        self.assertEqual(len(_reasons("    runs-on: [self-hosted, linux]\n")), 1)

    def test_self_hosted_is_in_a_matrix_value_then_it_is_reported(self) -> None:
        self.assertEqual(len(_reasons("        os: [self-hosted]\n")), 1)

    def test_a_step_reads_a_variable_outside_runs_on_then_nothing_is_reported(self) -> None:
        src = "    runs-on: ubuntu-24.04\n    steps:\n      - run: echo ${{ vars.X }}\n"
        self.assertEqual(_reasons(src), [])

    def test_a_comment_mentions_self_hosted_then_nothing_is_reported(self) -> None:
        src = "    # no self-hosted runners; vars.X is not read\n    runs-on: ubuntu-24.04 # not self-hosted\n"
        self.assertEqual(_reasons(src), [])


class MainTest(unittest.TestCase):
    def _run(self, files: dict[str, str]) -> tuple[int, str]:
        with TemporaryDirectory() as tmp:
            for name, text in files.items():
                (Path(tmp) / name).write_text(text, encoding="utf-8")
            out, err = io.StringIO(), io.StringIO()
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                code = check_runs_on.main(["check-runs-on.py", tmp])
            return code, out.getvalue() + err.getvalue()

    def test_every_workflow_is_pinned_then_it_exits_zero(self) -> None:
        code, _ = self._run({"a.yml": "    runs-on: ubuntu-24.04\n"})
        self.assertEqual(code, 0)

    def test_one_workflow_reads_a_variable_then_it_exits_one_and_names_the_file(self) -> None:
        code, out = self._run(
            {"a.yml": "    runs-on: ubuntu-24.04\n", "b.yml": "    runs-on: ${{ vars.R }}\n"}
        )
        self.assertEqual(code, 1)
        self.assertIn("b.yml:1", out)

    def test_there_are_no_workflow_files_then_it_exits_one(self) -> None:
        code, _ = self._run({})
        self.assertEqual(code, 1)


class LiveTreeTest(unittest.TestCase):
    def test_the_repository_workflows_are_pinned_then_it_exits_zero(self) -> None:
        root = SCRIPTS_DIR.parent / ".github" / "workflows"
        out = io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
            code = check_runs_on.main(["check-runs-on.py", str(root)])
        self.assertEqual(code, 0, out.getvalue())


if __name__ == "__main__":
    unittest.main()
