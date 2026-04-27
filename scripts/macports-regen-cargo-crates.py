#!/usr/bin/env python3
"""Regenerate the `cargo.crates` block of `packaging/macports/Portfile`
from the workspace's `Cargo.lock`.

MacPorts' canonical regenerator is `cargo2port.py`, which ships with a
local MacPorts install. This script is an in-tree pure-Python
alternative so a non-Mac contributor (CI agent, Linux dev) can refresh
the block without installing MacPorts. The output format matches
`cargo2port.py`'s contract:

    cargo.crates \\
        crate_name version checksum \\
        ...

A `[[package]]` block in `Cargo.lock` is included only when it carries
a `checksum =` line — workspace-local crates have no checksum (their
source is `path = ...` rather than `registry+...`) and the cargo
portgroup expects them to be excluded.

Usage:
    # Print to stdout
    python3 scripts/macports-regen-cargo-crates.py

    # Update the Portfile in place (rewrites everything between
    # `cargo.crates \\` and the next blank line — same boundaries
    # `cargo2port.py` writes)
    python3 scripts/macports-regen-cargo-crates.py --apply

    # Verify the Portfile matches what we would generate
    # (exits non-zero on drift). Used by CI to catch a Cargo.lock
    # bump that forgot to refresh the Portfile.
    python3 scripts/macports-regen-cargo-crates.py --check
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
CARGO_LOCK = REPO_ROOT / "Cargo.lock"
PORTFILE = REPO_ROOT / "packaging" / "macports" / "Portfile"


def parse_cargo_lock(text: str) -> list[tuple[str, str, str]]:
    blocks = re.split(r"\n\[\[package\]\]\n", text)
    crates: list[tuple[str, str, str]] = []
    for block in blocks:
        name_m = re.search(r'^name = "([^"]+)"', block, re.M)
        ver_m = re.search(r'^version = "([^"]+)"', block, re.M)
        sum_m = re.search(r'^checksum = "([^"]+)"', block, re.M)
        if name_m and ver_m and sum_m:
            crates.append((name_m.group(1), ver_m.group(1), sum_m.group(1)))
    crates.sort()
    return crates


def render_block(crates: list[tuple[str, str, str]]) -> str:
    if not crates:
        return "cargo.crates\n"
    lines = ["cargo.crates \\"]
    for i, (name, ver, checksum) in enumerate(crates):
        suffix = " \\" if i < len(crates) - 1 else ""
        lines.append(f"    {name} {ver} {checksum}{suffix}")
    return "\n".join(lines) + "\n"


def replace_block_in_portfile(portfile_text: str, new_block: str) -> str:
    """Replace the `cargo.crates ...` region in the Portfile with `new_block`.

    The region runs from the `cargo.crates \\` line to the line before
    the next blank line. This matches the layout `cargo2port.py`
    produces and what the in-tree Portfile currently uses.
    """
    lines = portfile_text.splitlines(keepends=True)
    start = None
    end = None
    for i, line in enumerate(lines):
        if start is None and line.startswith("cargo.crates"):
            start = i
            continue
        if start is not None and line.strip() == "":
            end = i
            break
    if start is None:
        raise SystemExit(
            "could not find a line starting with `cargo.crates` in Portfile"
        )
    if end is None:
        raise SystemExit(
            "found `cargo.crates` line in Portfile but no following blank line "
            "— the block must be terminated by a blank line"
        )
    return "".join(lines[:start]) + new_block + "".join(lines[end:])


def cmd_print() -> int:
    crates = parse_cargo_lock(CARGO_LOCK.read_text(encoding="utf-8"))
    sys.stdout.write(render_block(crates))
    return 0


def cmd_apply() -> int:
    crates = parse_cargo_lock(CARGO_LOCK.read_text(encoding="utf-8"))
    new_block = render_block(crates)
    portfile = PORTFILE.read_text(encoding="utf-8")
    updated = replace_block_in_portfile(portfile, new_block)
    if portfile == updated:
        print(f"{PORTFILE.relative_to(REPO_ROOT)} already up to date "
              f"({len(crates)} crates).")
        return 0
    # Write atomically: a temp sibling + Path.replace() guarantees POSIX
    # rename semantics so an interrupted write cannot corrupt the Portfile.
    tmp = PORTFILE.with_suffix(".tmp")
    try:
        tmp.write_text(updated, encoding="utf-8")
        tmp.replace(PORTFILE)
    except Exception:
        tmp.unlink(missing_ok=True)
        raise
    print(f"Rewrote {PORTFILE.relative_to(REPO_ROOT)} ({len(crates)} crates).")
    return 0


def cmd_check() -> int:
    crates = parse_cargo_lock(CARGO_LOCK.read_text(encoding="utf-8"))
    new_block = render_block(crates)
    portfile = PORTFILE.read_text(encoding="utf-8")
    expected = replace_block_in_portfile(portfile, new_block)
    if portfile == expected:
        return 0
    sys.stderr.write(
        f"{PORTFILE.relative_to(REPO_ROOT)} cargo.crates block drifted from\n"
        f"{CARGO_LOCK.relative_to(REPO_ROOT)}.\n"
        "\n"
        "Refresh with: python3 scripts/macports-regen-cargo-crates.py --apply\n"
    )
    return 1


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--apply", action="store_true",
                       help="Rewrite the Portfile in place.")
    group.add_argument("--check", action="store_true",
                       help="Verify the Portfile matches Cargo.lock; exit "
                            "non-zero on drift.")
    args = parser.parse_args()

    if args.apply:
        return cmd_apply()
    if args.check:
        return cmd_check()
    return cmd_print()


if __name__ == "__main__":
    raise SystemExit(main())
