#!/usr/bin/env python3
"""Unit tests for `scripts/audit-npm.py`.

The script decides which npm advisory blocks a pull request and which one
opens the tracking issue. Those decisions are otherwise exercised only when
a real advisory lands in a lockfile, which is the moment they must already
be correct.
"""

import importlib.util
import pathlib
import sys
import unittest

_SPEC = importlib.util.spec_from_file_location(
    "audit_npm", pathlib.Path(__file__).parent / "audit-npm.py"
)
audit = importlib.util.module_from_spec(_SPEC)
# `@dataclass` resolves its field types through `sys.modules[cls.__module__]`,
# so the module has to be registered before it is executed.
sys.modules[_SPEC.name] = audit
_SPEC.loader.exec_module(audit)

LOCK = "packages/a/package-lock.json"


def advisory(name, severity="high", url=None):
    return {
        "source": 1,
        "name": name,
        "title": f"{name} hole",
        "url": url or f"https://github.com/advisories/GHSA-{name}",
        "severity": severity,
    }


def report(**vulnerabilities):
    return {"vulnerabilities": vulnerabilities}


class ParseFindingsTest(unittest.TestCase):
    def test_a_dependent_package_only_propagates_the_advisory_it_depends_on(self):
        found = audit.parse_findings(
            report(
                braces={"via": [advisory("braces")]},
                micromatch={"via": ["braces"]},
                globby={"via": ["micromatch"]},
            ),
            LOCK,
        )
        self.assertEqual([f.package for f in found], ["braces"])

    def test_two_advisories_on_one_package_are_two_findings(self):
        found = audit.parse_findings(
            report(nanoid={"via": [advisory("nanoid", url="u1"), advisory("nanoid", url="u2")]}),
            LOCK,
        )
        self.assertEqual(len(found), 2)

    def test_the_same_advisory_reached_through_two_entries_is_one_finding(self):
        found = audit.parse_findings(
            report(a={"via": [advisory("x")]}, b={"via": [advisory("x")]}), LOCK
        )
        self.assertEqual(len(found), 1)

    def test_an_error_report_is_an_audit_failure_not_a_clean_result(self):
        with self.assertRaises(audit.AuditError):
            audit.parse_findings({"error": {"summary": "registry unreachable"}}, LOCK)

    def test_a_clean_report_has_no_findings(self):
        self.assertEqual(audit.parse_findings({"vulnerabilities": {}}, LOCK), [])


class SeverityTest(unittest.TestCase):
    def finding(self, severity):
        return audit.Finding(LOCK, "p", severity, "t", "u")

    def test_high_and_critical_block(self):
        self.assertTrue(audit.is_blocking(self.finding("high")))
        self.assertTrue(audit.is_blocking(self.finding("critical")))

    def test_moderate_and_lower_do_not_block(self):
        for severity in ("moderate", "low", "info"):
            self.assertFalse(audit.is_blocking(self.finding(severity)), severity)


class NeedsAttentionTest(unittest.TestCase):
    old = audit.Finding(LOCK, "old", "high", "t", "u1")
    new = audit.Finding(LOCK, "new", "high", "t", "u2")

    def test_report_mode_needs_attention_for_any_blocking_finding(self):
        self.assertTrue(audit.needs_attention([self.old], {self.old.key}, "report"))

    def test_report_mode_is_quiet_without_blocking_findings(self):
        self.assertFalse(audit.needs_attention([], set(), "report"))

    def test_pr_mode_ignores_what_the_base_branch_already_has(self):
        self.assertFalse(audit.needs_attention([self.old], {self.old.key}, "pr"))

    def test_pr_mode_fails_for_an_advisory_the_diff_adds(self):
        self.assertTrue(audit.needs_attention([self.old, self.new], {self.old.key}, "pr"))

    def test_the_same_advisory_in_another_lockfile_counts_as_added(self):
        other = audit.Finding("packages/b/package-lock.json", "old", "high", "t", "u1")
        self.assertTrue(audit.needs_attention([other], {self.old.key}, "pr"))


class BuildReportTest(unittest.TestCase):
    finding = audit.Finding(LOCK, "braces", "high", "braces DoS", "https://example/ghsa")

    def build(self, findings, runtime=(), inherited=(), mode="report"):
        return audit.build_report(
            lockfiles=[LOCK],
            findings=findings,
            runtime=set(runtime),
            inherited=set(inherited),
            mode=mode,
        )

    def test_a_clean_report_says_how_many_lockfiles_were_scanned(self):
        self.assertIn("1 lockfiles scanned", self.build([]))

    def test_a_dev_only_finding_is_labelled_dev_only(self):
        self.assertIn(audit.DEV_ONLY, self.build([self.finding]))

    def test_a_finding_that_survives_omit_dev_is_labelled_runtime(self):
        text = self.build([self.finding], runtime={self.finding.key})
        self.assertIn(f"| {audit.RUNTIME} |", text)

    def test_lower_severities_are_counted_but_not_listed(self):
        low = audit.Finding(LOCK, "esbuild", "moderate", "esbuild", "u")
        text = self.build([low])
        self.assertIn("No high or critical", text)
        self.assertIn("1 lower-severity", text)
        self.assertNotIn("`esbuild`", text)

    def test_pr_mode_marks_what_the_diff_introduced(self):
        text = self.build([self.finding], mode="pr")
        self.assertIn("1 introduced by this pull request", text)
        self.assertIn("**yes**", text)


if __name__ == "__main__":
    unittest.main()
