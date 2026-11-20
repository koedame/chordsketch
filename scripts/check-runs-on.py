#!/usr/bin/env python3
"""Fail when a workflow can run a job on a self-hosted runner.

This repository is public, so a pull request from a fork runs workflow code
on whatever runner `runs-on` names. A self-hosted runner would run that code
on the maintainer's machine, so no workflow may name one or read the runner
from a variable that could be set to one (ADR-0096).

Checked in every `.github/workflows/*.yml` / `*.yaml`:

- `runs-on:`, and a matrix `runner:` / `os:` key, must not read `vars.`
  (a repository variable can be set to a self-hosted label at any time);
  this covers the value after the key and, for a block-style `runs-on:`,
  every following line of the block;
- no non-comment line may contain `self-hosted`.

Usage: check-runs-on.py [WORKFLOWS_DIR]   (default `.github/workflows`)
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

KEY = re.compile(r"^(\s*)(?:-\s+)?(runs-on|runner|os)\s*:(.*)$")
VARS = re.compile(r"\bvars\s*[.\[]")
SELF_HOSTED = re.compile(r"self-hosted", re.IGNORECASE)


def find_violations(source: str) -> list[tuple[int, str, str]]:
    """Return `(line number, reason, line)` for every violation in `source`."""
    violations: list[tuple[int, str, str]] = []
    block_indent: int | None = None
    for number, line in enumerate(source.splitlines(), start=1):
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        indent = len(line) - len(line.lstrip())
        if block_indent is not None and indent <= block_indent:
            block_indent = None
        code = line.split(" #", 1)[0]
        if SELF_HOSTED.search(code):
            violations.append((number, "names a self-hosted runner", line))
            continue
        match = KEY.match(code)
        in_block = block_indent is not None
        if match is not None:
            value = match.group(3)
            if VARS.search(value):
                violations.append((number, f"`{match.group(2)}` reads `vars.`", line))
                continue
            if match.group(2) == "runs-on" and not value.strip():
                block_indent = len(match.group(1))
        elif in_block and VARS.search(code):
            violations.append((number, "`runs-on` reads `vars.`", line))
    return violations


def main(argv: list[str]) -> int:
    root = Path(argv[1] if len(argv) > 1 else ".github/workflows")
    files = sorted([*root.glob("*.yml"), *root.glob("*.yaml")])
    if not files:
        print(f"no workflow files under {root}", file=sys.stderr)
        return 1
    failed = False
    for path in files:
        for number, reason, line in find_violations(path.read_text(encoding="utf-8")):
            failed = True
            print(f"{path}:{number}: {reason}\n  {line.strip()}")
    if failed:
        print(
            "\nLinux jobs must use `runs-on: ubuntu-24.04`. The repository is public:"
            "\na fork's pull request could run arbitrary code on a self-hosted runner,"
            "\nor on whatever a repository variable is later set to (ADR-0096).",
            file=sys.stderr,
        )
        return 1
    print(f"{len(files)} workflow files: no variable-selected or self-hosted runner")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
