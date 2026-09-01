#!/usr/bin/env python3
"""Turn `cargo audit --json` output into a triage report and an exit code.

`cargo audit` answers one question — "does the lockfile contain a crate
version named in the RustSec database?" — and answers it the same way for
every caller. This script adds the three project-specific decisions that
sit on top of that answer (ADR-0046):

1. **Scope.** A crate reachable only through `[dev-dependencies]` edges
   never ships in a release artefact, so its advisory is triaged
   differently from one in the runtime graph. `Cargo.lock` does not record
   that distinction; the runtime set is supplied by the caller from
   `cargo tree --edges normal,build`.
2. **Newly introduced vs inherited.** On a pull request only the
   advisories the diff *adds* are the author's to answer for. The caller
   supplies the base branch's `cargo audit` output and this script
   subtracts it.
3. **Ignore-list hygiene.** Every entry in `.cargo/audit.toml` must carry
   a `why:` line and a `review-by:` date, and an entry past its review
   date is itself a finding. Without that, muting an advisory is
   indistinguishable from fixing it — which is the failure mode the audit
   workflow exists to prevent.

Exit codes: 0 = nothing needs a human, 1 = something does.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import sys
import tomllib
from dataclasses import dataclass, field

# `cargo tree --format "{p}"` prints `name vX.Y.Z` plus an optional source
# or path suffix; `--no-dedupe` repeats subtrees and plain `--prefix none`
# output can still carry a trailing `(*)`. Only the leading name matters.
_TREE_LINE = re.compile(r"^([A-Za-z0-9_.+-]+)\s+v\d")

RUNTIME = "runtime"
DEV_ONLY = "dev/test-only"
UNKNOWN_SCOPE = "unknown"


@dataclass(frozen=True)
class Finding:
    """One advisory matched against one crate version in the lockfile."""

    kind: str  # "vulnerability", or a warning kind: unmaintained / unsound / yanked
    advisory_id: str
    package: str
    version: str
    title: str
    url: str
    patched: str

    @property
    def key(self) -> tuple[str, str, str]:
        # Version included so a PR that pulls in a second, still-vulnerable
        # resolved version of the same crate under the same advisory (a
        # duplicate version in `Cargo.lock`, which the Rust resolver creates
        # routinely) is not silently collapsed into an inherited finding
        # just because an older vulnerable version of that crate already
        # existed on the base branch.
        return (self.advisory_id, self.package, self.version)


@dataclass
class IgnoreEntry:
    """One `.cargo/audit.toml` ignore entry plus its documented rationale."""

    advisory_id: str
    why: str | None = None
    review_by: dt.date | None = None
    review_by_raw: str | None = None
    problems: list[str] = field(default_factory=list)


def _advisory_url(advisory: dict, advisory_id: str) -> str:
    url = advisory.get("url")
    if url:
        return url
    if advisory_id.startswith("RUSTSEC-"):
        return f"https://rustsec.org/advisories/{advisory_id}"
    return f"https://github.com/advisories/{advisory_id}"


def _patched(entry: dict) -> str:
    versions = entry.get("versions") or {}
    patched = versions.get("patched") or []
    return ", ".join(patched) if patched else "none"


def _finding(entry: dict, kind: str) -> Finding | None:
    package = entry.get("package") or {}
    advisory = entry.get("advisory") or {}
    advisory_id = advisory.get("id")
    if not advisory_id:
        # `yanked` warnings carry no advisory. They are a lockfile-hygiene
        # signal, not a security finding, and cargo audit already prints
        # them; representing them here would need a synthetic id that
        # cannot be ignored or tracked.
        return None
    return Finding(
        kind=kind,
        advisory_id=advisory_id,
        package=package.get("name", "?"),
        version=package.get("version", "?"),
        title=advisory.get("title", ""),
        url=_advisory_url(advisory, advisory_id),
        patched=_patched(entry),
    )


def parse_audit_report(report: dict) -> tuple[list[Finding], list[Finding]]:
    """Split a `cargo audit --json` document into vulnerabilities and warnings."""
    vulnerabilities = []
    for entry in (report.get("vulnerabilities") or {}).get("list") or []:
        finding = _finding(entry, "vulnerability")
        if finding is not None:
            vulnerabilities.append(finding)

    warnings = []
    for kind, entries in sorted((report.get("warnings") or {}).items()):
        for entry in entries or []:
            finding = _finding(entry, entry.get("kind") or kind)
            if finding is not None:
                warnings.append(finding)

    vulnerabilities.sort(key=lambda f: (f.package, f.advisory_id))
    warnings.sort(key=lambda f: (f.kind, f.package, f.advisory_id))
    return vulnerabilities, warnings


def parse_runtime_packages(text: str) -> set[str]:
    """Crate names reachable through non-dev edges, from `cargo tree` output."""
    names = set()
    for line in text.splitlines():
        match = _TREE_LINE.match(line.strip())
        if match:
            names.add(match.group(1))
    return names


def scope_of(finding: Finding, runtime: set[str] | None) -> str:
    if not runtime:
        return UNKNOWN_SCOPE
    return RUNTIME if finding.package in runtime else DEV_ONLY


def parse_ignore_entries(text: str, today: dt.date) -> list[IgnoreEntry]:
    """Read `.cargo/audit.toml`'s ignore list together with its comments.

    `tomllib` discards comments, and the rationale and review date live in
    comments so they stay next to the entry a human edits. The array is
    therefore scanned line by line; `tomllib` is used afterwards to confirm
    the two readings agree, so a formatting change that this scanner
    mis-parses is reported instead of silently dropping an entry.
    """
    entries: list[IgnoreEntry] = []
    why: str | None = None
    review_raw: str | None = None
    in_ignore = False

    for line in text.splitlines():
        stripped = line.strip()
        if not in_ignore:
            opening = re.match(r"^ignore\s*=\s*\[(.*)$", stripped)
            if not opening:
                continue
            in_ignore = True
            # An id may sit on the opening line (`ignore = ["RUSTSEC-…",`).
            stripped = opening.group(1).strip()

        if "]" in stripped:
            stripped = stripped.split("]", 1)[0].strip()
            in_ignore = False

        if stripped.startswith("#"):
            comment = stripped.lstrip("#").strip()
            lowered = comment.lower()
            if lowered.startswith("why:"):
                why = comment.split(":", 1)[1].strip()
            elif lowered.startswith("review-by:"):
                review_raw = comment.split(":", 1)[1].strip()
            continue

        quoted = re.search(r'"([^"]+)"', stripped)
        if not quoted:
            continue

        entry = IgnoreEntry(advisory_id=quoted.group(1), why=why, review_by_raw=review_raw)
        if not entry.why:
            entry.problems.append("no `# why:` comment explaining why it is ignored")
        if not review_raw:
            entry.problems.append("no `# review-by: YYYY-MM-DD` comment")
        else:
            try:
                entry.review_by = dt.date.fromisoformat(review_raw)
            except ValueError:
                entry.problems.append(f"`review-by: {review_raw}` is not a YYYY-MM-DD date")
            else:
                if entry.review_by < today:
                    entry.problems.append(
                        f"review date {entry.review_by.isoformat()} has passed — "
                        "re-check the advisory and either fix it or move the date"
                    )
        entries.append(entry)
        why = None
        review_raw = None

    return entries


def check_ignore_parse(text: str, entries: list[IgnoreEntry]) -> list[str]:
    """Confirm the comment-preserving scan agrees with a real TOML parse."""
    try:
        parsed = tomllib.loads(text)
    except tomllib.TOMLDecodeError as exc:
        return [f"`.cargo/audit.toml` is not valid TOML: {exc}"]
    declared = list((parsed.get("advisories") or {}).get("ignore") or [])
    scanned = [entry.advisory_id for entry in entries]
    if declared != scanned:
        return [
            "`.cargo/audit.toml`'s ignore list could not be read with its comments "
            f"(TOML says {declared}, comment scan says {scanned}). Keep one advisory "
            "id per line so the `why:` / `review-by:` comments stay attached."
        ]
    return []


def _count(n: int) -> str:
    return f"{n} advisory" if n == 1 else f"{n} advisories"


def _table(rows: list[list[str]], header: list[str]) -> list[str]:
    lines = ["| " + " | ".join(header) + " |", "|" + "---|" * len(header)]
    lines += ["| " + " | ".join(row) + " |" for row in rows]
    return lines


def build_report(
    *,
    vulnerabilities: list[Finding],
    warnings: list[Finding],
    inherited: set[tuple[str, str, str]],
    runtime: set[str] | None,
    ignores: list[IgnoreEntry],
    ignore_problems: list[str],
    mode: str,
) -> str:
    new = [f for f in vulnerabilities if f.key not in inherited]
    old = [f for f in vulnerabilities if f.key in inherited]
    lines: list[str] = []

    def vuln_table(findings: list[Finding]) -> list[str]:
        return _table(
            [
                [
                    f"[{f.advisory_id}]({f.url})",
                    f"`{f.package}` {f.version}",
                    scope_of(f, runtime),
                    f.patched,
                    f.title,
                ]
                for f in findings
            ],
            ["Advisory", "Crate", "Scope", "Patched in", "Summary"],
        )

    if mode == "pr":
        if new:
            lines.append("### Advisories introduced by this pull request")
            lines.append("")
            lines += vuln_table(new)
            lines.append("")
            lines.append(
                "Resolve by moving to a patched version, or — if the advisory cannot be "
                "fixed here — add an entry to `.cargo/audit.toml` with a `# why:` line "
                "and a `# review-by:` date."
            )
            lines.append("")
        else:
            lines.append("### No advisories introduced by this pull request")
            lines.append("")
        if old:
            lines.append(
                f"<details><summary>{_count(len(old))} already present on the base branch "
                "(not this PR's to fix)</summary>"
            )
            lines.append("")
            lines += vuln_table(old)
            lines.append("")
            lines.append("</details>")
            lines.append("")
    else:
        if vulnerabilities:
            lines.append("### Vulnerabilities")
            lines.append("")
            lines += vuln_table(vulnerabilities)
            lines.append("")
        else:
            lines.append("### No vulnerabilities in `Cargo.lock`")
            lines.append("")

    if warnings:
        lines.append(
            f"<details><summary>{_count(len(warnings))} of informational kind "
            "(unmaintained / unsound) — no patched release to move to</summary>"
        )
        lines.append("")
        lines += _table(
            [
                [
                    f"[{f.advisory_id}]({f.url})",
                    f.kind,
                    f"`{f.package}` {f.version}",
                    scope_of(f, runtime),
                    f.title,
                ]
                for f in warnings
            ],
            ["Advisory", "Kind", "Crate", "Scope", "Summary"],
        )
        lines.append("")
        lines.append("</details>")
        lines.append("")

    if ignores:
        lines.append("### Ignored advisories (`.cargo/audit.toml`)")
        lines.append("")
        lines += _table(
            [
                [
                    entry.advisory_id,
                    entry.why or "—",
                    entry.review_by_raw or "—",
                ]
                for entry in ignores
            ],
            ["Advisory", "Why", "Review by"],
        )
        lines.append("")

    problems = list(ignore_problems)
    for entry in ignores:
        problems += [f"`{entry.advisory_id}`: {problem}" for problem in entry.problems]
    if problems:
        lines.append("### Ignore-list problems")
        lines.append("")
        lines += [f"- {problem}" for problem in problems]
        lines.append("")

    if runtime is None:
        lines.append(
            "> Scope could not be computed (`cargo tree` output was not supplied), so "
            "every finding is reported as `unknown`."
        )
        lines.append("")

    return "\n".join(lines).rstrip() + "\n"


def needs_attention(
    *,
    vulnerabilities: list[Finding],
    inherited: set[tuple[str, str, str]],
    ignores: list[IgnoreEntry],
    ignore_problems: list[str],
    mode: str,
) -> bool:
    if ignore_problems or any(entry.problems for entry in ignores):
        return True
    if mode == "pr":
        return any(f.key not in inherited for f in vulnerabilities)
    return bool(vulnerabilities)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--audit-json", required=True, help="`cargo audit --json` output")
    parser.add_argument(
        "--base-audit-json",
        help="`cargo audit --json` output for the base branch's lockfile (pull requests)",
    )
    parser.add_argument(
        "--runtime-packages",
        help="`cargo tree --edges normal,build --format {p}` output; omit to skip scope labelling",
    )
    parser.add_argument("--audit-config", help="path to `.cargo/audit.toml`")
    parser.add_argument(
        "--mode",
        choices=["pr", "report"],
        default="report",
        help="pr: only advisories this diff adds need attention; report: all of them do",
    )
    parser.add_argument("--today", help="override today's date (YYYY-MM-DD) for review-by checks")
    parser.add_argument("--output", help="write the report here instead of stdout")
    args = parser.parse_args(argv)

    today = dt.date.fromisoformat(args.today) if args.today else dt.date.today()

    with open(args.audit_json, encoding="utf-8") as handle:
        vulnerabilities, warnings = parse_audit_report(json.load(handle))

    inherited: set[tuple[str, str, str]] = set()
    if args.base_audit_json:
        with open(args.base_audit_json, encoding="utf-8") as handle:
            base_vulnerabilities, _ = parse_audit_report(json.load(handle))
        inherited = {f.key for f in base_vulnerabilities}

    runtime = None
    if args.runtime_packages:
        with open(args.runtime_packages, encoding="utf-8") as handle:
            runtime = parse_runtime_packages(handle.read())

    ignores: list[IgnoreEntry] = []
    ignore_problems: list[str] = []
    if args.audit_config:
        with open(args.audit_config, encoding="utf-8") as handle:
            config_text = handle.read()
        ignores = parse_ignore_entries(config_text, today)
        ignore_problems = check_ignore_parse(config_text, ignores)

    report = build_report(
        vulnerabilities=vulnerabilities,
        warnings=warnings,
        inherited=inherited,
        runtime=runtime,
        ignores=ignores,
        ignore_problems=ignore_problems,
        mode=args.mode,
    )

    if args.output:
        with open(args.output, "w", encoding="utf-8") as handle:
            handle.write(report)
    else:
        sys.stdout.write(report)

    return int(
        needs_attention(
            vulnerabilities=vulnerabilities,
            inherited=inherited,
            ignores=ignores,
            ignore_problems=ignore_problems,
            mode=args.mode,
        )
    )


if __name__ == "__main__":
    sys.exit(main())
