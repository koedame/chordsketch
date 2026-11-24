#!/usr/bin/env python3
"""CI guard against a net growth of suppression comments.

A suppression (`@ts-expect-error`, `eslint-disable`, a skipped test, a Rust
`#[allow(...)]`, ...) silences a check that would otherwise say something.
One is acceptable only with a reason, but a
reason is easy to write and a pull request that adds a dozen of them reads
like any other. This guard counts them and compares the counts with
`ci/suppression-baseline.json`, so adding one is a visible edit to that file
instead of a line in a diff.

What is counted, per kind and per package (the first two directory levels of
the path, e.g. `packages/react`, `crates/ffi`):

* TypeScript / JavaScript / Svelte / Vue sources: a directive that opens a
  comment (`//`, `/*`, `{/*`, `<!--`) and names `@ts-ignore`,
  `@ts-expect-error`, `@ts-nocheck`, `eslint-disable` (also `-next-line` and
  `-line`), `biome-ignore` or `svelte-ignore`. A sentence that merely
  mentions a directive further into a comment is not counted. Test markers
  `.skip`, `.todo`, `.fixme`, `.only` and `xit` / `xdescribe` / `xtest` are
  counted on lines that are not comments.
* Rust sources: a line that begins with `#[allow(`, `#![allow(`,
  `#[expect(`, `#![expect(` or `#[ignore`, a `#[cfg_attr(..., allow|expect|ignore)]`,
  and a `// WORKAROUND` comment
  (`///` doc comments are not counted).

Files come from `git ls-files`. `GENERATED` lists the committed files that a
tool writes; they are not counted, and a path that is no longer tracked
fails the run so the list cannot rot.

The baseline is a ratchet: a count above it fails (the offending sites are
listed as `path:line`), and so does a count below it, so a removed
suppression has to lower the baseline in the same change.

Usage:

    python3 scripts/check-suppressions.py                  # check
    python3 scripts/check-suppressions.py --update         # lower the baseline
    python3 scripts/check-suppressions.py --update --allow-increase

Exits 0 when the counts equal the baseline, 1 when they differ (or when
`--update` is asked to raise a count without `--allow-increase`), 2 when the
tree cannot be read.
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from collections import defaultdict
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
BASELINE_PATH = "ci/suppression-baseline.json"

# Committed files a generator writes. They are not hand-edited, so a
# suppression there is the generator's choice, not a reviewed one.
GENERATED = ("packages/chordpro-lite/src/bare-directives.ts",)

_SCRIPT_SUFFIXES = (
    ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".svelte", ".vue",
)

_DIRECTIVE = re.compile(
    r"(?:(?<![:\w])//+|/\*+|<!--)\s*"
    r"(@ts-ignore|@ts-expect-error|@ts-nocheck|eslint-disable|biome-ignore|svelte-ignore)"
    r"(?![\w])"
)
_TEST_MARKER = re.compile(
    r"\b(?:(?:it|test|describe|suite|bench)(?:\.\w+)*\.(skip|todo|fixme|only)\b"
    r"|(xit|xdescribe|xtest)\()"
)
_RUST_ATTRIBUTE = re.compile(
    r"\s*#!?\[(allow|expect)\(|\s*#\[(ignore)\b"
    r"|\s*#!?\[cfg_attr\(.*?,\s*(allow|expect|ignore)\b"
)
_RUST_WORKAROUND = re.compile(r"(?<!/)//(?![/!])\s*WORKAROUND\b")


def _is_comment_line(line: str) -> bool:
    return line.lstrip().startswith(("//", "/*", "*", "<!--"))


def _script_sites(text: str) -> list[tuple[int, str]]:
    sites: list[tuple[int, str]] = []
    for number, line in enumerate(text.split("\n"), start=1):
        for match in _DIRECTIVE.finditer(line):
            sites.append((number, match.group(1)))
        if _is_comment_line(line):
            continue
        marker = _TEST_MARKER.search(line)
        if marker:
            sites.append((number, marker.group(1) or marker.group(2)))
    return sites


def _rust_sites(text: str) -> list[tuple[int, str]]:
    sites: list[tuple[int, str]] = []
    for number, line in enumerate(text.split("\n"), start=1):
        attribute = _RUST_ATTRIBUTE.match(line)
        if attribute:
            sites.append((number, attribute.group(1) or attribute.group(2) or attribute.group(3)))
        elif _RUST_WORKAROUND.search(line):
            sites.append((number, "WORKAROUND"))
    return sites


def find_sites(path: str, text: str) -> list[tuple[int, str]]:
    """The `(line, kind)` suppressions in one file, by its extension."""
    if path.endswith(_SCRIPT_SUFFIXES):
        return _script_sites(text)
    if path.endswith(".rs"):
        return _rust_sites(text)
    return []


def package_of(path: str) -> str:
    """The first two directory levels of `path`, or `.` for a root file."""
    directories = path.split("/")[:-1]
    return "/".join(directories[:2]) or "."


def collect(root: Path, tracked: list[str]) -> dict[str, list[str]]:
    """Map each `kind:package` key to its `path:line` sites, sorted."""
    sites: dict[str, list[str]] = defaultdict(list)
    for path in sorted(tracked):
        if path in GENERATED:
            continue
        if not path.endswith(_SCRIPT_SUFFIXES + (".rs",)):
            continue
        text = (root / path).read_text(encoding="utf-8", errors="replace")
        for number, kind in find_sites(path, text):
            sites[f"{kind}:{package_of(path)}"].append(f"{path}:{number}")
    return {key: sites[key] for key in sorted(sites)}


def counts_of(sites: dict[str, list[str]]) -> dict[str, int]:
    return {key: len(places) for key, places in sites.items()}


def render_baseline(counts: dict[str, int]) -> str:
    """The baseline file's text: one `"key": count` per line, keys sorted."""
    body = ",\n".join(f"  {json.dumps(key)}: {counts[key]}" for key in sorted(counts))
    return "{\n" + body + "\n}\n" if counts else "{}\n"


def compare(
    counts: dict[str, int], baseline: dict[str, int]
) -> tuple[list[str], list[str]]:
    """Keys whose count rose above the baseline, and keys that fell below it."""
    keys = sorted(set(counts) | set(baseline))
    raised = [k for k in keys if counts.get(k, 0) > baseline.get(k, 0)]
    lowered = [k for k in keys if counts.get(k, 0) < baseline.get(k, 0)]
    return raised, lowered


def tracked_files(root: Path) -> list[str]:
    out = subprocess.run(
        ["git", "ls-files", "-z"], cwd=root, check=True, capture_output=True, text=True
    ).stdout
    return [p for p in out.split("\0") if p]


def _report(
    sites: dict[str, list[str]],
    counts: dict[str, int],
    baseline: dict[str, int],
    keys: list[str],
    verdict: str,
) -> None:
    for key in keys:
        print(
            f"{key}: {counts.get(key, 0)} found, baseline {baseline.get(key, 0)} ({verdict})",
            file=sys.stderr,
        )
        for place in sites.get(key, []):
            print(f"  {place}", file=sys.stderr)


def main(argv: list[str] | None = None, root: Path = REPO_ROOT) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--update", action="store_true", help="rewrite the baseline")
    parser.add_argument(
        "--allow-increase",
        action="store_true",
        help="with --update, let a count rise above the baseline",
    )
    args = parser.parse_args(argv)
    if args.allow_increase and not args.update:
        parser.error("--allow-increase only makes sense with --update")

    tracked = tracked_files(root)
    missing = [p for p in GENERATED if p not in tracked]
    if missing:
        print(
            "GENERATED names a file that is not tracked: " + ", ".join(missing),
            file=sys.stderr,
        )
        return 2

    sites = collect(root, tracked)
    counts = counts_of(sites)
    baseline_file = root / BASELINE_PATH
    baseline: dict[str, int] = (
        json.loads(baseline_file.read_text(encoding="utf-8")) if baseline_file.exists() else {}
    )
    raised, lowered = compare(counts, baseline)

    if args.update:
        if raised and not args.allow_increase:
            _report(sites, counts, baseline, raised, "raised")
            print(
                f"--update only lowers {BASELINE_PATH}; a suppression was added. Remove it, "
                "or pass --allow-increase to accept it.",
                file=sys.stderr,
            )
            return 1
        baseline_file.write_text(render_baseline(counts), encoding="utf-8")
        print(f"{BASELINE_PATH} written ({len(counts)} entries).")
        return 0

    if raised:
        _report(sites, counts, baseline, raised, "above the baseline")
        print(
            "A suppression was added. Fix the finding instead of silencing it; if the "
            "suppression has to stay, run `python3 scripts/check-suppressions.py --update "
            f"--allow-increase` and commit {BASELINE_PATH} with the reason in the PR.",
            file=sys.stderr,
        )
    if lowered:
        _report(sites, counts, baseline, lowered, "below the baseline")
        print(
            "A suppression was removed. Run `python3 scripts/check-suppressions.py --update` "
            f"and commit {BASELINE_PATH}.",
            file=sys.stderr,
        )
    if raised or lowered:
        return 1
    print(f"Suppressions match {BASELINE_PATH} ({sum(counts.values())} in {len(counts)} groups).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
