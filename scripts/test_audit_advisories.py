#!/usr/bin/env python3
"""Unit tests for `scripts/audit-advisories.py`.

The script's decisions (which advisory blocks a PR, which one opens an
issue, when an ignore entry has gone stale) are otherwise only exercised
when a real advisory lands in `Cargo.lock`, which is exactly the moment
they must already be correct.
"""

import datetime as dt
import importlib.util
import json
import pathlib
import sys
import tempfile
import unittest

_SPEC = importlib.util.spec_from_file_location(
    "audit_advisories", pathlib.Path(__file__).parent / "audit-advisories.py"
)
audit = importlib.util.module_from_spec(_SPEC)
# `@dataclass` resolves its field types through `sys.modules[cls.__module__]`,
# so the module has to be registered before it is executed.
sys.modules[_SPEC.name] = audit
_SPEC.loader.exec_module(audit)

TODAY = dt.date(2026, 9, 1)


def vulnerability(package, version, advisory_id, *, patched=None, title="A hole"):
    return {
        "advisory": {
            "id": advisory_id,
            "package": package,
            "title": title,
            "url": f"https://rustsec.org/advisories/{advisory_id}",
        },
        "versions": {"patched": patched or []},
        "package": {"name": package, "version": version},
    }


def report(vulns=(), warnings=None):
    return {
        "vulnerabilities": {"found": bool(vulns), "count": len(vulns), "list": list(vulns)},
        "warnings": warnings or {},
    }


class ParseAuditReportTest(unittest.TestCase):
    def test_a_vulnerability_entry_becomes_a_finding_with_its_patched_range(self):
        vulns, warns = audit.parse_audit_report(
            report([vulnerability("time", "0.3.45", "RUSTSEC-2026-0009", patched=[">= 0.3.47"])])
        )
        self.assertEqual(warns, [])
        self.assertEqual(len(vulns), 1)
        self.assertEqual(vulns[0].advisory_id, "RUSTSEC-2026-0009")
        self.assertEqual(vulns[0].package, "time")
        self.assertEqual(vulns[0].version, "0.3.45")
        self.assertEqual(vulns[0].patched, ">= 0.3.47")
        self.assertEqual(vulns[0].kind, "vulnerability")

    def test_when_no_patched_version_exists_the_patched_column_reads_none(self):
        vulns, _ = audit.parse_audit_report(report([vulnerability("x", "1.0.0", "RUSTSEC-2026-0001")]))
        self.assertEqual(vulns[0].patched, "none")

    def test_warnings_keep_their_kind_and_are_not_reported_as_vulnerabilities(self):
        vulns, warns = audit.parse_audit_report(
            report(
                warnings={
                    "unmaintained": [
                        dict(vulnerability("gtk", "0.18.2", "RUSTSEC-2024-0415"), kind="unmaintained")
                    ],
                    "unsound": [
                        dict(vulnerability("anyhow", "1.0.102", "RUSTSEC-2026-0190"), kind="unsound")
                    ],
                }
            )
        )
        self.assertEqual(vulns, [])
        self.assertEqual([(w.kind, w.package) for w in warns], [("unmaintained", "gtk"), ("unsound", "anyhow")])

    def test_a_yanked_warning_without_an_advisory_is_skipped(self):
        vulns, warns = audit.parse_audit_report(
            report(warnings={"yanked": [{"kind": "yanked", "package": {"name": "y", "version": "1.0.0"}}]})
        )
        self.assertEqual((vulns, warns), ([], []))

    def test_an_empty_report_yields_no_findings(self):
        self.assertEqual(audit.parse_audit_report({}), ([], []))


class ScopeTest(unittest.TestCase):
    TREE = """
chordsketch v0.6.0 (/home/runner/work/chordsketch/crates/cli)
time v0.3.45
quick-xml v0.38.4 (*)

"""

    def test_a_crate_in_the_non_dev_tree_is_labelled_runtime(self):
        runtime = audit.parse_runtime_packages(self.TREE)
        self.assertEqual(runtime, {"chordsketch", "time", "quick-xml"})
        finding = audit.parse_audit_report(report([vulnerability("time", "0.3.45", "RUSTSEC-2026-0009")]))[0][0]
        self.assertEqual(audit.scope_of(finding, runtime), audit.RUNTIME)

    def test_a_crate_absent_from_the_non_dev_tree_is_labelled_dev_only(self):
        runtime = audit.parse_runtime_packages(self.TREE)
        finding = audit.parse_audit_report(report([vulnerability("lopdf", "0.38.0", "RUSTSEC-2026-0187")]))[0][0]
        self.assertEqual(audit.scope_of(finding, runtime), audit.DEV_ONLY)

    def test_without_a_tree_every_finding_is_labelled_unknown(self):
        finding = audit.parse_audit_report(report([vulnerability("time", "0.3.45", "RUSTSEC-2026-0009")]))[0][0]
        self.assertEqual(audit.scope_of(finding, None), audit.UNKNOWN_SCOPE)


class IgnoreListTest(unittest.TestCase):
    def entries(self, text, today=TODAY):
        return audit.parse_ignore_entries(text, today)

    def test_a_documented_entry_within_its_review_date_has_no_problems(self):
        entries = self.entries(
            """
[advisories]
ignore = [
  # why: transitively pinned by tauri; no compatible release yet
  # review-by: 2026-12-01
  "RUSTSEC-2026-0194",
]
"""
        )
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0].advisory_id, "RUSTSEC-2026-0194")
        self.assertEqual(entries[0].why, "transitively pinned by tauri; no compatible release yet")
        self.assertEqual(entries[0].review_by, dt.date(2026, 12, 1))
        self.assertEqual(entries[0].problems, [])

    def test_an_entry_past_its_review_date_is_reported(self):
        entries = self.entries(
            """
[advisories]
ignore = [
  # why: waiting on upstream
  # review-by: 2026-08-01
  "RUSTSEC-2026-0194",
]
"""
        )
        self.assertEqual(len(entries[0].problems), 1)
        self.assertIn("2026-08-01 has passed", entries[0].problems[0])

    def test_an_entry_without_a_why_or_a_review_date_is_reported(self):
        entries = self.entries(
            """
[advisories]
ignore = ["RUSTSEC-2026-0194",
]
"""
        )
        self.assertEqual(len(entries), 1)
        self.assertEqual(len(entries[0].problems), 2)

    def test_a_malformed_review_date_is_reported(self):
        entries = self.entries(
            """
[advisories]
ignore = [
  # why: waiting on upstream
  # review-by: soon
  "RUSTSEC-2026-0194",
]
"""
        )
        self.assertIn("not a YYYY-MM-DD date", entries[0].problems[0])

    def test_comments_do_not_leak_from_one_entry_to_the_next(self):
        entries = self.entries(
            """
[advisories]
ignore = [
  # why: waiting on upstream
  # review-by: 2026-12-01
  "RUSTSEC-2026-0194",
  "RUSTSEC-2026-0195",
]
"""
        )
        self.assertEqual(entries[1].advisory_id, "RUSTSEC-2026-0195")
        self.assertEqual(len(entries[1].problems), 2)

    def test_an_empty_ignore_list_yields_no_entries_and_no_problems(self):
        text = "[advisories]\nignore = []\n"
        entries = self.entries(text)
        self.assertEqual(entries, [])
        self.assertEqual(audit.check_ignore_parse(text, entries), [])

    def test_a_layout_the_comment_scanner_misreads_is_reported_not_silently_dropped(self):
        # Two ids on one line: the scanner attaches the comments to the
        # first and loses the second, so the TOML cross-check must fire.
        text = """
[advisories]
ignore = [
  # why: waiting on upstream
  # review-by: 2026-12-01
  "RUSTSEC-2026-0194", "RUSTSEC-2026-0195",
]
"""
        entries = self.entries(text)
        problems = audit.check_ignore_parse(text, entries)
        self.assertEqual(len(problems), 1)
        self.assertIn("one advisory id per line", problems[0])

    def test_invalid_toml_is_reported(self):
        problems = audit.check_ignore_parse("[advisories\nignore = []", [])
        self.assertEqual(len(problems), 1)
        self.assertIn("not valid TOML", problems[0])


class NeedsAttentionTest(unittest.TestCase):
    def setUp(self):
        self.vulns, _ = audit.parse_audit_report(
            report([vulnerability("time", "0.3.45", "RUSTSEC-2026-0009")])
        )

    def test_on_a_pull_request_an_advisory_the_diff_adds_needs_attention(self):
        self.assertTrue(
            audit.needs_attention(
                vulnerabilities=self.vulns, inherited=set(), ignores=[], ignore_problems=[], mode="pr"
            )
        )

    def test_on_a_pull_request_an_advisory_already_on_the_base_branch_does_not(self):
        self.assertFalse(
            audit.needs_attention(
                vulnerabilities=self.vulns,
                inherited={("RUSTSEC-2026-0009", "time")},
                ignores=[],
                ignore_problems=[],
                mode="pr",
            )
        )

    def test_in_report_mode_an_inherited_advisory_still_needs_attention(self):
        self.assertTrue(
            audit.needs_attention(
                vulnerabilities=self.vulns,
                inherited={("RUSTSEC-2026-0009", "time")},
                ignores=[],
                ignore_problems=[],
                mode="report",
            )
        )

    def test_a_stale_ignore_entry_needs_attention_even_with_no_advisories(self):
        stale = audit.IgnoreEntry(advisory_id="RUSTSEC-2026-0194", problems=["review date has passed"])
        self.assertTrue(
            audit.needs_attention(
                vulnerabilities=[], inherited=set(), ignores=[stale], ignore_problems=[], mode="report"
            )
        )

    def test_a_clean_lockfile_with_a_healthy_ignore_list_needs_nothing(self):
        healthy = audit.IgnoreEntry(
            advisory_id="RUSTSEC-2026-0194", why="pinned upstream", review_by=dt.date(2026, 12, 1)
        )
        self.assertFalse(
            audit.needs_attention(
                vulnerabilities=[], inherited=set(), ignores=[healthy], ignore_problems=[], mode="report"
            )
        )


class BuildReportTest(unittest.TestCase):
    def build(self, **kwargs):
        base = dict(
            vulnerabilities=[],
            warnings=[],
            inherited=set(),
            runtime={"time"},
            ignores=[],
            ignore_problems=[],
            mode="report",
        )
        base.update(kwargs)
        return audit.build_report(**base)

    def test_a_clean_report_says_so_instead_of_printing_an_empty_table(self):
        self.assertIn("No vulnerabilities", self.build())

    def test_a_report_mode_table_carries_the_advisory_link_crate_and_scope(self):
        vulns, _ = audit.parse_audit_report(
            report([vulnerability("time", "0.3.45", "RUSTSEC-2026-0009", patched=[">= 0.3.47"])])
        )
        text = self.build(vulnerabilities=vulns)
        self.assertIn("[RUSTSEC-2026-0009](https://rustsec.org/advisories/RUSTSEC-2026-0009)", text)
        self.assertIn("`time` 0.3.45", text)
        self.assertIn("runtime", text)
        self.assertIn(">= 0.3.47", text)

    def test_pr_mode_separates_what_the_diff_added_from_what_it_inherited(self):
        vulns, _ = audit.parse_audit_report(
            report(
                [
                    vulnerability("time", "0.3.45", "RUSTSEC-2026-0009"),
                    vulnerability("quick-xml", "0.38.4", "RUSTSEC-2026-0194"),
                ]
            )
        )
        text = self.build(
            vulnerabilities=vulns, inherited={("RUSTSEC-2026-0194", "quick-xml")}, mode="pr"
        )
        added, inherited = text.split("<details>")
        self.assertIn("RUSTSEC-2026-0009", added)
        self.assertNotIn("RUSTSEC-2026-0194", added)
        self.assertIn("RUSTSEC-2026-0194", inherited)

    def test_ignore_problems_appear_in_the_report(self):
        text = self.build(
            ignores=[
                audit.IgnoreEntry(
                    advisory_id="RUSTSEC-2026-0194",
                    why="pinned upstream",
                    review_by_raw="2026-08-01",
                    problems=["review date 2026-08-01 has passed"],
                )
            ]
        )
        self.assertIn("Ignore-list problems", text)
        self.assertIn("review date 2026-08-01 has passed", text)

    def test_without_a_dependency_tree_the_report_says_scope_is_unknown(self):
        vulns, _ = audit.parse_audit_report(report([vulnerability("time", "0.3.45", "RUSTSEC-2026-0009")]))
        text = self.build(vulnerabilities=vulns, runtime=None)
        self.assertIn("unknown", text)
        self.assertIn("Scope could not be computed", text)


class MainTest(unittest.TestCase):
    def run_main(self, audit_report, **kwargs):
        with tempfile.TemporaryDirectory() as tmp:
            path = pathlib.Path(tmp)
            (path / "audit.json").write_text(json.dumps(audit_report), encoding="utf-8")
            argv = ["--audit-json", str(path / "audit.json"), "--today", TODAY.isoformat()]
            for name, content in kwargs.items():
                flag = "--" + name.replace("_", "-")
                target = path / name
                target.write_text(content, encoding="utf-8")
                argv += [flag, str(target)]
            out = path / "report.md"
            argv += ["--output", str(out)]
            code = audit.main(argv)
            return code, out.read_text(encoding="utf-8")

    def test_a_clean_lockfile_exits_zero(self):
        code, text = self.run_main(report())
        self.assertEqual(code, 0)
        self.assertIn("No vulnerabilities", text)

    def test_a_vulnerable_lockfile_exits_one_in_report_mode(self):
        code, _ = self.run_main(report([vulnerability("time", "0.3.45", "RUSTSEC-2026-0009")]))
        self.assertEqual(code, 1)

    def test_a_stale_ignore_entry_alone_exits_one(self):
        code, text = self.run_main(
            report(),
            audit_config='[advisories]\nignore = [\n  # why: x\n  # review-by: 2026-01-01\n  "RUSTSEC-2026-0194",\n]\n',
        )
        self.assertEqual(code, 1)
        self.assertIn("has passed", text)


if __name__ == "__main__":
    unittest.main()
