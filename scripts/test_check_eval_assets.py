#!/usr/bin/env python3
"""Tests for `check-eval-assets.py`.

Each test builds a small git repository in a tempdir, commits a base state and
a head state, and runs the check on the pair, the way the workflow runs it on a
pull request. The registry is the real `ci/eval-assets.toml` unless a test says
otherwise.
"""
from __future__ import annotations

import contextlib
import importlib.util
import io
import os
import subprocess
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

SCRIPTS_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPTS_DIR.parent
sys.path.insert(0, str(SCRIPTS_DIR))

_spec = importlib.util.spec_from_file_location(
    "check_eval_assets", SCRIPTS_DIR / "check-eval-assets.py"
)
assert _spec is not None and _spec.loader is not None
check_eval_assets = importlib.util.module_from_spec(_spec)
sys.modules["check_eval_assets"] = check_eval_assets
_spec.loader.exec_module(check_eval_assets)

REGISTRY = check_eval_assets.load_registry(REPO_ROOT / "ci" / "eval-assets.toml")

_GIT_ENV = {
    **os.environ,
    "GIT_AUTHOR_NAME": "t",
    "GIT_AUTHOR_EMAIL": "t@example.com",
    "GIT_COMMITTER_NAME": "t",
    "GIT_COMMITTER_EMAIL": "t@example.com",
    "GIT_CONFIG_GLOBAL": os.devnull,
    "GIT_CONFIG_SYSTEM": os.devnull,
}


def _git(repo: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-C", str(repo), *args],
        check=True,
        capture_output=True,
        text=True,
        env=_GIT_ENV,
    ).stdout.strip()


class _Repo:
    """A repository with a base commit and a head commit made from it."""

    def __init__(self, tmp: str) -> None:
        self.root = Path(tmp)
        _git(self.root, "init", "-q", "-b", "main")

    def write(self, rel: str, text: str) -> None:
        path = self.root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")

    def commit(self, message: str) -> str:
        _git(self.root, "add", "-A")
        _git(self.root, "commit", "-q", "-m", message, "--allow-empty")
        return _git(self.root, "rev-parse", "HEAD")

    def check(self, base: str, head: str) -> list:
        return check_eval_assets.check(self.root, base, head, REGISTRY)


def _make(base_files: dict[str, str]):
    """Context manager: a repo whose base commit holds `base_files`."""

    @contextlib.contextmanager
    def ctx():
        with TemporaryDirectory() as tmp:
            repo = _Repo(tmp)
            for rel, text in base_files.items():
                repo.write(rel, text)
            base = repo.commit("base")
            yield repo, base

    return ctx()


def _paths(findings) -> list[str]:
    return sorted({f.path for f in findings})


class GlobTests(unittest.TestCase):
    def test_a_single_star_stays_inside_one_path_segment(self) -> None:
        self.assertTrue(check_eval_assets.glob_match("ci/*.toml", "ci/a.toml"))
        self.assertFalse(check_eval_assets.glob_match("ci/*.toml", "ci/sub/a.toml"))

    def test_a_double_star_spans_any_number_of_segments(self) -> None:
        pattern = "crates/*/tests/fixtures/**"
        self.assertTrue(check_eval_assets.glob_match(pattern, "crates/render-text/tests/fixtures/a/expected.txt"))
        self.assertTrue(check_eval_assets.glob_match(pattern, "crates/render-text/tests/fixtures/x.txt"))
        self.assertFalse(check_eval_assets.glob_match(pattern, "crates/render-text/src/fixtures/x.txt"))
        self.assertFalse(check_eval_assets.glob_match(pattern, "crates/a/b/tests/fixtures/x.txt"))

    def test_a_double_star_between_segments_matches_zero_or_more_directories(self) -> None:
        self.assertTrue(check_eval_assets.glob_match("a/**/b.txt", "a/b.txt"))
        self.assertTrue(check_eval_assets.glob_match("a/**/b.txt", "a/x/y/b.txt"))

    def test_regex_metacharacters_in_a_glob_match_literally(self) -> None:
        self.assertTrue(check_eval_assets.glob_match("deny.toml", "deny.toml"))
        self.assertFalse(check_eval_assets.glob_match("deny.toml", "denyXtoml"))


class RegistryTests(unittest.TestCase):
    def test_a_modified_expected_file_is_reported(self) -> None:
        path = "crates/render-text/tests/fixtures/a/expected.txt"
        with _make({path: "old\n"}) as (repo, base):
            repo.write(path, "new\n")
            head = repo.commit("head")
            findings = repo.check(base, head)
        self.assertEqual(_paths(findings), [path])
        self.assertEqual(findings[0].change, "modified")

    def test_a_new_fixture_alone_is_not_reported(self) -> None:
        with _make({"crates/render-text/tests/fixtures/a/input.cho": "x\n"}) as (repo, base):
            repo.write("crates/render-text/tests/fixtures/b/input.cho", "y\n")
            repo.write("crates/render-text/tests/fixtures/b/expected.txt", "y\n")
            head = repo.commit("head")
            self.assertEqual(repo.check(base, head), [])

    def test_a_deleted_fixture_is_reported(self) -> None:
        path = "crates/render-html/tests/fixtures/a/input.cho"
        with _make({path: "x\n"}) as (repo, base):
            (repo.root / path).unlink()
            head = repo.commit("head")
            findings = repo.check(base, head)
        self.assertEqual(_paths(findings), [path])
        self.assertEqual(findings[0].change, "deleted")

    def test_a_rename_is_reported_at_the_old_path_only(self) -> None:
        old = "crates/render-pdf/tests/fixtures/a/input.cho"
        new = "docs/moved-input.cho"
        with _make({old: "same content\n" * 5}) as (repo, base):
            (repo.root / new).parent.mkdir(parents=True)
            (repo.root / old).rename(repo.root / new)
            head = repo.commit("head")
            findings = repo.check(base, head)
        self.assertEqual(_paths(findings), [old])
        self.assertEqual(findings[0].change, "deleted")

    def test_a_type_change_is_reported(self) -> None:
        path = "tests/corpus/sample.cho"
        with _make({path: "target\n", "other.txt": "x\n"}) as (repo, base):
            (repo.root / path).unlink()
            (repo.root / path).symlink_to("../other.txt")
            head = repo.commit("head")
            findings = repo.check(base, head)
        self.assertEqual(_paths(findings), [path])
        self.assertEqual(findings[0].change, "type changed")

    def test_a_change_to_a_fixture_count_floor_is_reported(self) -> None:
        path = "scripts/check-fixture-counts.py"
        with _make({path: "MINIMUMS = {'render-text': 15}\n"}) as (repo, base):
            repo.write(path, "MINIMUMS = {'render-text': 1}\n")
            head = repo.commit("head")
            findings = repo.check(base, head)
        self.assertEqual(_paths(findings), [path])
        self.assertIn("scripts/check-*.py", findings[0].rule)

    def test_a_change_to_the_detection_itself_is_reported(self) -> None:
        paths = [
            "ci/eval-assets.toml",
            "scripts/check-eval-assets.py",
            "scripts/test_check_eval_assets.py",
            ".github/workflows/eval-assets.yml",
        ]
        with _make({p: "old\n" for p in paths}) as (repo, base):
            for p in paths:
                repo.write(p, "new\n")
            head = repo.commit("head")
            self.assertEqual(_paths(repo.check(base, head)), sorted(paths))

    def test_a_change_outside_the_registry_is_not_reported(self) -> None:
        with _make({"crates/chordpro/src/lib.rs": "fn a() {}\n", "README.md": "a\n"}) as (repo, base):
            repo.write("crates/chordpro/src/lib.rs", "fn b() {}\n")
            repo.write("README.md", "b\n")
            head = repo.commit("head")
            self.assertEqual(repo.check(base, head), [])


class ContentTests(unittest.TestCase):
    def test_a_workflow_with_ten_lines_net_deleted_is_reported(self) -> None:
        path = ".github/workflows/x.yml"
        with _make({path: "".join(f"line{i}\n" for i in range(30))}) as (repo, base):
            repo.write(path, "".join(f"line{i}\n" for i in range(20)))
            head = repo.commit("head")
            findings = repo.check(base, head)
        self.assertEqual(_paths(findings), [path])
        self.assertIn("net deletion of 10 lines", findings[0].rule)

    def test_a_workflow_with_nine_lines_net_deleted_is_not_reported(self) -> None:
        path = ".github/workflows/x.yml"
        with _make({path: "".join(f"line{i}\n" for i in range(30))}) as (repo, base):
            repo.write(path, "".join(f"line{i}\n" for i in range(21)))
            head = repo.commit("head")
            self.assertEqual(repo.check(base, head), [])

    def test_lines_replaced_in_a_workflow_do_not_count_as_a_net_deletion(self) -> None:
        path = ".github/workflows/x.yml"
        with _make({path: "".join(f"line{i}\n" for i in range(30))}) as (repo, base):
            repo.write(path, "".join(f"changed{i}\n" for i in range(30)))
            head = repo.commit("head")
            self.assertEqual(repo.check(base, head), [])

    def test_ten_lines_net_deleted_from_a_script_helper_are_reported(self) -> None:
        path = "scripts/_helper.py"
        with _make({path: "".join(f"x{i} = {i}\n" for i in range(30))}) as (repo, base):
            repo.write(path, "")
            head = repo.commit("head")
            self.assertEqual(_paths(repo.check(base, head)), [path])

    def test_ten_lines_net_deleted_from_an_ordinary_script_are_not_reported(self) -> None:
        path = "scripts/tool.py"
        with _make({path: "".join(f"x{i} = {i}\n" for i in range(30))}) as (repo, base):
            repo.write(path, "")
            head = repo.commit("head")
            self.assertEqual(repo.check(base, head), [])

    def test_a_removed_check_step_is_reported_even_when_it_is_short(self) -> None:
        path = ".github/workflows/ci.yml"
        step = "      - name: Fixture counts\n        run: python3 scripts/check-fixture-counts.py\n"
        with _make({path: "steps:\n" + step + "      - name: Other\n        run: true\n"}) as (repo, base):
            repo.write(path, "steps:\n      - name: Other\n        run: true\n")
            head = repo.commit("head")
            findings = repo.check(base, head)
        self.assertEqual(_paths(findings), [path])
        self.assertIn("1 fewer reference(s) to a `scripts/check-*` script", findings[0].rule)

    def test_a_check_step_moved_within_a_workflow_is_not_reported(self) -> None:
        path = ".github/workflows/ci.yml"
        a = "      - run: python3 scripts/check-a.py\n"
        b = "      - run: python3 scripts/check-b.py\n"
        with _make({path: "steps:\n" + a + b}) as (repo, base):
            repo.write(path, "steps:\n" + b + a)
            head = repo.commit("head")
            self.assertEqual(repo.check(base, head), [])

    def test_a_removed_rust_assertion_is_reported(self) -> None:
        path = "crates/a/src/lib.rs"
        base_text = "#[test]\nfn t() {\n    assert_eq!(f(), 1);\n    assert!(g());\n}\n"
        with _make({path: base_text}) as (repo, base):
            repo.write(path, "#[test]\nfn t() {\n    assert!(g());\n}\n")
            head = repo.commit("head")
            findings = repo.check(base, head)
        self.assertEqual(_paths(findings), [path])
        self.assertIn("1 fewer assertion or test lines", findings[0].rule)

    def test_a_removed_rust_test_attribute_is_reported(self) -> None:
        path = "crates/a/tests/t.rs"
        with _make({path: "#[tokio::test]\nasync fn t() {}\n"}) as (repo, base):
            repo.write(path, "async fn t() {}\n")
            head = repo.commit("head")
            self.assertEqual(_paths(repo.check(base, head)), [path])

    def test_a_rust_assertion_moved_within_the_file_is_not_reported(self) -> None:
        path = "crates/a/src/lib.rs"
        with _make({path: "fn t() {\n    assert!(a());\n    b();\n}\n"}) as (repo, base):
            repo.write(path, "fn t() {\n    b();\n    assert!(a());\n}\n")
            head = repo.commit("head")
            self.assertEqual(repo.check(base, head), [])

    def test_an_added_rust_assertion_is_not_reported(self) -> None:
        path = "crates/a/src/lib.rs"
        with _make({path: "fn t() {\n    assert!(a());\n}\n"}) as (repo, base):
            repo.write(path, "fn t() {\n    assert!(a());\n    assert!(b());\n}\n")
            head = repo.commit("head")
            self.assertEqual(repo.check(base, head), [])

    def test_a_removed_expect_call_in_production_rust_is_not_reported(self) -> None:
        path = "crates/a/src/lib.rs"
        with _make({path: 'fn f() { g().expect("x"); }\n'}) as (repo, base):
            repo.write(path, "fn f() { g().unwrap_or_default(); }\n")
            head = repo.commit("head")
            self.assertEqual(repo.check(base, head), [])

    def test_an_added_rust_ignore_attribute_is_reported(self) -> None:
        path = "crates/a/tests/t.rs"
        with _make({path: "#[test]\nfn t() {}\n"}) as (repo, base):
            repo.write(path, "#[test]\n#[ignore]\nfn t() {}\n")
            head = repo.commit("head")
            findings = repo.check(base, head)
        self.assertEqual(_paths(findings), [path])
        self.assertIn("added `#[ignore]`", findings[0].rule)

    def test_a_rust_iterator_skip_is_not_reported(self) -> None:
        path = "crates/a/src/lib.rs"
        with _make({path: "fn f() {}\n"}) as (repo, base):
            repo.write(path, "fn f() { it.take(22).skip(1).count(); }\n")
            head = repo.commit("head")
            self.assertEqual(repo.check(base, head), [])

    def test_a_removed_js_expectation_is_reported(self) -> None:
        path = "packages/react/tests/a.test.ts"
        with _make({path: "it('a', () => {\n  expect(f()).toBe(1);\n  expect(g()).toBe(2);\n});\n"}) as (repo, base):
            repo.write(path, "it('a', () => {\n  expect(f()).toBe(1);\n});\n")
            head = repo.commit("head")
            self.assertEqual(_paths(repo.check(base, head)), [path])

    def test_an_added_js_skip_is_reported(self) -> None:
        path = "packages/react/tests/a.spec.tsx"
        with _make({path: "it('a', () => {});\n"}) as (repo, base):
            repo.write(path, "it.skip('a', () => {});\n")
            head = repo.commit("head")
            findings = repo.check(base, head)
        self.assertEqual(_paths(findings), [path])

    def test_a_removed_expect_outside_a_test_file_is_not_reported(self) -> None:
        path = "packages/react/src/a.ts"
        with _make({path: "expect(x);\n"}) as (repo, base):
            repo.write(path, "")
            head = repo.commit("head")
            self.assertEqual(repo.check(base, head), [])

    def test_a_deleted_test_file_is_reported_for_its_removed_assertions(self) -> None:
        path = "crates/a/tests/t.rs"
        with _make({path: "#[test]\nfn t() { assert!(a()); }\n"}) as (repo, base):
            (repo.root / path).unlink()
            head = repo.commit("head")
            self.assertEqual(_paths(repo.check(base, head)), [path])


class RenderAndExitCodeTests(unittest.TestCase):
    def _run(self, repo: _Repo, base: str, head: str) -> tuple[int, str, str]:
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = check_eval_assets.main(
                ["--base", base, "--head", head, "--repo", str(repo.root)]
            )
        return code, out.getvalue(), err.getvalue()

    def test_a_hit_prints_a_table_and_exits_with_one(self) -> None:
        path = "crates/render-text/tests/fixtures/a/expected.txt"
        with _make({path: "old\n"}) as (repo, base):
            repo.write(path, "new\n")
            head = repo.commit("head")
            code, out, _ = self._run(repo, base, head)
        self.assertEqual(code, 1)
        self.assertIn("| Path | Change | Why it is flagged |", out)
        self.assertIn(f"| `{path}` | modified | registry `crates/*/tests/fixtures/**`", out)

    def test_no_hit_exits_with_zero(self) -> None:
        with _make({"README.md": "a\n"}) as (repo, base):
            repo.write("README.md", "b\n")
            head = repo.commit("head")
            code, out, _ = self._run(repo, base, head)
        self.assertEqual(code, 0)
        self.assertEqual(out, "No evaluation assets changed.\n")

    def test_fetch_brings_in_a_pull_request_head_that_the_clone_does_not_have(self) -> None:
        path = "crates/render-text/tests/fixtures/a/expected.txt"
        with _make({path: "old\n"}) as (origin, base), TemporaryDirectory() as tmp:
            origin.write(path, "new\n")
            head = origin.commit("head")
            _git(origin.root, "update-ref", "refs/pull/7/head", head)
            _git(origin.root, "reset", "-q", "--hard", base)
            clone = Path(tmp) / "clone"
            subprocess.run(
                ["git", "clone", "-q", "--no-local", str(origin.root), str(clone)], check=True, env=_GIT_ENV
            )
            with self.assertRaises(check_eval_assets.CheckError):
                check_eval_assets.check(clone, base, head, REGISTRY)
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                code = check_eval_assets.main(
                    ["--fetch", "refs/pull/7/head", "--base", base, "--head", head, "--repo", str(clone)]
                )
        self.assertEqual(code, 1)
        self.assertIn(path, out.getvalue())

    def test_fetch_of_a_missing_ref_exits_with_two(self) -> None:
        with _make({"README.md": "a\n"}) as (repo, base), TemporaryDirectory() as tmp:
            clone = Path(tmp) / "clone"
            subprocess.run(
                ["git", "clone", "-q", str(repo.root), str(clone)], check=True, env=_GIT_ENV
            )
            err = io.StringIO()
            with contextlib.redirect_stderr(err):
                code = check_eval_assets.main(
                    ["--fetch", "refs/pull/9/head", "--base", base, "--head", base, "--repo", str(clone)]
                )
        self.assertEqual(code, 2)

    def test_an_unknown_commit_exits_with_two(self) -> None:
        with _make({"README.md": "a\n"}) as (repo, base):
            code, _, err = self._run(repo, base, "0" * 40)
        self.assertEqual(code, 2)
        self.assertIn("error:", err)

    def test_a_registry_entry_without_a_reason_exits_with_two(self) -> None:
        with TemporaryDirectory() as tmp:
            bad = Path(tmp) / "r.toml"
            bad.write_text('[[asset]]\nglob = "a"\n', encoding="utf-8")
            with self.assertRaises(check_eval_assets.CheckError):
                check_eval_assets.load_registry(bad)

    def test_a_path_with_markdown_characters_stays_in_its_table_cell(self) -> None:
        finding = check_eval_assets.Finding("tests/corpus/a|b`c", "modified", "registry `x`: y")
        row = check_eval_assets.render([finding]).splitlines()[-1]
        self.assertEqual(row.count("|"), 4)
        self.assertNotIn("a|b", row)


class RealRegistryTests(unittest.TestCase):
    def test_the_registry_lists_the_detection_itself(self) -> None:
        for path in (
            "ci/eval-assets.toml",
            "scripts/check-eval-assets.py",
            "scripts/test_check_eval_assets.py",
            ".github/workflows/eval-assets.yml",
        ):
            self.assertTrue(
                any(check_eval_assets.glob_match(g, path) for g, _ in REGISTRY),
                f"{path} is not in the registry",
            )

    def test_the_registry_covers_the_expected_outputs_and_thresholds(self) -> None:
        for path in (
            "crates/render-text/tests/fixtures/x/expected.txt",
            "tests/corpus/a.cho",
            ".github/snapshots/a.txt",
            ".github/fixtures/a.cho",
            "codecov.yml",
            "deny.toml",
            "ci/release-channels.toml",
            "scripts/check-fixture-counts.py",
        ):
            self.assertTrue(
                any(check_eval_assets.glob_match(g, path) for g, _ in REGISTRY),
                f"{path} is not in the registry",
            )

    def test_every_registry_glob_matches_a_tracked_file_so_a_typo_cannot_hide(self) -> None:
        tracked = _git(REPO_ROOT, "ls-files").splitlines()
        for glob, _ in REGISTRY:
            if not any(check_eval_assets.glob_match(glob, p) for p in tracked):
                self.fail(f"registry glob {glob!r} matches no tracked file")


if __name__ == "__main__":
    unittest.main()
