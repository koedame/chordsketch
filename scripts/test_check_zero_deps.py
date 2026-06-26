#!/usr/bin/env python3
"""Tests for `check-zero-deps.py`.

Each test assembles a synthetic crate manifest in a tempdir so the unit
cases are independent of the live repo, plus one smoke test that asserts
the real zero-dep crate manifests (`chordsketch-chordpro`,
`chordsketch-ireal`) stay dependency-free.
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

# A free-form `[package.metadata.*]` table that happens to contain a key
# literally named `dependencies` must NOT be flagged — it is config/docs,
# not a crate cargo links.
METADATA_FALSE_POSITIVE_MANIFEST = """\
[package]
name = "chordsketch-chordpro"
version = "0.5.0"

[dependencies]

[package.metadata.docs.rs.dependencies]
note = "this is metadata, not a real dependency table"
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

    def test_package_metadata_dependencies_table_is_not_flagged(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            _write_manifest(root, "chordpro", METADATA_FALSE_POSITIVE_MANIFEST)
            check_zero_deps.REPO_ROOT = root
            self.assertEqual(check_zero_deps.check_crate("chordpro"), {})


class MainTests(unittest.TestCase):
    def test_passes_when_all_crates_clean(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            # main() iterates every crate in ZERO_DEP_CRATES, so give each
            # a clean manifest rather than hard-coding a single crate name.
            for crate in check_zero_deps.ZERO_DEP_CRATES:
                _write_manifest(root, crate, CLEAN_MANIFEST)
            check_zero_deps.REPO_ROOT = root
            self.assertEqual(check_zero_deps.main(), 0)

    def test_fails_when_any_crate_has_a_dependency(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            for crate in check_zero_deps.ZERO_DEP_CRATES:
                _write_manifest(root, crate, CLEAN_MANIFEST)
            # Dirty exactly one of them.
            _write_manifest(
                root, check_zero_deps.ZERO_DEP_CRATES[0], DEV_DEP_MANIFEST
            )
            check_zero_deps.REPO_ROOT = root
            self.assertEqual(check_zero_deps.main(), 1)


class RealRepoSmokeTest(unittest.TestCase):
    """Sanity check the live zero-dep crates stay dependency-free."""

    def test_live_repo_passes(self) -> None:
        check_zero_deps.REPO_ROOT = Path(__file__).resolve().parent.parent
        self.assertEqual(check_zero_deps.main(), 0)


if __name__ == "__main__":
    unittest.main()
