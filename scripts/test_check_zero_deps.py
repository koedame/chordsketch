#!/usr/bin/env python3
"""Tests for `check-zero-deps.py`.

Each test assembles a synthetic crate manifest in a tempdir so the unit
cases are independent of the live repo, plus one smoke test that asserts
the real `chordsketch-chordpro` manifest stays dependency-free.
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
    "check_zero_deps", SCRIPTS_DIR / "check-zero-deps.py"
)
assert _spec is not None and _spec.loader is not None
check_zero_deps = importlib.util.module_from_spec(_spec)
sys.modules["check_zero_deps"] = check_zero_deps
_spec.loader.exec_module(check_zero_deps)


def _write_manifest(root: Path, crate: str, body: str) -> None:
    base = root / "crates" / crate
    base.mkdir(parents=True, exist_ok=True)
    (base / "Cargo.toml").write_text(body, encoding="utf-8")


CLEAN_MANIFEST = """\
[package]
name = "chordsketch-chordpro"
version = "0.5.0"

[dependencies]

[dev-dependencies]
"""

DEV_DEP_MANIFEST = """\
[package]
name = "chordsketch-chordpro"
version = "0.5.0"

[dependencies]

[dev-dependencies]
tempfile = "3"
"""

NORMAL_DEP_MANIFEST = """\
[package]
name = "chordsketch-chordpro"
version = "0.5.0"

[dependencies]
serde = "1"
"""

BUILD_DEP_MANIFEST = """\
[package]
name = "chordsketch-chordpro"
version = "0.5.0"

[build-dependencies]
cc = "1"
"""

TARGET_SCOPED_DEP_MANIFEST = """\
[package]
name = "chordsketch-chordpro"
version = "0.5.0"

[target.'cfg(windows)'.dependencies]
winapi = "0.3"
"""


class DeclaredDependenciesTests(unittest.TestCase):
    def test_empty_tables_report_nothing(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            _write_manifest(root, "chordpro", CLEAN_MANIFEST)
            check_zero_deps.REPO_ROOT = root
            self.assertEqual(check_zero_deps.check_crate("chordpro"), {})

    def test_dev_dependency_is_flagged(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            _write_manifest(root, "chordpro", DEV_DEP_MANIFEST)
            check_zero_deps.REPO_ROOT = root
            self.assertEqual(
                check_zero_deps.check_crate("chordpro"),
                {"dev-dependencies": ["tempfile"]},
            )

    def test_normal_dependency_is_flagged(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            _write_manifest(root, "chordpro", NORMAL_DEP_MANIFEST)
            check_zero_deps.REPO_ROOT = root
            self.assertEqual(
                check_zero_deps.check_crate("chordpro"),
                {"dependencies": ["serde"]},
            )

    def test_build_dependency_is_flagged(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            _write_manifest(root, "chordpro", BUILD_DEP_MANIFEST)
            check_zero_deps.REPO_ROOT = root
            self.assertEqual(
                check_zero_deps.check_crate("chordpro"),
                {"build-dependencies": ["cc"]},
            )

    def test_target_scoped_dependency_is_flagged(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            _write_manifest(root, "chordpro", TARGET_SCOPED_DEP_MANIFEST)
            check_zero_deps.REPO_ROOT = root
            self.assertEqual(
                check_zero_deps.check_crate("chordpro"),
                {"target.cfg(windows).dependencies": ["winapi"]},
            )


class MainTests(unittest.TestCase):
    def test_passes_when_crate_is_clean(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            _write_manifest(root, "chordpro", CLEAN_MANIFEST)
            check_zero_deps.REPO_ROOT = root
            self.assertEqual(check_zero_deps.main(), 0)

    def test_fails_when_dev_dependency_present(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            _write_manifest(root, "chordpro", DEV_DEP_MANIFEST)
            check_zero_deps.REPO_ROOT = root
            self.assertEqual(check_zero_deps.main(), 1)


class RealRepoSmokeTest(unittest.TestCase):
    """Sanity check the live chordpro crate stays dependency-free."""

    def test_live_repo_passes(self) -> None:
        check_zero_deps.REPO_ROOT = Path(__file__).resolve().parent.parent
        self.assertEqual(check_zero_deps.main(), 0)


if __name__ == "__main__":
    unittest.main()
