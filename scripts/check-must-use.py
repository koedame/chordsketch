#!/usr/bin/env python3
"""`#[must_use]` CI guard for public `Result` / `Option` functions.

`.claude/rules/defensive-inputs.md` requires every public function that
returns a `Result` or an `Option` to carry `#[must_use]`, so a caller cannot
drop a parse / conversion / lookup outcome on the floor and the compiler
says why when it happens. The invariant is easy to miss when a new parse or
convert entry point is added, so this guard fails CI for any `pub fn` under
`crates/*/src` that returns `Result` or `Option` without the attribute.

Use a message (`#[must_use = "callers must handle parse errors"]`): a bare
`#[must_use]` on a function that already returns a `#[must_use]` type trips
`clippy::double_must_use`.

Test modules (`#[cfg(test)] mod tests`) are skipped. Python-only,
sub-second wall clock.

Usage:

    python3 scripts/check-must-use.py

Exits 0 when every such function carries `#[must_use]`, 1 otherwise.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent

_PUB_FN = re.compile(r"\s*pub (?:const )?(?:async )?(?:unsafe )?fn (\w+)")
_RETURNS_FALLIBLE = re.compile(r"(?:\w+::)*(?:Result|Option)\b")


def _strip_test_module(lines: list[str]) -> list[str]:
    for i, line in enumerate(lines[:-1]):
        if line.strip() == "#[cfg(test)]" and lines[i + 1].lstrip().startswith("mod tests"):
            return lines[:i]
    return lines


def _return_type(lines: list[str], start: int) -> str | None:
    signature = ""
    for line in lines[start:]:
        signature += line + " "
        if "{" in line or line.rstrip().endswith(";"):
            break
    parts = signature.split("->", 1)
    if len(parts) < 2:
        return None
    return parts[1].split("{")[0].split(" where ")[0].strip()


def _has_must_use(lines: list[str], fn_line: int) -> bool:
    """Look at the attribute / doc block directly above `fn_line`."""
    k = fn_line - 1
    while k >= 0:
        stripped = lines[k].strip()
        if not stripped.startswith(("#[", "///", "//")):
            break
        if "must_use" in stripped:
            return True
        k -= 1
    return False


def find_missing(path: Path) -> list[tuple[int, str]]:
    lines = _strip_test_module(path.read_text(encoding="utf-8").split("\n"))
    missing: list[tuple[int, str]] = []
    for i, line in enumerate(lines):
        m = _PUB_FN.match(line)
        if not m:
            continue
        ret = _return_type(lines, i)
        if ret is None or not _RETURNS_FALLIBLE.match(ret):
            continue
        if not _has_must_use(lines, i):
            missing.append((i + 1, m.group(1)))
    return missing


def main(root: Path = REPO_ROOT) -> int:
    failures = 0
    for path in sorted((root / "crates").glob("*/src/**/*.rs")):
        for lineno, name in find_missing(path):
            rel = path.relative_to(root)
            print(
                f"{rel}:{lineno}: `pub fn {name}` returns Result/Option "
                f'but has no #[must_use = "..."]',
                file=sys.stderr,
            )
            failures += 1
    if failures:
        print(
            f"{failures} public function(s) missing #[must_use] "
            "(.claude/rules/defensive-inputs.md)",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
