#!/usr/bin/env python3
"""Golden fixture count CI check.

Enforces the minimum per-renderer golden fixture counts in `MINIMUMS`
below. A fixture is any direct subdirectory of
the renderer's `tests/fixtures/` directory that contains an `input.cho`
file — matches the discovery rule used by the golden-test harnesses.

Runs on every PR via `.github/workflows/ci.yml` with no path filter: the
guarantee is a project-wide property, not a per-path concern, so a path
filter would let a change outside the filter break it unnoticed.

Usage:

    python3 scripts/check-fixture-counts.py

Exits 0 when every renderer meets its floor, 1 otherwise.
"""
from __future__ import annotations

import sys
from pathlib import Path

# The floors. This table is their only definition.
MINIMUMS: dict[str, int] = {
    "render-text": 15,
    "render-html": 15,
    "render-pdf": 10,
}

REPO_ROOT = Path(__file__).resolve().parent.parent


def count_fixtures(renderer: str) -> int:
    """Return the number of valid fixtures for a renderer.

    A fixture is a directory under `crates/<renderer>/tests/fixtures/`
    containing an `input.cho` file. Directories without `input.cho` are
    ignored (they may be work-in-progress or unrelated).
    """
    root = REPO_ROOT / "crates" / renderer / "tests" / "fixtures"
    if not root.is_dir():
        return 0
    return sum(
        1
        for entry in root.iterdir()
        if entry.is_dir() and (entry / "input.cho").is_file()
    )


def main() -> int:
    any_failure = False
    for renderer, floor in MINIMUMS.items():
        actual = count_fixtures(renderer)
        status = "OK" if actual >= floor else "FAIL"
        print(f"[{status}] {renderer}: {actual} fixtures (floor {floor})")
        if actual < floor:
            any_failure = True

    if any_failure:
        print()
        print(
            "One or more renderers dropped below the minimum fixture count. "
            "Add fixtures or, if the reduction is intentional, lower the "
            "floor in `MINIMUMS` in this script in the same PR."
        )
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())
