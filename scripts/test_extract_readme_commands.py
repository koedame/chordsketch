#!/usr/bin/env python3
"""Self-tests for extract-readme-commands.py.

Run with: python3 scripts/test_extract_readme_commands.py

Kept stdlib-only and import-by-path so we don't need a Python test
runner or packaging setup. Wired into .github/workflows/readme-sync.yml.
"""

from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPT = REPO_ROOT / "scripts" / "extract-readme-commands.py"

# The script's filename has hyphens, which prevents `import` directly.
# Load it via importlib.util so we can call `extract()` from tests.
_spec = importlib.util.spec_from_file_location("extract_readme_commands", SCRIPT)
# Use an explicit RuntimeError instead of `assert` so the guard survives
# `python3 -O` (which strips assert statements). Without this, running
# the suite under `-O` would silently skip the check and crash later
# inside `exec_module` with an unhelpful AttributeError.
if _spec is None or _spec.loader is None:
    raise RuntimeError(f"Could not load module spec from {SCRIPT}")
_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_mod)
extract = _mod.extract


class ExtractTests(unittest.TestCase):
    def test_plain_bash_block_in_installation(self) -> None:
        readme = "\n".join(
            [
                "## Installation",
                "",
                "```bash",
                "cargo install chordsketch",
                "```",
                "",
            ]
        )
        self.assertEqual(
            extract(readme),
            ["[Installation] cargo install chordsketch"],
        )

    def test_annotated_bash_fence_is_recognised(self) -> None:
        # CommonMark allows arbitrary annotation text after the info
        # string. The previous regex required `\w*\s*$` and would skip
        # annotated fences entirely, silently dropping the contained
        # commands from the snapshot. Regression test for #1016.
        readme = "\n".join(
            [
                "## Installation",
                "",
                "```bash some-annotation here",
                "brew install chordsketch",
                "```",
                "",
            ]
        )
        self.assertEqual(
            extract(readme),
            ["[Installation] brew install chordsketch"],
        )

    def test_hyphenated_language_is_recognised(self) -> None:
        # Some renderers use compound language identifiers like
        # `pwsh-script`. Even though we only extract bash blocks, the
        # parser must still toggle in_block correctly so the closing
        # fence does not bleed into a subsequent bash block.
        readme = "\n".join(
            [
                "## Installation",
                "",
                "```pwsh-script",
                "Install-Package chordsketch",
                "```",
                "",
                "```bash",
                "cargo install chordsketch",
                "```",
                "",
            ]
        )
        self.assertEqual(
            extract(readme),
            ["[Installation] cargo install chordsketch"],
        )

    def test_only_tracked_sections_are_walked(self) -> None:
        readme = "\n".join(
            [
                "## Some Other Section",
                "",
                "```bash",
                "echo 'should be ignored'",
                "```",
                "",
                "## Usage",
                "",
                "```bash",
                "chordsketch input.cho",
                "```",
                "",
            ]
        )
        self.assertEqual(
            extract(readme),
            ["[Usage] chordsketch input.cho"],
        )

    def test_comments_and_blank_lines_are_dropped(self) -> None:
        readme = "\n".join(
            [
                "## Installation",
                "",
                "```bash",
                "# this is a comment",
                "",
                "cargo install chordsketch",
                "```",
                "",
            ]
        )
        self.assertEqual(
            extract(readme),
            ["[Installation] cargo install chordsketch"],
        )

    def test_section_heading_resets_block_state(self) -> None:
        # An unterminated fence in one section must not bleed lines from
        # the next section into the snapshot.
        readme = "\n".join(
            [
                "## Installation",
                "",
                "```bash",
                "cargo install chordsketch",
                "## Usage",  # heading inside an unterminated block
                "",
                "```bash",
                "chordsketch input.cho",
                "```",
                "",
            ]
        )
        self.assertEqual(
            extract(readme),
            [
                "[Installation] cargo install chordsketch",
                "[Usage] chordsketch input.cho",
            ],
        )


if __name__ == "__main__":
    sys.exit(0 if unittest.main(exit=False).result.wasSuccessful() else 1)
