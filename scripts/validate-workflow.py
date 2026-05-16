#!/usr/bin/env python3
"""Static checker for phase-based workflow definitions.

Validates that `.claude/workflows/<name>/workflow.json` and its referenced
phase files satisfy the contract documented in
`.claude/rules/workflow-discipline.md`. Run before adding or modifying
a workflow; the orchestrator does most of these checks at runtime but
catching them statically saves a round-trip.

Usage:
    python3 scripts/validate-workflow.py <name>          # check one workflow
    python3 scripts/validate-workflow.py --all           # check every workflow
    python3 scripts/validate-workflow.py --workflows-dir <path> ...

Exit codes:
    0 — all checks passed
    1 — one or more checks failed (details on stderr)
    2 — argument or file-not-found error
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable

NAME_PATTERN = re.compile(r"^[a-z0-9-]+$")
REQUIRED_TOP_LEVEL_KEYS = ("entryPhase", "phases", "terminalPhases")
RESERVED_PHASE_NAMES = frozenset({"HALT"})
# `HALT` is the orchestrator-reserved error/abort exit; every workflow must
# declare it as a terminal phase so the orchestrator can distinguish a clean
# exit from a halt.
REQUIRED_TERMINALS = frozenset({"HALT"})


@dataclass
class ValidationResult:
    """Aggregated outcome for one workflow.

    Errors fail the run; warnings are surfaced but do not change exit code.
    """

    workflow: str
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.errors


def validate_workflow(workflow_dir: Path) -> ValidationResult:
    """Run every check against a single workflow directory.

    Returns a populated ValidationResult; never raises on validation
    failure (filesystem-level errors still propagate).
    """
    name = workflow_dir.name
    result = ValidationResult(workflow=name)

    if not NAME_PATTERN.match(name):
        result.errors.append(
            f"workflow directory name {name!r} does not match {NAME_PATTERN.pattern}"
        )

    workflow_json_path = workflow_dir / "workflow.json"
    if not workflow_json_path.is_file():
        result.errors.append(f"missing workflow.json at {workflow_json_path}")
        return result

    try:
        data = json.loads(workflow_json_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        result.errors.append(f"workflow.json is not valid JSON: {exc}")
        return result

    for key in REQUIRED_TOP_LEVEL_KEYS:
        if key not in data:
            result.errors.append(f"workflow.json missing required key {key!r}")
    if result.errors:
        return result

    declared_name = data.get("name")
    if declared_name is not None and declared_name != name:
        result.errors.append(
            f"workflow.json name field {declared_name!r} does not match directory name {name!r}"
        )

    phases = data["phases"]
    if not isinstance(phases, dict) or not phases:
        result.errors.append("phases must be a non-empty object")
        return result

    terminals = data["terminalPhases"]
    if not isinstance(terminals, list) or not terminals:
        result.errors.append("terminalPhases must be a non-empty array")
        return result
    terminals_set = set(terminals)

    missing_required_terminals = REQUIRED_TERMINALS - terminals_set
    if missing_required_terminals:
        result.errors.append(
            "terminalPhases missing required entries: "
            + ", ".join(sorted(missing_required_terminals))
        )

    entry = data["entryPhase"]
    if entry not in phases:
        result.errors.append(
            f"entryPhase {entry!r} is not declared in phases"
        )

    valid_targets = set(phases.keys()) | terminals_set

    for phase_name, phase_def in phases.items():
        if phase_name in RESERVED_PHASE_NAMES:
            result.errors.append(
                f"phase name {phase_name!r} is reserved; pick a different name"
            )
        if not NAME_PATTERN.match(phase_name):
            result.errors.append(
                f"phase name {phase_name!r} does not match {NAME_PATTERN.pattern}"
            )

        if not isinstance(phase_def, dict):
            result.errors.append(f"phase {phase_name!r} must be an object")
            continue

        rel_file = phase_def.get("file")
        if not rel_file or not isinstance(rel_file, str):
            result.errors.append(
                f"phase {phase_name!r} missing string 'file' field"
            )
        else:
            phase_path = workflow_dir / rel_file
            if not phase_path.is_file():
                result.errors.append(
                    f"phase {phase_name!r}: file {rel_file!r} not found at {phase_path}"
                )
            else:
                result.warnings.extend(_audit_phase_markdown(phase_name, phase_path))

        next_list = phase_def.get("next")
        if next_list is None:
            result.warnings.append(
                f"phase {phase_name!r} has no 'next' array; "
                "the orchestrator will accept any value Claude writes"
            )
        elif not isinstance(next_list, list) or not all(isinstance(n, str) for n in next_list):
            result.errors.append(
                f"phase {phase_name!r}: 'next' must be a list of strings"
            )
        else:
            unknown = [n for n in next_list if n not in valid_targets]
            if unknown:
                result.errors.append(
                    f"phase {phase_name!r}: next contains unknown targets "
                    + ", ".join(repr(n) for n in unknown)
                )

    for terminal in terminals:
        if not isinstance(terminal, str) or not terminal:
            result.errors.append(
                f"terminalPhases contains non-string or empty value: {terminal!r}"
            )

    return result


def _audit_phase_markdown(phase_name: str, path: Path) -> list[str]:
    """Soft-check the phase markdown for the documented sections.

    Returns warnings only — phase files do not have a strict structural
    schema, and the orchestrator appends a generic Required final actions
    block at invocation time. We surface advisories that help phase
    authors avoid common omissions.
    """
    warnings: list[str] = []
    text = path.read_text(encoding="utf-8")
    # Section heading: `## Output` (any case) on its own line. Substring
    # checks confuse "Output" the section with "no output yet" the prose.
    if not re.search(r"(?im)^\s*#{1,6}\s*output\b", text):
        warnings.append(
            f"phase {phase_name!r}: file {path.name} has no 'Output' section "
            "(see workflow-discipline.md §'Phase file contract')"
        )
    # HALT is a reserved orchestrator keyword and is conventionally written
    # in uppercase; lowercase 'halt' appears in incidental prose ("don't halt
    # the build") and is not a reliable signal.
    if "HALT" not in text:
        warnings.append(
            f"phase {phase_name!r}: file {path.name} does not mention HALT "
            "(every phase needs an explicit HALT discipline section)"
        )
    return warnings


def _list_workflows(workflows_dir: Path) -> Iterable[Path]:
    return sorted(p for p in workflows_dir.iterdir() if p.is_dir())


def _print_result(result: ValidationResult, stream) -> None:
    if result.ok and not result.warnings:
        print(f"OK: {result.workflow}", file=stream)
        return
    status = "OK" if result.ok else "FAIL"
    print(f"{status}: {result.workflow}", file=stream)
    for err in result.errors:
        print(f"  error: {err}", file=stream)
    for warn in result.warnings:
        print(f"  warning: {warn}", file=stream)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0] if __doc__ else None)
    parser.add_argument(
        "workflow",
        nargs="?",
        help="workflow name (directory under --workflows-dir)",
    )
    parser.add_argument(
        "--all",
        action="store_true",
        help="validate every workflow under --workflows-dir",
    )
    parser.add_argument(
        "--workflows-dir",
        type=Path,
        default=Path(".claude/workflows"),
        help="directory containing workflow definitions (default: .claude/workflows)",
    )
    args = parser.parse_args(argv)

    workflows_dir: Path = args.workflows_dir
    if not workflows_dir.is_dir():
        print(f"workflows directory not found: {workflows_dir}", file=sys.stderr)
        return 2

    if args.all and args.workflow:
        print("--all and a workflow name are mutually exclusive", file=sys.stderr)
        return 2
    if not args.all and not args.workflow:
        print("usage: validate-workflow.py <name> | --all", file=sys.stderr)
        return 2

    if args.all:
        targets = list(_list_workflows(workflows_dir))
        if not targets:
            print(f"no workflows found under {workflows_dir}", file=sys.stderr)
            return 0
    else:
        target = workflows_dir / args.workflow
        if not target.is_dir():
            print(f"workflow not found: {target}", file=sys.stderr)
            return 2
        targets = [target]

    overall_ok = True
    for wf in targets:
        result = validate_workflow(wf)
        _print_result(result, sys.stdout if result.ok else sys.stderr)
        overall_ok = overall_ok and result.ok

    return 0 if overall_ok else 1


if __name__ == "__main__":
    sys.exit(main())
