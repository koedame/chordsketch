#!/usr/bin/env python3
"""Enforce the glibc floor of the Linux release binaries.

A `*-unknown-linux-gnu` binary can only be executed on a host whose glibc
is at least as new as the newest `GLIBC_x.y` symbol version the binary
references. Building on a GitHub-hosted `ubuntu-latest` runner therefore
bakes that runner's glibc into the support floor, and the failure is
invisible on the runner itself: the archive installs fine and only dies
on the user's older distro with

    version `GLIBC_2.39' not found (required by chordsketch)

This script closes that gap from two directions.

Workflow mode (default, runs on every PR via `ci.yml`)
    Assert that every Linux target in `.github/workflows/release.yml`'s
    build matrix carries `cross: true`. `cross` builds inside a pinned
    old-sysroot container, which is what keeps the floor low; a Linux
    target without it silently inherits the runner's glibc.

Binary mode (`--target T FILE...`, runs at release time in `release.yml`)
    Read the ELF symbol versions of the binaries that are about to be
    packaged and fail if any of them requires a newer glibc than
    MAX_GLIBC. This measures the artifact rather than the configuration,
    so it also catches a `cross` image whose sysroot moved forward. For
    musl targets it asserts the opposite: no glibc references at all.

MAX_GLIBC is a support contract, not a tuning knob. Raising it drops
every distro between the old and new value; a build that trips this
check should be fixed by restoring the old sysroot, not by editing the
constant.
"""

from __future__ import annotations

import argparse
import re
import shutil
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
RELEASE_WORKFLOW = Path(".github/workflows/release.yml")

# The newest glibc symbol version a `*-linux-gnu` release binary may
# reference. 2.18 is what the already-`cross`-built v0.5.0
# `aarch64-unknown-linux-gnu` artifacts require — `chordsketch` tops out
# at GLIBC_2.17 and `chordsketch-lsp` adds a single weak reference to
# `__cxa_thread_atexit_impl@GLIBC_2.18` from Rust's thread-local
# teardown. Every distro still in vendor support is far above it
# (RHEL 8: 2.28, Debian 11: 2.31, Ubuntu 20.04: 2.31).
MAX_GLIBC = (2, 18)

# How many offending imports to name in the failure message.
MAX_REPORTED_SYMBOLS = 6

GLIBC_VERSION_RE = re.compile(r"GLIBC_(\d+)\.(\d+)(?:\.(\d+))?")
# `readelf --dyn-syms` prints undefined imports as `name@GLIBC_x.y (N)`.
VERSIONED_SYMBOL_RE = re.compile(r"(\S+)@(GLIBC_\d+\.\d+(?:\.\d+)?)")


def parse_glibc_version(text: str) -> tuple[int, ...]:
    """Turn `GLIBC_2.3.4` into `(2, 3, 4)`."""
    match = GLIBC_VERSION_RE.fullmatch(text)
    if match is None:
        raise ValueError(f"not a glibc version: {text!r}")
    return tuple(int(part) for part in match.groups() if part is not None)


def glibc_versions(readelf_output: str) -> set[str]:
    """Every `GLIBC_x.y` token mentioned anywhere in `readelf` output."""
    return {match.group(0) for match in GLIBC_VERSION_RE.finditer(readelf_output)}


def symbols_above(readelf_output: str, ceiling: tuple[int, ...]) -> list[str]:
    """`symbol@GLIBC_x.y` pairs that require a glibc newer than `ceiling`.

    Both the weak and the global imports matter: the loader rejects a
    binary whose `.gnu.version_r` names a version the host glibc does not
    define, regardless of whether the symbols bound to that version are
    weak.
    """
    offenders = set()
    for match in VERSIONED_SYMBOL_RE.finditer(readelf_output):
        if parse_glibc_version(match.group(2)) > ceiling:
            offenders.add(f"{match.group(1)}@{match.group(2)}")
    return sorted(offenders)


def read_symbol_versions(binary: Path) -> str:
    """Dump the dynamic symbol table and version-requirement sections.

    `readelf` reads any ELF regardless of its architecture, so a single
    x86_64 runner can check the aarch64 artifacts too.
    """
    readelf = shutil.which("readelf")
    if readelf is None:
        raise SystemExit("readelf not found; install binutils")
    result = subprocess.run(
        [readelf, "--wide", "--dyn-syms", "--version-info", str(binary)],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise SystemExit(f"readelf failed on {binary}: {result.stderr.strip()}")
    return result.stdout


# --------------------------------------------------------------- binary mode


def check_binaries(target: str, binaries: list[Path]) -> list[str]:
    """Return one error string per binary that violates the contract."""
    errors = []
    for binary in binaries:
        output = read_symbol_versions(binary)
        versions = glibc_versions(output)

        if "-linux-musl" in target:
            if versions:
                errors.append(
                    f"{binary}: musl target references glibc "
                    f"({', '.join(sorted(versions))}) — the archive is "
                    f"advertised as statically linked"
                )
            continue

        if "-linux-gnu" not in target:
            continue

        if not versions:
            continue
        highest = max(versions, key=parse_glibc_version)
        if parse_glibc_version(highest) <= MAX_GLIBC:
            continue
        # Gate on the highest version *referenced* rather than on the
        # offending imports alone: the loader rejects the binary over the
        # `.gnu.version_r` entry, which can outlive the import that
        # introduced it.
        offenders = symbols_above(output, MAX_GLIBC)
        # A binary built against a modern sysroot trips dozens of these;
        # a handful is enough to identify the cause, and the full list
        # buries the version number that actually matters.
        shown = offenders[:MAX_REPORTED_SYMBOLS]
        detail = ", ".join(shown) if shown else "(no named imports)"
        if len(offenders) > len(shown):
            detail += f", +{len(offenders) - len(shown)} more"
        ceiling = ".".join(str(part) for part in MAX_GLIBC)
        errors.append(
            f"{binary}: requires {highest}, above the declared floor "
            f"GLIBC_{ceiling} — will not start on any host below it. "
            f"Offending imports: {detail}"
        )
    return errors


# ------------------------------------------------------------- workflow mode


def parse_matrix_targets(workflow_text: str) -> list[dict[str, str]]:
    """Extract the `build` matrix's `include:` entries.

    Deliberately a line scanner rather than a YAML parse: every other
    workflow checker in `scripts/` sticks to the standard library, and
    the block this reads is a flat list of scalar keys.
    """
    entries: list[dict[str, str]] = []
    entry_indent: int | None = None
    for raw in workflow_text.splitlines():
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        indent = len(raw) - len(raw.lstrip())
        item = re.match(r"-\s+target:\s*(\S+)", raw.strip())
        if item is not None:
            entry_indent = indent
            entries.append({"target": item.group(1)})
            continue
        if entry_indent is None:
            continue
        if indent <= entry_indent:
            # Dedented back out of the include: block.
            entry_indent = None
            continue
        key = re.match(r"(\w+):\s*(\S+)", raw.strip())
        if key is not None:
            entries[-1][key.group(1)] = key.group(2)
    return entries


def check_workflow(workflow_text: str) -> list[str]:
    """Return one error string per Linux target that does not use `cross`."""
    entries = parse_matrix_targets(workflow_text)
    if not entries:
        return [f"{RELEASE_WORKFLOW}: no `- target:` entries found in the build matrix"]

    errors = []
    for entry in entries:
        target = entry["target"]
        if "-linux-" not in target:
            continue
        if entry.get("cross") != "true":
            errors.append(
                f"{RELEASE_WORKFLOW}: `{target}` is missing `cross: true`. "
                f"Without it the binary is linked against the runner's glibc "
                f"and will not start on older distributions."
            )
    return errors


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--target",
        help="target triple of the binaries being checked (enables binary mode)",
    )
    parser.add_argument(
        "binaries",
        nargs="*",
        type=Path,
        help="binaries to inspect; requires --target",
    )
    args = parser.parse_args(argv)

    if bool(args.target) != bool(args.binaries):
        parser.error("--target and the binary list must be given together")

    if args.target:
        errors = check_binaries(args.target, args.binaries)
        subject = f"{args.target} binaries"
    else:
        errors = check_workflow((REPO_ROOT / RELEASE_WORKFLOW).read_text(encoding="utf-8"))
        subject = str(RELEASE_WORKFLOW)

    if errors:
        for error in errors:
            print(f"ERROR: {error}", file=sys.stderr)
        return 1

    print(f"OK: {subject} respect the declared glibc floor")
    return 0


if __name__ == "__main__":
    sys.exit(main())
