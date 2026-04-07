#!/usr/bin/env python3
"""Extract a stable snapshot of install/usage commands from README.md.

The output is consumed by `.github/workflows/readme-sync.yml` to detect
README changes that add or remove documented install/usage paths without
a corresponding update to CI coverage.

Behavior:
  - Walks `## Installation` and `## Usage` sections only.
  - Inside those sections, captures every non-comment, non-blank line of
    every fenced ```bash``` block.
  - Each captured line is prefixed with the section name so the snapshot
    survives section reordering.
  - Output is stable line ordering (document order). Sort intentionally
    NOT applied so reviewers can see *where* a command was added.

Usage:
  python3 scripts/extract-readme-commands.py             # print to stdout
  python3 scripts/extract-readme-commands.py --check     # diff against
      .github/snapshots/readme-commands.txt and exit non-zero on drift
"""

from __future__ import annotations

import argparse
import difflib
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
README = REPO_ROOT / "README.md"
SNAPSHOT = REPO_ROOT / ".github" / "snapshots" / "readme-commands.txt"
TRACKED_SECTIONS = ("Installation", "Usage")


def extract(readme_text: str) -> list[str]:
    out: list[str] = []
    section: str | None = None
    in_block = False
    block_lang: str | None = None

    for raw in readme_text.splitlines():
        # Section transitions reset block state so an unterminated fence
        # in one section can't bleed into the next.
        heading = re.match(r"^##\s+(.+?)\s*$", raw)
        if heading:
            name = heading.group(1).strip()
            section = name if name in TRACKED_SECTIONS else None
            in_block = False
            block_lang = None
            continue

        # Match opening/closing fences. The language identifier may
        # contain hyphens (e.g., ```pwsh-script), and an opening fence
        # may carry a trailing annotation (e.g., ```bash some-tag) which
        # CommonMark allows after the info string. Both must be tracked
        # without breaking parsing. The pattern below recognises:
        #   ```
        #   ```bash
        #   ```pwsh-script
        #   ```bash some annotation
        fence = re.match(r"^```([\w-]*)(?:\s.*)?$", raw)
        if fence:
            if in_block:
                in_block = False
                block_lang = None
            else:
                in_block = True
                block_lang = fence.group(1) or None
            continue

        if section is None or not in_block or block_lang != "bash":
            continue

        stripped = raw.strip()
        if not stripped or stripped.startswith("#"):
            continue
        out.append(f"[{section}] {stripped}")

    return out


def render(lines: list[str]) -> str:
    return "\n".join(lines) + "\n"


def cmd_check() -> int:
    expected = render(extract(README.read_text(encoding="utf-8")))
    if not SNAPSHOT.exists():
        sys.stderr.write(
            f"Snapshot file missing: {SNAPSHOT.relative_to(REPO_ROOT)}\n"
            "Generate it with: python3 scripts/extract-readme-commands.py "
            f"> {SNAPSHOT.relative_to(REPO_ROOT)}\n"
        )
        return 1
    actual = SNAPSHOT.read_text(encoding="utf-8")
    if expected == actual:
        return 0
    diff = difflib.unified_diff(
        actual.splitlines(keepends=True),
        expected.splitlines(keepends=True),
        fromfile=str(SNAPSHOT.relative_to(REPO_ROOT)),
        tofile="README.md (extracted)",
    )
    sys.stderr.write(
        "README install/usage commands drifted from snapshot.\n"
        "\n"
        "If you intentionally added, removed, or changed a documented\n"
        "install/usage command, you must:\n"
        "  1. Add or update CI coverage in "
        ".github/workflows/readme-smoke.yml so the new command is\n"
        "     actually exercised by an end-user smoke test.\n"
        "  2. Refresh the snapshot:\n"
        "       python3 scripts/extract-readme-commands.py "
        "> .github/snapshots/readme-commands.txt\n"
        "\n"
        "Diff:\n"
    )
    sys.stderr.writelines(diff)
    return 1


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check",
        action="store_true",
        help="Diff README against snapshot and exit non-zero on drift.",
    )
    args = parser.parse_args()

    if args.check:
        return cmd_check()

    sys.stdout.write(render(extract(README.read_text(encoding="utf-8"))))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
