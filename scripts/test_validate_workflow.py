#!/usr/bin/env python3
"""Tests for `validate-workflow.py`.

Each test assembles a synthetic workflow tree in a tempdir, calls the
validator's pure entry point, and asserts on the resulting errors and
warnings. The real `.claude/workflows/` corpus is exercised through one
integration test that simply asserts every shipped workflow currently
passes validation.
"""
from __future__ import annotations

import importlib.util
import json
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

SCRIPTS_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS_DIR))

_spec = importlib.util.spec_from_file_location(
    "validate_workflow", SCRIPTS_DIR / "validate-workflow.py"
)
assert _spec is not None and _spec.loader is not None
validate_workflow = importlib.util.module_from_spec(_spec)
sys.modules["validate_workflow"] = validate_workflow
_spec.loader.exec_module(validate_workflow)


VALID_WORKFLOW_JSON = {
    "name": "demo",
    "description": "demo workflow",
    "entryPhase": "preflight",
    "phases": {
        "preflight": {"file": "phases/preflight.md", "next": ["main", "HALT"]},
        "main": {"file": "phases/main.md", "next": ["done", "HALT"]},
    },
    "terminalPhases": ["done", "HALT"],
}

PHASE_MD_WITH_OUTPUT_AND_HALT = (
    "# Phase: demo\n"
    "\n"
    "## Steps\n"
    "1. do thing\n"
    "\n"
    "## Output\n"
    "Set next_phase to ...; on failure HALT.\n"
)


def _materialize(root: Path, name: str, workflow: dict, phase_bodies: dict[str, str]) -> Path:
    wf_dir = root / name
    (wf_dir / "phases").mkdir(parents=True)
    (wf_dir / "workflow.json").write_text(json.dumps(workflow), encoding="utf-8")
    for phase_name, body in phase_bodies.items():
        (wf_dir / "phases" / f"{phase_name}.md").write_text(body, encoding="utf-8")
    return wf_dir


class ValidateWorkflowTests(unittest.TestCase):
    def test_valid_workflow_passes(self) -> None:
        with TemporaryDirectory() as tmp:
            wf_dir = _materialize(
                Path(tmp),
                "demo",
                VALID_WORKFLOW_JSON,
                {
                    "preflight": PHASE_MD_WITH_OUTPUT_AND_HALT,
                    "main": PHASE_MD_WITH_OUTPUT_AND_HALT,
                },
            )
            result = validate_workflow.validate_workflow(wf_dir)
            self.assertTrue(result.ok, msg=f"errors: {result.errors}")
            self.assertEqual(result.warnings, [])

    def test_missing_workflow_json(self) -> None:
        with TemporaryDirectory() as tmp:
            wf_dir = Path(tmp) / "demo"
            wf_dir.mkdir()
            result = validate_workflow.validate_workflow(wf_dir)
            self.assertFalse(result.ok)
            self.assertTrue(
                any("missing workflow.json" in e for e in result.errors),
                msg=result.errors,
            )

    def test_invalid_directory_name(self) -> None:
        with TemporaryDirectory() as tmp:
            wf_dir = _materialize(
                Path(tmp),
                "BadName",
                {**VALID_WORKFLOW_JSON, "name": "BadName"},
                {
                    "preflight": PHASE_MD_WITH_OUTPUT_AND_HALT,
                    "main": PHASE_MD_WITH_OUTPUT_AND_HALT,
                },
            )
            result = validate_workflow.validate_workflow(wf_dir)
            self.assertFalse(result.ok)
            self.assertTrue(
                any("does not match" in e and "BadName" in e for e in result.errors),
                msg=result.errors,
            )

    def test_name_field_mismatch(self) -> None:
        with TemporaryDirectory() as tmp:
            wf_dir = _materialize(
                Path(tmp),
                "demo",
                {**VALID_WORKFLOW_JSON, "name": "other"},
                {
                    "preflight": PHASE_MD_WITH_OUTPUT_AND_HALT,
                    "main": PHASE_MD_WITH_OUTPUT_AND_HALT,
                },
            )
            result = validate_workflow.validate_workflow(wf_dir)
            self.assertFalse(result.ok)
            self.assertTrue(
                any("name field" in e for e in result.errors),
                msg=result.errors,
            )

    def test_entry_phase_not_in_phases(self) -> None:
        with TemporaryDirectory() as tmp:
            bad = {**VALID_WORKFLOW_JSON, "entryPhase": "nope"}
            wf_dir = _materialize(
                Path(tmp),
                "demo",
                bad,
                {
                    "preflight": PHASE_MD_WITH_OUTPUT_AND_HALT,
                    "main": PHASE_MD_WITH_OUTPUT_AND_HALT,
                },
            )
            result = validate_workflow.validate_workflow(wf_dir)
            self.assertFalse(result.ok)
            self.assertTrue(
                any("entryPhase" in e and "nope" in e for e in result.errors),
                msg=result.errors,
            )

    def test_next_references_unknown_phase(self) -> None:
        bad = json.loads(json.dumps(VALID_WORKFLOW_JSON))
        bad["phases"]["preflight"]["next"] = ["doesnotexist", "HALT"]
        with TemporaryDirectory() as tmp:
            wf_dir = _materialize(
                Path(tmp),
                "demo",
                bad,
                {
                    "preflight": PHASE_MD_WITH_OUTPUT_AND_HALT,
                    "main": PHASE_MD_WITH_OUTPUT_AND_HALT,
                },
            )
            result = validate_workflow.validate_workflow(wf_dir)
            self.assertFalse(result.ok)
            self.assertTrue(
                any("doesnotexist" in e for e in result.errors),
                msg=result.errors,
            )

    def test_phase_file_missing(self) -> None:
        with TemporaryDirectory() as tmp:
            # materialise only the preflight phase file; main's reference dangles.
            wf_dir = _materialize(
                Path(tmp),
                "demo",
                VALID_WORKFLOW_JSON,
                {"preflight": PHASE_MD_WITH_OUTPUT_AND_HALT},
            )
            result = validate_workflow.validate_workflow(wf_dir)
            self.assertFalse(result.ok)
            self.assertTrue(
                any("phases/main.md" in e for e in result.errors),
                msg=result.errors,
            )

    def test_terminal_phases_missing_halt(self) -> None:
        bad = json.loads(json.dumps(VALID_WORKFLOW_JSON))
        bad["terminalPhases"] = ["done"]
        # Also remove HALT from next arrays so we hit the missing-HALT error
        # without colliding with the next-references-unknown-target check.
        bad["phases"]["preflight"]["next"] = ["main"]
        bad["phases"]["main"]["next"] = ["done"]
        with TemporaryDirectory() as tmp:
            wf_dir = _materialize(
                Path(tmp),
                "demo",
                bad,
                {
                    "preflight": PHASE_MD_WITH_OUTPUT_AND_HALT,
                    "main": PHASE_MD_WITH_OUTPUT_AND_HALT,
                },
            )
            result = validate_workflow.validate_workflow(wf_dir)
            self.assertFalse(result.ok)
            self.assertTrue(
                any("HALT" in e for e in result.errors),
                msg=result.errors,
            )

    def test_phase_markdown_missing_output_section_is_warning(self) -> None:
        with TemporaryDirectory() as tmp:
            wf_dir = _materialize(
                Path(tmp),
                "demo",
                VALID_WORKFLOW_JSON,
                {
                    "preflight": "# Phase: bare\n\nNo output section, no halt mention.\n",
                    "main": PHASE_MD_WITH_OUTPUT_AND_HALT,
                },
            )
            result = validate_workflow.validate_workflow(wf_dir)
            # Missing Output / HALT mention are warnings, not errors.
            self.assertTrue(result.ok, msg=f"errors: {result.errors}")
            self.assertTrue(
                any("Output" in w for w in result.warnings),
                msg=result.warnings,
            )
            self.assertTrue(
                any("HALT" in w for w in result.warnings),
                msg=result.warnings,
            )

    def test_reserved_phase_name_rejected(self) -> None:
        bad = json.loads(json.dumps(VALID_WORKFLOW_JSON))
        # Rename a phase to the reserved keyword HALT.
        bad["phases"]["HALT"] = bad["phases"].pop("main")
        bad["phases"]["preflight"]["next"] = ["HALT"]
        with TemporaryDirectory() as tmp:
            # Need to write the renamed phase markdown too.
            (Path(tmp) / "demo" / "phases").mkdir(parents=True)
            (Path(tmp) / "demo" / "workflow.json").write_text(
                json.dumps(bad), encoding="utf-8"
            )
            (Path(tmp) / "demo" / "phases" / "preflight.md").write_text(
                PHASE_MD_WITH_OUTPUT_AND_HALT, encoding="utf-8"
            )
            (Path(tmp) / "demo" / "phases" / "main.md").write_text(
                PHASE_MD_WITH_OUTPUT_AND_HALT, encoding="utf-8"
            )
            result = validate_workflow.validate_workflow(Path(tmp) / "demo")
            self.assertFalse(result.ok)
            self.assertTrue(
                any("reserved" in e for e in result.errors),
                msg=result.errors,
            )


class RealWorkflowsIntegrationTest(unittest.TestCase):
    """Every workflow shipped in the repo must currently pass validation."""

    def test_all_shipped_workflows_pass(self) -> None:
        repo_root = SCRIPTS_DIR.parent
        workflows_dir = repo_root / ".claude" / "workflows"
        if not workflows_dir.is_dir():
            self.skipTest("no .claude/workflows directory in this checkout")
        shipped = sorted(p for p in workflows_dir.iterdir() if p.is_dir())
        if not shipped:
            self.skipTest("no workflows found to validate")
        failures: list[str] = []
        for wf_dir in shipped:
            result = validate_workflow.validate_workflow(wf_dir)
            if not result.ok:
                failures.append(f"{wf_dir.name}: {result.errors}")
        self.assertEqual(failures, [], msg="\n".join(failures))


if __name__ == "__main__":
    unittest.main()
