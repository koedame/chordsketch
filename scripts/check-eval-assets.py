#!/usr/bin/env python3
"""Evaluation-asset check.

Lists the changes in a pull request that rewrite what "correct" means for the
project, so that a maintainer reads them before the pull request is merged
(ADR-0093, `.claude/rules/pr-workflow.md` condition 5).

Two kinds of hit, both read from `git diff <base>...<head>` with renames
disabled (a rename is the deletion of the old path plus an addition):

1. **Registry.** An existing file (status M, D or T) matched by a glob of
   `ci/eval-assets.toml`. Adding a new file is not a change.
2. **Content.** Patterns that need no registry entry:
   - net deletion of at least 10 lines (deleted minus added) in one file under
     `.github/workflows/` or in `scripts/_*.py`;
   - a net decrease, within one workflow file, of references to a
     `scripts/check-*` script (a check step removed, however short);
   - a net decrease, within one file, of assertion and test-declaration lines
     in a Rust file (`assert!`, `assert_eq!`, `assert_ne!`, `#[test]` and
     attribute forms such as `#[tokio::test]`) or in a `*.test.*` /
     `*.spec.*` file under `packages/` (`expect(`, `it(`, `test(`);
   - an added `#[ignore]` in a Rust file, or an added `.skip(` / `xit(` /
     `xdescribe(` / `xtest(` in such a test file.

The registry is read from the working tree, which the workflow checks out from
the base branch, and the pull request's own commits are only read as git
objects: nothing from the pull request is executed or loaded. `--fetch REF`
brings those objects in (`git fetch --no-tags origin REF` touches the object
store and a remote-tracking ref, never the working tree or the index).

Usage:

    python3 scripts/check-eval-assets.py [--fetch refs/pull/N/head] --base <ref> --head <ref>

Exit codes: 0 no hit, 1 at least one hit (the table is printed), 2 error.
"""
from __future__ import annotations

import argparse
import re
import subprocess
import sys
import tomllib
from dataclasses import dataclass
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_REGISTRY = REPO_ROOT / "ci" / "eval-assets.toml"

# Statuses of `git diff --name-status` that change an existing file.
CHANGE_LABELS = {"M": "modified", "D": "deleted", "T": "type changed"}

NET_DELETION_LIMIT = 10
NET_DELETION_GLOBS = (".github/workflows/**", "scripts/_*.py")
MAX_ROWS = 100

_CHECK_INVOCATION = re.compile(r"\bscripts/check-[\w.-]+")
_RUST_TEST_LINE = re.compile(
    r"\bassert(?:_eq|_ne)?!"
    r"|#\[(?:[A-Za-z_]\w*::)*[A-Za-z_]*test(?:\([^\]]*\))?\]"
)
_JS_TEST_LINE = re.compile(r"\bexpect\(|\b(?:it|test)\(")
_RUST_SKIP_LINE = re.compile(r"#\[ignore\b")
_JS_SKIP_LINE = re.compile(r"\.skip\(|\bx(?:it|describe|test)\(")


class CheckError(Exception):
    """The check could not run (bad registry, git failure)."""


@dataclass(frozen=True)
class Finding:
    path: str
    change: str
    rule: str


def glob_to_regex(pattern: str) -> re.Pattern[str]:
    """Translate a registry glob: `*` within a segment, `**` across segments."""
    out: list[str] = []
    i = 0
    while i < len(pattern):
        if pattern.startswith("**/", i):
            out.append("(?:.*/)?")
            i += 3
        elif pattern.startswith("**", i):
            out.append(".*")
            i += 2
        elif pattern[i] == "*":
            out.append("[^/]*")
            i += 1
        elif pattern[i] == "?":
            out.append("[^/]")
            i += 1
        else:
            out.append(re.escape(pattern[i]))
            i += 1
    return re.compile("^" + "".join(out) + "$")


def glob_match(pattern: str, path: str) -> bool:
    return glob_to_regex(pattern).match(path) is not None


def load_registry(path: Path) -> list[tuple[str, str]]:
    try:
        data = tomllib.loads(path.read_text(encoding="utf-8"))
    except (OSError, tomllib.TOMLDecodeError) as exc:
        raise CheckError(f"cannot read the registry {path}: {exc}") from exc
    entries = data.get("asset")
    if not isinstance(entries, list) or not entries:
        raise CheckError(f"{path} has no [[asset]] entries")
    result: list[tuple[str, str]] = []
    for entry in entries:
        glob = entry.get("glob") if isinstance(entry, dict) else None
        reason = entry.get("reason") if isinstance(entry, dict) else None
        if not isinstance(glob, str) or not glob or not isinstance(reason, str) or not reason:
            raise CheckError(f"{path}: every [[asset]] needs a non-empty glob and reason: {entry!r}")
        result.append((glob, reason))
    return result


def _git(repo: Path, *args: str) -> str:
    cmd = ["git", "--literal-pathspecs", "-C", str(repo), *args]
    proc = subprocess.run(cmd, capture_output=True, check=False)
    if proc.returncode != 0:
        raise CheckError(f"{' '.join(cmd)} failed: {proc.stderr.decode('utf-8', 'replace').strip()}")
    return proc.stdout.decode("utf-8", "replace")


def fetch_objects(repo: Path, ref: str) -> None:
    _git(repo, "fetch", "--no-tags", "--quiet", "origin", ref)


_DIFF_FLAGS = ("--no-ext-diff", "--no-textconv", "--no-renames", "--no-color")


def changed_files(repo: Path, base: str, head: str) -> list[tuple[str, str]]:
    out = _git(repo, "diff", "-z", "--name-status", *_DIFF_FLAGS, f"{base}...{head}")
    fields = out.split("\0")
    pairs: list[tuple[str, str]] = []
    for i in range(0, len(fields) - 1, 2):
        pairs.append((fields[i][:1], fields[i + 1]))
    return pairs


def diff_lines(repo: Path, base: str, head: str, path: str) -> tuple[list[str], list[str]]:
    """Return (removed, added) lines of one file, without the diff markers."""
    text = _git(repo, "diff", "-U0", *_DIFF_FLAGS, f"{base}...{head}", "--", path)
    removed: list[str] = []
    added: list[str] = []
    in_hunk = False
    for line in text.split("\n"):
        if line.startswith("@@"):
            in_hunk = True
        elif not in_hunk:
            continue
        elif line.startswith("-"):
            removed.append(line[1:])
        elif line.startswith("+"):
            added.append(line[1:])
    return removed, added


def _count(pattern: re.Pattern[str], lines: list[str]) -> int:
    return sum(1 for line in lines if pattern.search(line))


def _is_js_test_file(path: str) -> bool:
    name = path.rsplit("/", 1)[-1]
    return path.startswith("packages/") and re.search(r"\.(?:test|spec)\.[^.]+$", name) is not None


def content_findings(path: str, removed: list[str], added: list[str]) -> list[str]:
    """Rules (as short sentences) that the diff of one file triggers."""
    rules: list[str] = []
    if any(glob_match(g, path) for g in NET_DELETION_GLOBS):
        net = len(removed) - len(added)
        if net >= NET_DELETION_LIMIT:
            rules.append(f"net deletion of {net} lines (limit {NET_DELETION_LIMIT})")
    if glob_match(".github/workflows/**", path):
        dropped = _count(_CHECK_INVOCATION, removed) - _count(_CHECK_INVOCATION, added)
        if dropped > 0:
            rules.append(f"{dropped} fewer reference(s) to a `scripts/check-*` script")
    if path.endswith(".rs"):
        drop = _count(_RUST_TEST_LINE, removed) - _count(_RUST_TEST_LINE, added)
        if drop > 0:
            rules.append(f"{drop} fewer assertion or test lines")
        ignored = _count(_RUST_SKIP_LINE, added)
        if ignored:
            rules.append(f"{ignored} added `#[ignore]`")
    elif _is_js_test_file(path):
        drop = _count(_JS_TEST_LINE, removed) - _count(_JS_TEST_LINE, added)
        if drop > 0:
            rules.append(f"{drop} fewer assertion or test lines")
        skipped = _count(_JS_SKIP_LINE, added)
        if skipped:
            rules.append(f"{skipped} added skip marker(s)")
    return rules


def check(repo: Path, base: str, head: str, registry: list[tuple[str, str]]) -> list[Finding]:
    findings: list[Finding] = []
    compiled = [(glob, reason, glob_to_regex(glob)) for glob, reason in registry]
    for status, path in changed_files(repo, base, head):
        label = CHANGE_LABELS.get(status)
        if label is not None:
            for glob, reason, rx in compiled:
                if rx.match(path):
                    findings.append(Finding(path, label, f"registry `{glob}`: {reason}"))
        if status not in "MDTA":
            continue
        if not (
            path.endswith(".rs")
            or _is_js_test_file(path)
            or any(glob_match(g, path) for g in NET_DELETION_GLOBS)
        ):
            continue
        removed, added = diff_lines(repo, base, head, path)
        for rule in content_findings(path, removed, added):
            findings.append(Finding(path, label or "added", rule))
    return findings


def _cell(text: str) -> str:
    # Paths come from the pull request: keep them inside one code span and one
    # table cell. Rules come from this script and the base branch's registry.
    return re.sub(r"[|`\x00-\x1f\x7f]", "?", text)


def render(findings: list[Finding]) -> str:
    if not findings:
        return "No evaluation assets changed.\n"
    paths = sorted({f.path for f in findings})
    lines = [
        f"**Evaluation assets changed in {len(paths)} file(s).** A maintainer merges this "
        "pull request after reading the diffs listed below; an AI assistant does not "
        "enqueue it (`.claude/rules/pr-workflow.md`, condition 5).",
        "",
        "| Path | Change | Why it is flagged |",
        "|---|---|---|",
    ]
    for f in findings[:MAX_ROWS]:
        lines.append(f"| `{_cell(f.path)}` | {f.change} | {f.rule} |")
    if len(findings) > MAX_ROWS:
        lines.append(f"| … | | {len(findings) - MAX_ROWS} more row(s) not shown |")
    return "\n".join(lines) + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument(
        "--fetch",
        metavar="REF",
        help="fetch this ref from origin first (for example refs/pull/N/head) so the head commit is present",
    )
    parser.add_argument("--base", required=True, help="base commit of the pull request")
    parser.add_argument("--head", required=True, help="head commit of the pull request")
    parser.add_argument("--registry", type=Path, default=DEFAULT_REGISTRY)
    parser.add_argument("--repo", type=Path, default=REPO_ROOT)
    args = parser.parse_args(argv)
    try:
        if args.fetch:
            fetch_objects(args.repo, args.fetch)
        registry = load_registry(args.registry)
        findings = check(args.repo, args.base, args.head, registry)
    except CheckError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    print(render(findings), end="")
    return 1 if findings else 0


if __name__ == "__main__":
    sys.exit(main())
