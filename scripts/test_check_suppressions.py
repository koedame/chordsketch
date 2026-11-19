#!/usr/bin/env python3
"""Tests for `check-suppressions.py`.

The counting rules are exercised on synthetic sources, the ratchet on a
throwaway git repository, plus one test that asserts the live tree matches
`ci/suppression-baseline.json`.
"""
from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import subprocess
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

SCRIPTS_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS_DIR))

_spec = importlib.util.spec_from_file_location(
    "check_suppressions", SCRIPTS_DIR / "check-suppressions.py"
)
assert _spec is not None and _spec.loader is not None
check_suppressions = importlib.util.module_from_spec(_spec)
sys.modules["check_suppressions"] = check_suppressions
_spec.loader.exec_module(check_suppressions)

BASELINE = check_suppressions.BASELINE_PATH


def _kinds(path: str, source: str) -> list[str]:
    return [kind for _, kind in check_suppressions.find_sites(path, source)]


class Repo:
    """A throwaway git repository whose tracked files are `files`."""

    def __init__(self, files: dict[str, str]) -> None:
        self._tmp = TemporaryDirectory()
        self.root = Path(self._tmp.name)
        subprocess.run(["git", "init", "-q"], cwd=self.root, check=True)
        for name, text in files.items():
            self.write(name, text)

    def write(self, name: str, text: str) -> None:
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        subprocess.run(["git", "add", name], cwd=self.root, check=True)

    def run(self, *argv: str) -> tuple[int, str, str]:
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            try:
                code = check_suppressions.main(list(argv), root=self.root)
            except SystemExit as exit_:
                code = int(exit_.code or 0)
        return code, out.getvalue(), err.getvalue()

    def baseline(self) -> dict[str, int]:
        return json.loads((self.root / BASELINE).read_text(encoding="utf-8"))

    def close(self) -> None:
        self._tmp.cleanup()


class ScriptSourceTests(unittest.TestCase):
    def test_directive_that_opens_a_comment_is_counted(self) -> None:
        source = (
            "// @ts-expect-error because\n"
            "/* eslint-disable no-console */\n"
            "{/* eslint-disable-next-line react/no-danger */}\n"
            "<!-- svelte-ignore a11y_no_static_element_interactions -->\n"
            "// @ts-ignore\n"
            "// @ts-nocheck\n"
            "// biome-ignore lint/style: reason\n"
        )
        self.assertEqual(
            _kinds("a.svelte", source),
            [
                "@ts-expect-error",
                "eslint-disable",
                "eslint-disable",
                "svelte-ignore",
                "@ts-ignore",
                "@ts-nocheck",
                "biome-ignore",
            ],
        )

    def test_trailing_directive_after_code_is_counted(self) -> None:
        self.assertEqual(
            _kinds("a.ts", "foo(); // eslint-disable-line no-console\n"),
            ["eslint-disable"],
        )

    def test_directive_named_inside_a_sentence_is_not_counted(self) -> None:
        source = (
            "// Do not use eslint-disable-next-line here; fix the cause.\n"
            "// The @ts-ignore comment is banned.\n"
            "/** Mentions `@ts-expect-error` in prose. */\n"
        )
        self.assertEqual(_kinds("a.ts", source), [])

    def test_directive_inside_a_url_is_not_counted(self) -> None:
        source = 'const u = "https://eslint-disable.example/x";\n'
        self.assertEqual(_kinds("a.ts", source), [])

    def test_directive_word_that_continues_is_not_counted(self) -> None:
        self.assertEqual(_kinds("a.ts", "// eslint-disabled for now\n"), [])

    def test_skipped_and_focused_tests_are_counted(self) -> None:
        source = (
            "it.skip('a', () => {});\n"
            "test.describe.only('b', () => {});\n"
            "xit('c', () => {});\n"
            "it.todo('d');\n"
            "test.fixme('e', () => {});\n"
            "describe.skip('f', () => {});\n"
            "xdescribe('g', () => {});\n"
        )
        self.assertEqual(
            _kinds("a.test.ts", source),
            ["skip", "only", "xit", "todo", "fixme", "skip", "xdescribe"],
        )

    def test_test_marker_in_a_comment_or_a_longer_name_is_not_counted(self) -> None:
        source = (
            "// it.skip is not allowed\n"
            " * test.only(...) breaks CI\n"
            "contest.skip();\n"
            "const x = Array.only;\n"
        )
        self.assertEqual(_kinds("a.ts", source), [])

    def test_file_with_another_extension_is_not_read(self) -> None:
        self.assertEqual(_kinds("a.md", "// @ts-ignore\n"), [])
        self.assertEqual(_kinds("a.py", "# eslint-disable\n"), [])


class RustSourceTests(unittest.TestCase):
    def test_allow_expect_and_ignore_attributes_are_counted(self) -> None:
        source = (
            "#![allow(clippy::all)]\n"
            "    #[allow(dead_code)]\n"
            '#[expect(unused, reason = "x")]\n'
            "#[ignore]\n"
            '#[ignore = "needs a network"]\n'
        )
        self.assertEqual(
            _kinds("a.rs", source), ["allow", "allow", "expect", "ignore", "ignore"]
        )

    def test_workaround_comment_is_counted(self) -> None:
        source = "// WORKAROUND: upstream bug\nlet a = 1; // WORKAROUND: x\n"
        self.assertEqual(_kinds("a.rs", source), ["WORKAROUND", "WORKAROUND"])

    def test_doc_comments_and_commented_out_attributes_are_not_counted(self) -> None:
        source = (
            "/// WORKAROUND is how a doc comment would mention it\n"
            "//! WORKAROUND in a module doc\n"
            "// #[allow(dead_code)]\n"
            "#[ignored_name]\n"
            "#[cfg_attr(test, derive(Debug))]\n"
        )
        self.assertEqual(_kinds("a.rs", source), [])


class PackageTests(unittest.TestCase):
    def test_package_is_the_first_two_directory_levels(self) -> None:
        self.assertEqual(check_suppressions.package_of("packages/react/src/a.ts"), "packages/react")
        self.assertEqual(check_suppressions.package_of("crates/ffi/src/lib.rs"), "crates/ffi")

    def test_file_directly_under_a_directory_is_grouped_by_that_directory(self) -> None:
        self.assertEqual(check_suppressions.package_of("scripts/build.mjs"), "scripts")

    def test_file_at_the_root_is_grouped_as_a_dot(self) -> None:
        self.assertEqual(check_suppressions.package_of("playwright.config.ts"), ".")


class RatchetTests(unittest.TestCase):
    def setUp(self) -> None:
        # The real GENERATED list names files that a throwaway repo lacks.
        original = check_suppressions.GENERATED
        self.addCleanup(setattr, check_suppressions, "GENERATED", original)
        check_suppressions.GENERATED = ()
        self.repo = Repo(
            {
                "packages/a/src/x.ts": "// eslint-disable-next-line no-console\n",
                "crates/b/src/lib.rs": "#[ignore]\nfn t() {}\n",
                "ci/keep.txt": "",
            }
        )
        self.addCleanup(self.repo.close)
        code, _, _ = self.repo.run("--update", "--allow-increase")
        self.assertEqual(code, 0)

    def test_counts_equal_to_the_baseline_pass(self) -> None:
        code, out, _ = self.repo.run()
        self.assertEqual(code, 0)
        self.assertIn("match", out)

    def test_baseline_is_sorted_with_one_entry_per_line(self) -> None:
        text = (self.repo.root / BASELINE).read_text(encoding="utf-8")
        self.assertEqual(
            text,
            '{\n  "eslint-disable:packages/a": 1,\n  "ignore:crates/b": 1\n}\n',
        )

    def test_a_suppression_above_the_baseline_fails_and_lists_every_site(self) -> None:
        self.repo.write(
            "packages/a/src/x.ts",
            "// eslint-disable-next-line no-console\n"
            "// eslint-disable-next-line no-console\n",
        )
        code, _, err = self.repo.run()
        self.assertEqual(code, 1)
        self.assertIn("eslint-disable:packages/a: 2 found, baseline 1", err)
        self.assertIn("packages/a/src/x.ts:1", err)
        self.assertIn("packages/a/src/x.ts:2", err)

    def test_a_suppression_in_a_new_package_fails(self) -> None:
        self.repo.write("packages/new/src/y.ts", "// @ts-ignore\n")
        code, _, err = self.repo.run()
        self.assertEqual(code, 1)
        self.assertIn("@ts-ignore:packages/new: 1 found, baseline 0", err)

    def test_a_suppression_below_the_baseline_fails_until_the_baseline_is_lowered(self) -> None:
        self.repo.write("packages/a/src/x.ts", "export {};\n")
        code, _, err = self.repo.run()
        self.assertEqual(code, 1)
        self.assertIn("below the baseline", err)
        self.assertIn("--update", err)

    def test_update_lowers_the_baseline_and_drops_a_group_that_reached_zero(self) -> None:
        self.repo.write("packages/a/src/x.ts", "export {};\n")
        code, _, _ = self.repo.run("--update")
        self.assertEqual(code, 0)
        self.assertEqual(self.repo.baseline(), {"ignore:crates/b": 1})
        self.assertEqual(self.repo.run()[0], 0)

    def test_update_refuses_to_raise_a_count(self) -> None:
        before = (self.repo.root / BASELINE).read_text(encoding="utf-8")
        self.repo.write("packages/a/src/x.ts", "// @ts-expect-error\n")
        code, _, err = self.repo.run("--update")
        self.assertEqual(code, 1)
        self.assertIn("--allow-increase", err)
        self.assertEqual((self.repo.root / BASELINE).read_text(encoding="utf-8"), before)

    def test_update_with_allow_increase_raises_the_baseline(self) -> None:
        self.repo.write(
            "packages/a/src/x.ts",
            "// eslint-disable-next-line no-console\n// @ts-expect-error\n",
        )
        code, _, _ = self.repo.run("--update", "--allow-increase")
        self.assertEqual(code, 0)
        self.assertEqual(self.repo.baseline()["@ts-expect-error:packages/a"], 1)
        self.assertEqual(self.repo.run()[0], 0)

    def test_allow_increase_without_update_is_rejected(self) -> None:
        code, _, _ = self.repo.run("--allow-increase")
        self.assertEqual(code, 2)

    def test_output_is_the_same_on_every_run(self) -> None:
        self.repo.write("packages/a/src/x.ts", "// @ts-ignore\n// @ts-ignore\n")
        first = self.repo.run()
        second = self.repo.run()
        self.assertEqual(first, second)


class GeneratedFileTests(unittest.TestCase):
    def setUp(self) -> None:
        self.repo = Repo(
            {
                "gen/out.ts": "// eslint-disable\n",
                "src/a.ts": "export {};\n",
                "ci/keep.txt": "",
            }
        )
        self.addCleanup(self.repo.close)
        original = check_suppressions.GENERATED
        self.addCleanup(setattr, check_suppressions, "GENERATED", original)

    def test_generated_file_is_not_counted(self) -> None:
        check_suppressions.GENERATED = ("gen/out.ts",)
        self.repo.run("--update", "--allow-increase")
        self.assertEqual(self.repo.baseline(), {})

    def test_generated_path_that_is_not_tracked_fails(self) -> None:
        check_suppressions.GENERATED = ("gen/gone.ts",)
        code, _, err = self.repo.run()
        self.assertEqual(code, 2)
        self.assertIn("gen/gone.ts", err)

    def test_file_that_is_not_generated_is_counted(self) -> None:
        check_suppressions.GENERATED = ()
        self.repo.run("--update", "--allow-increase")
        self.assertEqual(self.repo.baseline(), {"eslint-disable:gen": 1})


class LiveTreeTests(unittest.TestCase):
    def test_tree_matches_the_committed_baseline(self) -> None:
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = check_suppressions.main([], root=check_suppressions.REPO_ROOT)
        self.assertEqual(code, 0, err.getvalue())


if __name__ == "__main__":
    unittest.main()
