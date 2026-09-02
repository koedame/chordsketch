#!/usr/bin/env python3
"""Tests for `check-glibc-floor.py`.

Uses only `unittest` and `unittest.mock` from stdlib so CI does not need a
`pip install` step to run. Real ELF binaries are not committed as
fixtures — the `readelf` invocation is mocked with output captured from
the v0.5.0 release archives, which is where the regression this checker
guards against actually happened:

  * `x86_64-unknown-linux-gnu` was built natively on `ubuntu-latest` and
    imports `pidfd_spawnp@GLIBC_2.39` / `pidfd_getpid@GLIBC_2.39`, so it
    fails to start on Ubuntu 22.04 (glibc 2.35).
  * `aarch64-unknown-linux-gnu` was built through `cross` and tops out at
    `__cxa_thread_atexit_impl@GLIBC_2.18`.

The workflow-mode tests run against the repository's real
`.github/workflows/release.yml`, so deleting `cross: true` from a Linux
target turns this suite red on the PR that does it.
"""

from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path
from unittest.mock import patch

SCRIPTS_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPTS_DIR.parent

_spec = importlib.util.spec_from_file_location(
    "check_glibc_floor", SCRIPTS_DIR / "check-glibc-floor.py"
)
checker = importlib.util.module_from_spec(_spec)
assert _spec.loader is not None
_spec.loader.exec_module(checker)


# Trimmed `readelf --wide --dyn-syms --version-info` output. The shapes —
# `name@GLIBC_x.y (N)` in the symbol table and `Name: GLIBC_x.y` in the
# version-needs section — are what the parser keys off.
NATIVE_X86_64 = """
Symbol table '.dynsym' contains 120 entries:
   Num:    Value          Size Type    Bind   Vis      Ndx Name
     1: 0000000000000000     0 FUNC    GLOBAL DEFAULT  UND __libc_start_main@GLIBC_2.34 (2)
    16: 0000000000000000     0 FUNC    GLOBAL DEFAULT  UND pthread_key_create@GLIBC_2.34 (2)
    88: 0000000000000000     0 FUNC    WEAK   DEFAULT  UND pidfd_spawnp@GLIBC_2.39 (17)
   108: 0000000000000000     0 FUNC    WEAK   DEFAULT  UND pidfd_getpid@GLIBC_2.39 (17)

Version needs section '.gnu.version_r' contains 1 entry:
  0x0000: Version: 1  File: libc.so.6  Cnt: 17
  0x0010:   Name: GLIBC_2.34  Flags: none  Version: 2
  0x0020:   Name: GLIBC_2.39  Flags: none  Version: 17
"""

CROSS_AARCH64 = """
Symbol table '.dynsym' contains 90 entries:
   Num:    Value          Size Type    Bind   Vis      Ndx Name
    12: 0000000000000000     0 FUNC    GLOBAL DEFAULT  UND memcpy@GLIBC_2.17 (2)
    21: 0000000000000000     0 FUNC    WEAK   DEFAULT  UND __cxa_thread_atexit_impl@GLIBC_2.18 (5)

Version needs section '.gnu.version_r' contains 1 entry:
  0x0000: Version: 1  File: libc.so.6  Cnt: 5
  0x0010:   Name: GLIBC_2.17  Flags: none  Version: 2
  0x0020:   Name: GLIBC_2.18  Flags: none  Version: 5
"""

STATIC_MUSL = """
There is no dynamic symbol information in this file.
"""


class ParseGlibcVersionTest(unittest.TestCase):
    def test_two_and_three_component_versions_parse(self):
        self.assertEqual(checker.parse_glibc_version("GLIBC_2.39"), (2, 39))
        self.assertEqual(checker.parse_glibc_version("GLIBC_2.3.4"), (2, 3, 4))

    def test_ordering_is_numeric_not_lexical(self):
        # The bug this whole checker exists for hides behind lexical
        # comparison: "GLIBC_2.39" < "GLIBC_2.4" as strings.
        self.assertGreater(
            checker.parse_glibc_version("GLIBC_2.39"),
            checker.parse_glibc_version("GLIBC_2.4"),
        )

    def test_non_version_input_raises(self):
        with self.assertRaises(ValueError):
            checker.parse_glibc_version("GLIBC")


class SymbolsAboveTest(unittest.TestCase):
    def test_every_import_above_the_ceiling_is_reported(self):
        # Weak (`pidfd_*`) and global (`__libc_start_main`) imports alike:
        # the loader rejects the binary over the version reference, not
        # over the binding.
        self.assertEqual(
            checker.symbols_above(NATIVE_X86_64, (2, 18)),
            [
                "__libc_start_main@GLIBC_2.34",
                "pidfd_getpid@GLIBC_2.39",
                "pidfd_spawnp@GLIBC_2.39",
                "pthread_key_create@GLIBC_2.34",
            ],
        )

    def test_imports_at_the_ceiling_are_not_reported(self):
        self.assertEqual(checker.symbols_above(CROSS_AARCH64, (2, 18)), [])


class CheckBinariesTest(unittest.TestCase):
    def check(self, target, readelf_output):
        with patch.object(checker, "read_symbol_versions", return_value=readelf_output):
            return checker.check_binaries(target, [Path("chordsketch")])

    def test_natively_built_gnu_binary_is_rejected(self):
        errors = self.check("x86_64-unknown-linux-gnu", NATIVE_X86_64)
        self.assertEqual(len(errors), 1)
        self.assertIn("GLIBC_2.39", errors[0])
        self.assertIn("pidfd_spawnp@GLIBC_2.39", errors[0])

    def test_cross_built_gnu_binary_is_accepted(self):
        self.assertEqual(self.check("aarch64-unknown-linux-gnu", CROSS_AARCH64), [])

    def test_musl_binary_with_no_glibc_references_is_accepted(self):
        self.assertEqual(self.check("x86_64-unknown-linux-musl", STATIC_MUSL), [])

    def test_musl_binary_that_links_glibc_is_rejected(self):
        errors = self.check("x86_64-unknown-linux-musl", CROSS_AARCH64)
        self.assertEqual(len(errors), 1)
        self.assertIn("statically linked", errors[0])

    def test_non_linux_target_is_not_inspected(self):
        self.assertEqual(self.check("x86_64-apple-darwin", NATIVE_X86_64), [])

    def test_declared_ceiling_matches_what_cross_produces(self):
        # A bump to MAX_GLIBC silently drops every distro between the old
        # and the new value, so pin the constant here too.
        self.assertEqual(checker.MAX_GLIBC, (2, 18))


class ParseMatrixTargetsTest(unittest.TestCase):
    def test_keys_attach_to_the_preceding_target(self):
        entries = checker.parse_matrix_targets(
            """
    strategy:
      matrix:
        include:
          - target: x86_64-unknown-linux-gnu
            os: ubuntu-latest
          - target: aarch64-unknown-linux-gnu
            os: ubuntu-latest
            cross: true
    steps:
      - name: Build
"""
        )
        self.assertEqual(
            entries,
            [
                {"target": "x86_64-unknown-linux-gnu", "os": "ubuntu-latest"},
                {
                    "target": "aarch64-unknown-linux-gnu",
                    "os": "ubuntu-latest",
                    "cross": "true",
                },
            ],
        )

    def test_comments_between_entries_are_ignored(self):
        entries = checker.parse_matrix_targets(
            """
        include:
          # Every Linux target builds through cross.
          - target: x86_64-unknown-linux-musl
            # keeps the sysroot old
            cross: true
"""
        )
        self.assertEqual(
            entries, [{"target": "x86_64-unknown-linux-musl", "cross": "true"}]
        )


class CheckWorkflowTest(unittest.TestCase):
    def test_repository_release_workflow_passes(self):
        text = (REPO_ROOT / checker.RELEASE_WORKFLOW).read_text(encoding="utf-8")
        self.assertEqual(checker.check_workflow(text), [])

    def test_linux_target_without_cross_is_rejected(self):
        errors = checker.check_workflow(
            """
        include:
          - target: x86_64-unknown-linux-gnu
            os: ubuntu-latest
          - target: x86_64-apple-darwin
            os: macos-latest
"""
        )
        self.assertEqual(len(errors), 1)
        self.assertIn("x86_64-unknown-linux-gnu", errors[0])

    def test_empty_matrix_is_rejected_rather_than_silently_passing(self):
        errors = checker.check_workflow("jobs:\n  build:\n    steps: []\n")
        self.assertEqual(len(errors), 1)
        self.assertIn("no `- target:` entries", errors[0])


if __name__ == "__main__":
    unittest.main()
