#!/usr/bin/env python3
"""Tests for `generate-bare-directives.py`.

The parsing and rendering cases run against synthetic catalog snippets
so they are independent of the live catalog's current contents. Two
smoke tests then assert the real repository state: the committed
TypeScript module matches the real catalog, and the real catalog
still parses.
"""
from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS_DIR))

_spec = importlib.util.spec_from_file_location(
    "generate_bare_directives", SCRIPTS_DIR / "generate-bare-directives.py"
)
assert _spec is not None and _spec.loader is not None
generate_bare_directives = importlib.util.module_from_spec(_spec)
sys.modules["generate_bare_directives"] = generate_bare_directives
_spec.loader.exec_module(generate_bare_directives)

gen = generate_bare_directives


def _catalog(entries: str) -> str:
    """Wrap `entries` in a minimal but realistic catalog source."""
    return (
        "pub const DIRECTIVES: &[DirectiveInfo] = &[];\n"
        "\n"
        "/// Doc comment mentioning BARE_DIRECTIVE_NAMES in prose.\n"
        "pub const BARE_DIRECTIVE_NAMES: &[&str] = &[\n"
        f"{entries}"
        "];\n"
        "\n"
        'pub const UNRELATED: &[&str] = &["zzz_not_a_directive"];\n'
    )


class ReadCatalogNamesTest(unittest.TestCase):
    def test_reads_names_across_multiple_lines(self) -> None:
        source = _catalog('    "chorus", "eoc",\n    "soc",\n')
        self.assertEqual(gen.read_catalog_names(source), ["chorus", "eoc", "soc"])

    def test_stops_at_the_first_closing_bracket(self) -> None:
        # A later const in the same file must not leak into the list.
        source = _catalog('    "chorus",\n')
        self.assertEqual(gen.read_catalog_names(source), ["chorus"])

    def test_missing_const_is_an_error(self) -> None:
        with self.assertRaises(ValueError):
            gen.read_catalog_names("pub const DIRECTIVES: &[DirectiveInfo] = &[];\n")

    def test_empty_const_is_an_error(self) -> None:
        with self.assertRaises(ValueError):
            gen.read_catalog_names(_catalog(""))

    def test_unsorted_names_are_an_error(self) -> None:
        with self.assertRaises(ValueError):
            gen.read_catalog_names(_catalog('    "soc", "chorus",\n'))

    def test_duplicate_names_are_an_error(self) -> None:
        with self.assertRaises(ValueError):
            gen.read_catalog_names(_catalog('    "chorus", "chorus",\n'))

    def test_name_needing_regex_escaping_is_an_error(self) -> None:
        # The names are interpolated into a regular expression on the
        # TypeScript side without escaping; a metacharacter must fail
        # here rather than produce a broken pattern.
        with self.assertRaises(ValueError):
            gen.read_catalog_names(_catalog('    "so.c",\n'))

    def test_uppercase_name_is_an_error(self) -> None:
        with self.assertRaises(ValueError):
            gen.read_catalog_names(_catalog('    "SOC",\n'))


class RenderTest(unittest.TestCase):
    def test_emits_one_quoted_entry_per_line(self) -> None:
        rendered = gen.render(["chorus", "soc"])
        self.assertIn("  'chorus',\n  'soc',\n", rendered)

    def test_marks_the_file_as_generated(self) -> None:
        rendered = gen.render(["chorus"])
        self.assertIn("GENERATED FILE - DO NOT EDIT", rendered)
        self.assertIn("scripts/generate-bare-directives.py --apply", rendered)

    def test_exports_the_expected_symbol(self) -> None:
        rendered = gen.render(["chorus"])
        self.assertIn("export const BARE_DIRECTIVES: readonly string[] = [", rendered)
        self.assertTrue(rendered.endswith("];\n"))


class RepositoryStateTest(unittest.TestCase):
    def test_the_real_catalog_parses(self) -> None:
        names = gen.read_catalog_names(gen.CATALOG.read_text(encoding="utf-8"))
        # Spot-check both halves of the list: a value-less directive and
        # an optional-label section opener.
        self.assertIn("new_page", names)
        self.assertIn("soc", names)
        self.assertNotIn("title", names)

    def test_committed_module_is_in_sync(self) -> None:
        self.assertEqual(gen.cmd_check(), 0)


if __name__ == "__main__":
    unittest.main()
