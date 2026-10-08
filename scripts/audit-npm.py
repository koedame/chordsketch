#!/usr/bin/env python3
"""Run `npm audit` over every `package-lock.json` and turn it into a report and an exit code.

GitHub's Dependabot alerts cover only the dependencies GitHub's dependency
graph can see, and this repository configures Dependabot version updates for
`github-actions` and `cargo` only. The npm lockfiles therefore had no
advisory detector at all (ADR-0048, "npm lockfiles" addendum). This script is
the npm counterpart of `scripts/audit-advisories.py` and makes the same
decisions:

1. **Every lockfile, found by `git ls-files`.** A new `package-lock.json` is
   scanned the day it lands; there is no list to forget to extend.
2. **Scope.** Each finding is labelled `runtime` when it is still present in
   `npm audit --omit=dev`, otherwise `dev/test-only`. The label sets triage
   priority; it does not change whether a finding blocks.
3. **Newly introduced vs inherited.** On a pull request only the advisories
   the diff *adds* count: the base ref's lockfiles are audited the same way
   and subtracted.

Only `high` and `critical` advisories need attention. Lower severities are
counted in the report but never fail a run or open the tracking issue.

Exit codes: 0 = nothing needs a human, 1 = something does, 2 = an audit could
not be produced (registry unreachable, no lockfile found). 2 is never read as
a clean result.
"""

from __future__ import annotations

import argparse
import json
import pathlib
import subprocess
import sys
import tempfile
from dataclasses import dataclass

_SEVERITY_RANK = {"info": 0, "low": 1, "moderate": 2, "high": 3, "critical": 4}
BLOCKING_RANK = _SEVERITY_RANK["high"]

RUNTIME = "runtime"
DEV_ONLY = "dev/test-only"


class AuditError(Exception):
    """`npm audit` did not produce a usable report."""


@dataclass(frozen=True)
class Finding:
    """One advisory matched against one package in one lockfile."""

    lockfile: str
    package: str
    severity: str
    title: str
    url: str

    @property
    def key(self) -> tuple[str, str, str]:
        return (self.lockfile, self.url, self.package)


def parse_findings(report: dict, lockfile: str) -> list[Finding]:
    """Advisory-level entries of an `npm audit --json` report.

    npm lists every package that is vulnerable *or depends on a vulnerable
    package*; only the `via` entries that are objects are advisories, the
    string ones are propagation edges and would double-count.
    """
    if "error" in report:
        raise AuditError(f"{lockfile}: {report['error'].get('summary') or report['error']}")
    found: dict[tuple[str, str, str], Finding] = {}
    for name, vulnerability in report.get("vulnerabilities", {}).items():
        for via in vulnerability.get("via", []):
            if not isinstance(via, dict):
                continue
            finding = Finding(
                lockfile=lockfile,
                package=via.get("name") or name,
                severity=via.get("severity", "info"),
                title=via.get("title", ""),
                url=via.get("url", ""),
            )
            found[finding.key] = finding
    return sorted(found.values(), key=lambda f: (f.lockfile, f.package, f.url))


def is_blocking(finding: Finding) -> bool:
    return _SEVERITY_RANK.get(finding.severity, 0) >= BLOCKING_RANK


def npm_audit(directory: pathlib.Path, *, omit_dev: bool) -> dict:
    cmd = ["npm", "audit", "--package-lock-only", "--json"]
    if omit_dev:
        cmd.append("--omit=dev")
    # npm audit exits 1 when it finds anything; the verdict is computed from
    # the JSON, so only a missing or unparsable report is an error.
    done = subprocess.run(cmd, cwd=directory, capture_output=True, text=True)
    try:
        return json.loads(done.stdout)
    except json.JSONDecodeError:
        raise AuditError(
            f"{directory}: npm audit produced no JSON (exit {done.returncode}): "
            f"{done.stderr.strip() or done.stdout.strip()}"
        ) from None


def list_lockfiles() -> list[str]:
    done = subprocess.run(
        ["git", "ls-files", "--", "package-lock.json", "*/package-lock.json"],
        capture_output=True,
        text=True,
        check=True,
    )
    return sorted(done.stdout.split())


def audit_lockfile(lockfile: str) -> tuple[list[Finding], set[tuple[str, str, str]]]:
    """All findings of a working-tree lockfile, and the keys that are runtime."""
    directory = pathlib.Path(lockfile).parent
    everything = parse_findings(npm_audit(directory, omit_dev=False), lockfile)
    runtime = parse_findings(npm_audit(directory, omit_dev=True), lockfile)
    return everything, {f.key for f in runtime}


def audit_base_lockfile(lockfile: str, base_ref: str) -> list[Finding]:
    """Findings of the lockfile as it is at `base_ref`; none if it is new."""
    directory = pathlib.Path(lockfile).parent
    contents = {}
    for name in ("package-lock.json", "package.json"):
        shown = subprocess.run(
            ["git", "show", f"{base_ref}:{(directory / name).as_posix()}"],
            capture_output=True,
            text=True,
        )
        if shown.returncode != 0:
            return []
        contents[name] = shown.stdout
    with tempfile.TemporaryDirectory() as tmp:
        for name, text in contents.items():
            pathlib.Path(tmp, name).write_text(text, encoding="utf-8")
        return parse_findings(npm_audit(pathlib.Path(tmp), omit_dev=False), lockfile)


def needs_attention(
    blocking: list[Finding], inherited: set[tuple[str, str, str]], mode: str
) -> bool:
    if mode == "pr":
        return any(f.key not in inherited for f in blocking)
    return bool(blocking)


def _table(rows: list[list[str]], header: list[str]) -> list[str]:
    lines = ["| " + " | ".join(header) + " |", "|" + "---|" * len(header)]
    lines += ["| " + " | ".join(cell.replace("|", "\\|") for cell in row) + " |" for row in rows]
    return lines


def build_report(
    *,
    lockfiles: list[str],
    findings: list[Finding],
    runtime: set[tuple[str, str, str]],
    inherited: set[tuple[str, str, str]],
    mode: str,
) -> str:
    blocking = [f for f in findings if is_blocking(f)]
    lower = len(findings) - len(blocking)
    lines = ["## npm advisories", ""]
    scanned = f"{len(lockfiles)} lockfiles scanned"
    if not blocking:
        lines.append(f"No high or critical advisories ({scanned}).")
    else:
        new = [f for f in blocking if f.key not in inherited]
        summary = f"{len(blocking)} high or critical advisories ({scanned})"
        if mode == "pr":
            summary += f"; {len(new)} introduced by this pull request, {len(blocking) - len(new)} inherited"
        lines.append(summary + ".")
        lines.append("")
        rows = [
            [
                f"`{f.lockfile}`",
                f"`{f.package}`",
                f.severity,
                RUNTIME if f.key in runtime else DEV_ONLY,
                f"[{f.title}]({f.url})" if f.url else f.title,
            ]
            + ([] if mode != "pr" else ["no" if f.key in inherited else "**yes**"])
            for f in blocking
        ]
        header = ["Lockfile", "Package", "Severity", "Scope", "Advisory"]
        lines += _table(rows, header + (["New"] if mode == "pr" else []))
    if lower:
        lines += ["", f"{lower} lower-severity advisories are not listed."]
    lines += ["", "<details><summary>Lockfiles scanned</summary>", ""]
    lines += [f"- `{lockfile}`" for lockfile in lockfiles]
    lines += ["", "</details>"]
    return "\n".join(lines) + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--mode",
        choices=["pr", "report"],
        default="report",
        help="pr: only advisories this diff adds need attention; report: all of them do",
    )
    parser.add_argument("--base-ref", help="git ref of the base branch (required for --mode pr)")
    parser.add_argument("--output", help="write the report here instead of stdout")
    args = parser.parse_args(argv)
    if args.mode == "pr" and not args.base_ref:
        parser.error("--mode pr needs --base-ref")

    lockfiles = list_lockfiles()
    if not lockfiles:
        print("no package-lock.json is tracked by git; refusing to report a clean result", file=sys.stderr)
        return 2

    findings: list[Finding] = []
    runtime: set[tuple[str, str, str]] = set()
    inherited: set[tuple[str, str, str]] = set()
    try:
        for lockfile in lockfiles:
            found, runtime_keys = audit_lockfile(lockfile)
            findings += found
            runtime |= runtime_keys
            if args.mode == "pr":
                inherited |= {f.key for f in audit_base_lockfile(lockfile, args.base_ref)}
    except AuditError as error:
        print(error, file=sys.stderr)
        return 2

    report = build_report(
        lockfiles=lockfiles, findings=findings, runtime=runtime, inherited=inherited, mode=args.mode
    )
    if args.output:
        pathlib.Path(args.output).write_text(report, encoding="utf-8")
    else:
        sys.stdout.write(report)

    blocking = [f for f in findings if is_blocking(f)]
    return int(needs_attention(blocking, inherited, args.mode))


if __name__ == "__main__":
    sys.exit(main())
