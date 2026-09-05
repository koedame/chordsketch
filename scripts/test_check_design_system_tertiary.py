#!/usr/bin/env python3
"""Tests for `check-design-system-tertiary.py`.

The unit cases feed synthetic page sources to `tertiary_sites` so they
are independent of the live pages; the smoke test asserts the real
`design-system/` tree still matches `TERTIARY_ALLOWED`.
"""
from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS_DIR))

_spec = importlib.util.spec_from_file_location(
    "check_design_system_tertiary", SCRIPTS_DIR / "check-design-system-tertiary.py"
)
assert _spec is not None and _spec.loader is not None
check_design_system_tertiary = importlib.util.module_from_spec(_spec)
sys.modules["check_design_system_tertiary"] = check_design_system_tertiary
_spec.loader.exec_module(check_design_system_tertiary)

tertiary_sites = check_design_system_tertiary.tertiary_sites


def page(style: str = "", body: str = "") -> str:
    return f"<html><head><style>\n{style}\n</style></head><body>{body}</body></html>"


class TertiarySitesTest(unittest.TestCase):
    def test_when_a_rule_paints_color_with_the_tertiary_tone_it_is_reported(self):
        self.assertEqual(
            tertiary_sites(page(".meta { color: var(--text-tertiary); }")),
            [".meta"],
        )

    def test_when_a_rule_uses_the_ink_500_source_token_it_is_reported(self):
        self.assertEqual(
            tertiary_sites(page(".meta { color: var(--ink-500); }")),
            [".meta"],
        )

    def test_when_the_tone_paints_a_non_color_property_it_is_not_reported(self):
        style = """
        .tick { background: var(--ink-500); }
        .cell { border-color: var(--text-tertiary); }
        .box { background-color: var(--ink-500); }
        """
        self.assertEqual(tertiary_sites(page(style)), [])

    def test_when_a_rule_paints_the_secondary_tone_it_is_not_reported(self):
        self.assertEqual(
            tertiary_sites(page(".meta { color: var(--text-secondary); }")), []
        )

    def test_when_a_pseudo_element_rule_paints_the_tone_it_is_reported(self):
        self.assertEqual(
            tertiary_sites(page(".input::placeholder { color: var(--text-tertiary); }")),
            [".input::placeholder"],
        )

    def test_when_a_selector_spans_lines_its_whitespace_is_collapsed(self):
        style = ".a,\n  .b   .c { color: var(--text-tertiary); }"
        self.assertEqual(tertiary_sites(page(style)), [".a, .b .c"])

    def test_when_a_comment_precedes_a_rule_it_is_not_part_of_the_selector(self):
        style = "/* why this exists */\n.meta { color: var(--text-tertiary); }"
        self.assertEqual(tertiary_sites(page(style)), [".meta"])

    def test_when_the_tone_is_set_in_a_style_attribute_the_tag_is_reported(self):
        body = '<span style="color: var(--text-tertiary);">BPM 82</span>'
        self.assertEqual(tertiary_sites(page(body=body)), ["inline <span>"])

    def test_when_a_rule_sits_inside_a_media_query_it_is_still_reported(self):
        style = "@media (min-width: 40rem) { .meta { color: var(--ink-500); } }"
        self.assertEqual(tertiary_sites(page(style)), [".meta"])

    def test_when_several_sites_exist_they_come_back_sorted(self):
        style = ".z { color: var(--ink-500); }\n.a { color: var(--text-tertiary); }"
        self.assertEqual(tertiary_sites(page(style)), [".a", ".z"])


class LivePagesTest(unittest.TestCase):
    def test_when_run_against_the_real_pages_every_site_is_allowlisted(self):
        root = check_design_system_tertiary.DESIGN_SYSTEM
        allowed = check_design_system_tertiary.TERTIARY_ALLOWED
        for path in sorted(root.rglob("*.html")):
            rel = path.relative_to(root).as_posix()
            with self.subTest(page=rel):
                self.assertEqual(
                    tertiary_sites(path.read_text(encoding="utf-8")),
                    sorted(allowed.get(rel, ())),
                )

    def test_when_the_allowlist_names_a_page_that_page_exists(self):
        root = check_design_system_tertiary.DESIGN_SYSTEM
        for rel in check_design_system_tertiary.TERTIARY_ALLOWED:
            with self.subTest(page=rel):
                self.assertTrue((root / rel).is_file())


if __name__ == "__main__":
    unittest.main()
