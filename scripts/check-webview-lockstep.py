#!/usr/bin/env python3
"""Guard that the Windows preview handler shares Tauri's WebView2 stack.

`chordsketch-preview-handler` embeds WebView2 through `wry`, the same layer
`chordsketch-desktop` reaches through `tauri-runtime-wry`, and both ship in
one installer. The handler's `wry`, `windows` and `windows-core`
requirements are therefore held at the versions Tauri resolves, so the tree
carries one copy of each (ADR-0066).

Nothing in Cargo enforces that. `wry = "0.55"` means `^0.55`, so when Tauri
moves to a newer `wry` the handler keeps resolving the old one, both copies
land in `Cargo.lock`, and every other check stays green. The reverse — a
bump of the handler's requirement alone — splits the tree the same way.

This script reads `Cargo.lock` and compares, for each of those crates, the
entry the handler resolves against the entry Tauri's WebView2 runtime
resolves. It deliberately does not ask whether a crate appears in the lock
only once: other parts of the graph are free to pull their own copies
(`iana-time-zone` resolves a newer `windows-core` than the WebView2 stack
does), and those copies are not what the installer's two WebView2 consumers
link.

Runs on every PR via `.github/workflows/ci.yml` with no path filter.
Python-only, no cargo invocation, sub-second wall clock.

Usage:

    python3 scripts/check-webview-lockstep.py [--lockfile PATH]

Exits 0 when every crate resolves to the same entry on both sides, 1 on a
mismatch or when an entry the comparison needs is missing from the lock.
"""
from __future__ import annotations

import argparse
import sys
import tomllib
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent

HANDLER = "chordsketch-preview-handler"

# Each crate that must be shared, with the dependency path that reaches it
# from each side. The handler depends on all three directly; Tauri's side is
# walked from `tauri-runtime-wry`, the crate that ties Tauri to `wry`.
LOCKSTEP: dict[str, tuple[tuple[str, ...], tuple[str, ...]]] = {
    "wry": ((HANDLER, "wry"), ("tauri-runtime-wry", "wry")),
    "windows": ((HANDLER, "windows"), ("tauri-runtime-wry", "windows")),
    "windows-core": (
        (HANDLER, "windows-core"),
        ("tauri-runtime-wry", "wry", "windows-core"),
    ),
}


class LockError(Exception):
    """An entry the comparison needs is absent or ambiguous in the lock."""


def load_packages(text: str) -> dict[str, list[dict]]:
    """Index the lock's `[[package]]` entries by crate name."""
    packages: dict[str, list[dict]] = {}
    for package in tomllib.loads(text).get("package", []):
        packages.setdefault(package["name"], []).append(package)
    return packages


def resolve(packages: dict[str, list[dict]], reference: str) -> dict:
    """Return the entry a lock reference points at.

    Cargo writes a dependency as a bare `name` when the lock holds one
    version of that crate, `name version` when it holds several, and
    `name version (source)` when even the version is ambiguous.
    """
    name, _, rest = reference.partition(" ")
    version, _, source = rest.partition(" ")
    source = source.strip("()")
    candidates = [
        p
        for p in packages.get(name, [])
        if (not version or p["version"] == version)
        and (not source or p.get("source") == source)
    ]
    if len(candidates) != 1:
        found = "no entry" if not candidates else f"{len(candidates)} entries"
        raise LockError(f"`{reference}` matches {found} in Cargo.lock")
    return candidates[0]


def walk(packages: dict[str, list[dict]], path: tuple[str, ...]) -> dict:
    """Follow a dependency path from its first crate to its last."""
    current = resolve(packages, path[0])
    for name in path[1:]:
        references = [
            r for r in current.get("dependencies", []) if r.split(" ", 1)[0] == name
        ]
        if len(references) != 1:
            raise LockError(
                f"`{current['name']} {current['version']}` has "
                f"{len(references)} dependencies named `{name}` in Cargo.lock "
                f"(expected 1 on the path {' -> '.join(path)})"
            )
        current = resolve(packages, references[0])
    return current


def compare(text: str) -> list[tuple[str, str, str]]:
    """Return `(crate, handler version, Tauri version)` for every mismatch."""
    packages = load_packages(text)
    mismatches = []
    for crate, (handler_path, tauri_path) in LOCKSTEP.items():
        ours = walk(packages, handler_path)
        theirs = walk(packages, tauri_path)
        if (ours["version"], ours.get("source")) != (
            theirs["version"],
            theirs.get("source"),
        ):
            mismatches.append((crate, ours["version"], theirs["version"]))
    return mismatches


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--lockfile", type=Path, default=REPO_ROOT / "Cargo.lock")
    args = parser.parse_args(argv)

    try:
        mismatches = compare(args.lockfile.read_text(encoding="utf-8"))
    except LockError as error:
        print(f"[FAIL] {error}")
        print()
        print(
            "The dependency paths this check compares no longer exist as "
            "written. If the preview handler or Tauri's WebView2 runtime "
            "changed shape, update `LOCKSTEP` in "
            "scripts/check-webview-lockstep.py in the same PR."
        )
        return 1

    if not mismatches:
        for crate in LOCKSTEP:
            print(f"[OK] {crate}: {HANDLER} and Tauri resolve the same version")
        return 0

    for crate, ours, theirs in mismatches:
        print(f"[FAIL] {crate}: {HANDLER} resolves {ours}, Tauri resolves {theirs}")
    print()
    print(
        "The preview handler and the desktop app ship in one installer and "
        "must share one WebView2 stack (ADR-0066). Set the `wry`, `windows` "
        "and `windows-core` requirements in apps/desktop/preview-handler/"
        "Cargo.toml to the versions Tauri resolves, together, and commit "
        "the re-resolved Cargo.lock. A bump of the handler's requirement "
        "alone waits for Tauri to move first."
    )
    return 1


if __name__ == "__main__":
    sys.exit(main())
