#!/usr/bin/env python3
"""Zero-external-dependency CI guard for the core crate(s).

`chordsketch-chordpro` and `chordsketch-ireal` are contractually
zero-external-dependency crates: all parsing, AST, and serialisation logic
is implemented from scratch, and even RAII helpers use stdlib-only `Drop`
types rather than `scopeguard` / `tempfile` (see CLAUDE.md "Dependency
Policy" + Architecture table, `.claude/rules/code-style.md`, and the
`external_tool` module's `TempDirGuard`).

The invariant is easy to violate by accident — a single `tempfile = "3"`
under `[dev-dependencies]` is enough to drag `getrandom` (and its
network-fetched transitive graph) back into every `cargo metadata`
resolution of the workspace, which is exactly what made the cold-cache
`desktop-build` wasm step fragile. This guard fails CI the moment ANY
dependency table — normal, dev, build, or target-scoped — gains an entry
for a crate listed in `ZERO_DEP_CRATES`, so the regression cannot recur
silently.

Runs on every PR via `.github/workflows/ci.yml` with no path filter: the
guarantee is a project-wide property per `.claude/rules/ci-parallelization.md`
§3. Python-only, sub-second wall clock; no rust-cache needed.

Usage:

    python3 scripts/check-zero-deps.py

Exits 0 when every listed crate declares no dependencies, 1 otherwise.
"""
from __future__ import annotations

import sys
import tomllib
from pathlib import Path

# Crate directories under `crates/` that MUST declare zero external
# dependencies of any kind. Keep in sync with CLAUDE.md "Dependency
# Policy" + Architecture table and `.claude/rules/code-style.md`.
ZERO_DEP_CRATES: list[str] = ["chordpro", "ireal"]

# The dependency-table key names cargo recognises. Any of these holding a
# non-empty mapping (at the top level or under `[target.<cfg>]`) counts as
# a declared dependency.
DEP_TABLE_KEYS = ("dependencies", "dev-dependencies", "build-dependencies")

REPO_ROOT = Path(__file__).resolve().parent.parent


def declared_dependencies(manifest: dict) -> dict[str, list[str]]:
    """Return every declared dependency, grouped by the table it came from.

    Inspects exactly the locations cargo resolves dependencies from — the
    three top-level tables (`[dependencies]`, `[dev-dependencies]`,
    `[build-dependencies]`) and their platform-scoped equivalents under
    `[target.<cfg>]` — and nowhere else. Free-form tables such as
    `[package.metadata.*]` are deliberately NOT inspected: a key literally
    named `dependencies` buried there is documentation/config, not a crate
    cargo links, so treating it as one would be a false positive.

    The returned keys are human-readable table labels; the values are the
    dependency crate names declared in that table.
    """
    found: dict[str, list[str]] = {}

    def record(label: str, table: object) -> None:
        if isinstance(table, dict) and table:
            found[label] = sorted(table.keys())

    # Top-level dependency tables.
    for key in DEP_TABLE_KEYS:
        record(key, manifest.get(key))

    # Platform/target-scoped dependency tables: `[target.<cfg>.<key>]`.
    # tomllib strips the quotes around `<cfg>`, so the label reads e.g.
    # `target.cfg(windows).dependencies`.
    target = manifest.get("target")
    if isinstance(target, dict):
        for cfg, cfg_table in target.items():
            if not isinstance(cfg_table, dict):
                continue
            for key in DEP_TABLE_KEYS:
                record(f"target.{cfg}.{key}", cfg_table.get(key))

    return found


def check_crate(crate: str) -> dict[str, list[str]]:
    """Return the offending dependency tables for a crate (empty == clean)."""
    manifest_path = REPO_ROOT / "crates" / crate / "Cargo.toml"
    with manifest_path.open("rb") as fh:
        manifest = tomllib.load(fh)
    return declared_dependencies(manifest)


def main() -> int:
    any_failure = False
    for crate in ZERO_DEP_CRATES:
        offending = check_crate(crate)
        if offending:
            any_failure = True
            print(f"[FAIL] chordsketch-{crate}: external dependencies declared")
            for table, names in sorted(offending.items()):
                print(f"          [{table}] -> {', '.join(names)}")
        else:
            print(f"[OK] chordsketch-{crate}: zero dependencies")

    if any_failure:
        print()
        print(
            "A crate that must have zero external dependencies declared one. "
            "Remove it (the stdlib usually has an equivalent — e.g. the "
            "`TempDir`/`TempDirGuard` helpers replace `tempfile`). If the "
            "policy itself is changing, update CLAUDE.md, "
            "`.claude/rules/code-style.md`, and `ZERO_DEP_CRATES` in this "
            "script in the same PR."
        )
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())
