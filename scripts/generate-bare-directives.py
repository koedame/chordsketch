#!/usr/bin/env python3
"""Generate `packages/chordpro-lite/src/bare-directives.ts` from the
Rust directive catalog.

`@chordsketch/chordpro-lite` sniffs whether a blob is ChordPro before
any parser runs, and that decision needs the list of directives that
are legal with no value — the names a bare `{name}` occurrence can be.
That list belongs to the catalog in
`crates/chordpro/src/directive_catalog.rs` (ADR-0028), which is the
single source of truth for directive knowledge; a hand-maintained
TypeScript copy is exactly the drift ADR-0028 was written to remove.

This script is the one-way bridge: it reads
`BARE_DIRECTIVE_NAMES` out of the catalog and writes the TypeScript
module the package imports. The Rust side is authoritative in both
directions — `--check` fails when the two disagree, so a directive
added to the catalog cannot silently leave the JavaScript surface
behind, and an edit to the generated file cannot silently diverge from
the catalog.

The catalog's own unit tests (`directive_catalog::tests`) keep
`BARE_DIRECTIVE_NAMES` honest against `DIRECTIVES` and the parser, so
this script does not re-derive that relationship; it only transports
the finished list across the language boundary.

Usage:
    # Print the TypeScript module we would generate
    python3 scripts/generate-bare-directives.py

    # Write it to packages/chordpro-lite/src/bare-directives.ts
    python3 scripts/generate-bare-directives.py --apply

    # Verify the committed file matches the catalog; exit non-zero on
    # drift. The `directive-catalog-sync` CI guard runs this on every PR.
    python3 scripts/generate-bare-directives.py --check
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
CATALOG = REPO_ROOT / "crates" / "chordpro" / "src" / "directive_catalog.rs"
GENERATED = REPO_ROOT / "packages" / "chordpro-lite" / "src" / "bare-directives.ts"

CONST_NAME = "BARE_DIRECTIVE_NAMES"

# The whole `pub const BARE_DIRECTIVE_NAMES: &[&str] = &[ ... ];` item,
# doc comment excluded. Non-greedy up to the first `];` so a later const
# in the same file cannot extend the match.
_CONST_RE = re.compile(
    r"pub const " + CONST_NAME + r": &\[&str\] = &\[(.*?)\];",
    re.DOTALL,
)
_STRING_RE = re.compile(r'"([^"]*)"')

# Every name is interpolated into a regular expression on the
# TypeScript side without escaping, so the shape is enforced here
# rather than assumed. ChordPro directive names are lowercase ASCII
# words; anything else means the catalog grew a case this bridge does
# not handle, and failing loudly beats emitting a broken pattern.
_NAME_RE = re.compile(r"^[a-z][a-z0-9_]*$")

HEADER = """\
// GENERATED FILE - DO NOT EDIT.
//
// Source of truth: `BARE_DIRECTIVE_NAMES` in
// `crates/chordpro/src/directive_catalog.rs`. Regenerate with:
//
//     python3 scripts/generate-bare-directives.py --apply
//
// The `directive-catalog-sync` job in `.github/workflows/ci.yml` fails
// when this file and the catalog disagree, so a directive added to the
// catalog cannot leave this surface behind.

/**
 * ChordPro directive names that are legal with no value at all - the
 * complete set a bare `{name}` occurrence can be (`{soc}`, `{eoc}`,
 * `{new_page}`, ...), canonical spellings and short aliases alike.
 *
 * Used by `detectFormat` to tell a real value-less directive from an
 * arbitrary braced word such as `{username}` or a JSON fragment. A
 * directive that carries a value (`{title: ...}`) is recognised by its
 * colon instead and is deliberately absent here.
 */
export const BARE_DIRECTIVES: readonly string[] = [
"""

FOOTER = "];\n"


def read_catalog_names(catalog_text: str) -> list[str]:
    """Extract `BARE_DIRECTIVE_NAMES` from the catalog source.

    Raises `ValueError` when the const is missing, empty, unsorted, or
    contains a name outside the lowercase-word shape the generated
    regular expression can carry unescaped.
    """
    match = _CONST_RE.search(catalog_text)
    if match is None:
        raise ValueError(f"{CONST_NAME} not found in {CATALOG}")
    names = _STRING_RE.findall(match.group(1))
    if not names:
        raise ValueError(f"{CONST_NAME} is empty")
    for name in names:
        if not _NAME_RE.match(name):
            raise ValueError(
                f"directive name {name!r} is not a lowercase ASCII word; "
                "the generated regular expression would need escaping"
            )
    if names != sorted(names) or len(set(names)) != len(names):
        raise ValueError(
            f"{CONST_NAME} must be sorted and free of duplicates "
            "(the Rust test bare_directive_names_are_sorted_and_unique "
            "enforces this)"
        )
    return names


def render(names: list[str]) -> str:
    """Render the TypeScript module for `names`."""
    body = "".join(f"  '{name}',\n" for name in names)
    return HEADER + body + FOOTER


def generate() -> str:
    return render(read_catalog_names(CATALOG.read_text(encoding="utf-8")))


def cmd_print() -> int:
    sys.stdout.write(generate())
    return 0


def cmd_apply() -> int:
    expected = generate()
    GENERATED.write_text(expected, encoding="utf-8")
    sys.stderr.write(f"wrote {GENERATED.relative_to(REPO_ROOT)}\n")
    return 0


def cmd_check() -> int:
    expected = generate()
    if not GENERATED.exists():
        sys.stderr.write(
            f"{GENERATED.relative_to(REPO_ROOT)} is missing.\n"
            "Generate it with: python3 scripts/generate-bare-directives.py --apply\n"
        )
        return 1
    actual = GENERATED.read_text(encoding="utf-8")
    if actual == expected:
        return 0
    sys.stderr.write(
        f"{GENERATED.relative_to(REPO_ROOT)} is out of sync with "
        f"{CONST_NAME} in {CATALOG.relative_to(REPO_ROOT)}.\n"
        "Refresh with: python3 scripts/generate-bare-directives.py --apply\n"
    )
    return 1


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group()
    group.add_argument(
        "--apply",
        action="store_true",
        help="Write the generated module to packages/chordpro-lite/src/.",
    )
    group.add_argument(
        "--check",
        action="store_true",
        help="Verify the committed module matches the catalog; exit "
        "non-zero on drift.",
    )
    args = parser.parse_args()

    try:
        if args.apply:
            return cmd_apply()
        if args.check:
            return cmd_check()
        return cmd_print()
    except ValueError as exc:
        sys.stderr.write(f"error: {exc}\n")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
