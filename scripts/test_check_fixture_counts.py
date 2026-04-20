#!/usr/bin/env python3
"""Tests for `check-fixture-counts.py`.

Each test assembles a synthetic repo root in a tempdir with a subset of the
fixture directories the script inspects. This keeps the tests independent of
the real repo's fixture count so they don't need updating every time a new
fixture is added.
"""
from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

SCRIPTS_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS_DIR))

_spec = importlib.util.spec_from_file_location(
    "check_fixture_counts", SCRIPTS_DIR / "check-fixture-counts.py"
)
assert _spec is not None and _spec.loader is not None
check_fixture_counts = importlib.util.module_from_spec(_spec)
sys.modules["check_fixture_counts"] = check_fixture_counts
_spec.loader.exec_module(check_fixture_counts)


def _make_fixtures(root: Path, renderer: str, count: int) -> None:
    base = root / "crates" / renderer / "tests" / "fixtures"
    base.mkdir(parents=True, exist_ok=True)
    for i in range(count):
        fixture = base / f"f{i:03d}"
        fixture.mkdir()
        (fixture / "input.cho").write_text("{title: T}\n[C]x\n", encoding="utf-8")


class CountFixturesTests(unittest.TestCase):
    def test_counts_only_dirs_with_input_cho(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "crates" / "render-text" / "tests" / "fixtures").mkdir(parents=True)
            (root / "crates" / "render-text" / "tests" / "fixtures" / "valid").mkdir()
            (root / "crates" / "render-text" / "tests" / "fixtures" / "valid" / "input.cho").write_text("x", encoding="utf-8")
            # This one has no input.cho and must not count.
            (root / "crates" / "render-text" / "tests" / "fixtures" / "scaffold-only").mkdir()

            check_fixture_counts.REPO_ROOT = root
            self.assertEqual(check_fixture_counts.count_fixtures("render-text"), 1)

    def test_missing_directory_counts_as_zero(self) -> None:
        with TemporaryDirectory() as tmp:
            check_fixture_counts.REPO_ROOT = Path(tmp)
            self.assertEqual(check_fixture_counts.count_fixtures("render-text"), 0)


class MainTests(unittest.TestCase):
    def test_passes_when_all_renderers_meet_floor(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            _make_fixtures(root, "render-text", check_fixture_counts.MINIMUMS["render-text"])
            _make_fixtures(root, "render-html", check_fixture_counts.MINIMUMS["render-html"])
            _make_fixtures(root, "render-pdf", check_fixture_counts.MINIMUMS["render-pdf"])

            check_fixture_counts.REPO_ROOT = root
            self.assertEqual(check_fixture_counts.main(), 0)

    def test_fails_when_any_renderer_below_floor(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            _make_fixtures(root, "render-text", check_fixture_counts.MINIMUMS["render-text"])
            _make_fixtures(root, "render-html", check_fixture_counts.MINIMUMS["render-html"])
            # One short of the pdf floor.
            _make_fixtures(root, "render-pdf", check_fixture_counts.MINIMUMS["render-pdf"] - 1)

            check_fixture_counts.REPO_ROOT = root
            self.assertEqual(check_fixture_counts.main(), 1)

    def test_fails_when_fixture_directory_is_missing(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            # Only render-text present; html and pdf directories absent entirely.
            _make_fixtures(root, "render-text", check_fixture_counts.MINIMUMS["render-text"])

            check_fixture_counts.REPO_ROOT = root
            self.assertEqual(check_fixture_counts.main(), 1)


class RealRepoSmokeTest(unittest.TestCase):
    """Sanity check the live repo actually meets its documented floors."""

    def test_live_repo_passes(self) -> None:
        check_fixture_counts.REPO_ROOT = Path(__file__).resolve().parent.parent
        self.assertEqual(check_fixture_counts.main(), 0)


if __name__ == "__main__":
    unittest.main()
