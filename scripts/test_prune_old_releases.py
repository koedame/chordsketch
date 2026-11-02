#!/usr/bin/env python3
"""Tests for `prune-old-releases.py`.

Uses only `unittest` from stdlib. `gh` is replaced by a recording fake so
no test touches the network or deletes a real release.
"""

from __future__ import annotations

import importlib.util
import io
import json
import subprocess
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parent

_spec = importlib.util.spec_from_file_location(
    "prune_old_releases", SCRIPTS_DIR / "prune-old-releases.py"
)
prune = importlib.util.module_from_spec(_spec)
assert _spec.loader is not None
_spec.loader.exec_module(prune)

LIBRARY = ["v0.1.0", "v0.2.2", "v0.8.0", "v0.9.0", "v0.10.0"]
DESKTOP = ["desktop-v0.3.0", "desktop-v0.8.0", "desktop-v0.9.0"]


class FakeGh:
    def __init__(self, tags, fail_on=()):
        self.tags = tags
        self.fail_on = set(fail_on)
        self.deleted = []
        self.calls = []

    def __call__(self, args):
        self.calls.append(args)
        if args[:2] == ["release", "list"]:
            return json.dumps([{"tagName": t} for t in self.tags])
        if args[:2] == ["release", "delete"]:
            if args[2] in self.fail_on:
                raise subprocess.CalledProcessError(1, "gh", stderr="boom")
            self.deleted.append(args[2])
            return ""
        raise AssertionError(f"unexpected gh call: {args}")


def run(argv, gh):
    out, err = io.StringIO(), io.StringIO()
    with redirect_stdout(out), redirect_stderr(err):
        code = prune.main(argv, gh=gh)
    return code, out.getvalue(), err.getvalue()


class PlanTest(unittest.TestCase):
    def test_when_a_newer_release_is_published_every_older_release_of_the_family_is_stale(self):
        stale, reason = prune.plan(LIBRARY + DESKTOP + ["beta-channel"], "v0.10.0")
        self.assertIsNone(reason)
        self.assertEqual(stale, ["v0.1.0", "v0.2.2", "v0.8.0", "v0.9.0"])

    def test_when_versions_are_compared_they_are_compared_as_numbers_not_strings(self):
        stale, _ = prune.plan(["v0.9.0", "v0.10.0", "v0.2.0"], "v0.10.0")
        self.assertEqual(stale, ["v0.2.0", "v0.9.0"])

    def test_when_a_desktop_release_is_published_library_releases_are_not_stale(self):
        stale, _ = prune.plan(LIBRARY + DESKTOP, "desktop-v0.9.0")
        self.assertEqual(stale, ["desktop-v0.3.0", "desktop-v0.8.0"])

    def test_when_a_library_release_is_published_desktop_releases_are_not_stale(self):
        stale, _ = prune.plan(LIBRARY + DESKTOP, "v0.10.0")
        self.assertFalse([t for t in stale if t.startswith("desktop-")])

    def test_when_planning_the_published_release_itself_is_never_stale(self):
        stale, _ = prune.plan(LIBRARY, "v0.10.0")
        self.assertNotIn("v0.10.0", stale)

    def test_when_a_newer_release_already_exists_nothing_is_stale_and_a_reason_is_given(self):
        stale, reason = prune.plan(LIBRARY, "v0.8.0")
        self.assertEqual(stale, [])
        self.assertIn("v0.10.0", reason)

    def test_when_the_published_release_does_not_exist_planning_fails(self):
        with self.assertRaises(ValueError):
            prune.plan(LIBRARY, "v0.11.0")

    def test_when_the_given_name_is_not_a_release_tag_planning_fails(self):
        with self.assertRaises(ValueError):
            prune.plan(LIBRARY + ["beta-channel"], "beta-channel")

    def test_when_a_tag_is_not_shaped_like_a_version_it_is_never_stale(self):
        stale, _ = prune.plan(["v0.9.0", "v0.10.0", "vNEXT", "v1", "latest"], "v0.10.0")
        self.assertEqual(stale, ["v0.9.0"])

    def test_when_a_stable_release_is_published_older_prereleases_are_stale_too(self):
        stale, _ = prune.plan(["v0.9.0-rc.1", "v0.9.0-rc.2", "v0.8.0", "v0.9.0"], "v0.9.0")
        self.assertEqual(stale, ["v0.8.0", "v0.9.0-rc.1", "v0.9.0-rc.2"])

    def test_when_a_prerelease_is_published_the_newest_stable_release_is_kept(self):
        stale, _ = prune.plan(["v0.8.0", "v0.10.0-rc.1", "v0.10.0-rc.2", "v0.9.0"], "v0.10.0-rc.2")
        self.assertEqual(stale, ["v0.10.0-rc.1"])

    def test_when_prereleases_are_compared_numeric_identifiers_compare_as_numbers(self):
        stale, reason = prune.plan(["v0.10.0-rc.9", "v0.10.0-rc.10"], "v0.10.0-rc.9")
        self.assertEqual(stale, [])
        self.assertIn("v0.10.0-rc.10", reason)


class MainTest(unittest.TestCase):
    def test_when_dry_run_is_set_nothing_is_deleted_and_the_plan_is_printed(self):
        gh = FakeGh(LIBRARY + DESKTOP)
        code, out, _ = run(["--tag", "v0.10.0", "--dry-run"], gh)
        self.assertEqual(code, 0)
        self.assertEqual(gh.deleted, [])
        self.assertIn("would delete release v0.9.0", out)

    def test_when_run_normally_only_older_releases_of_the_family_are_deleted(self):
        gh = FakeGh(LIBRARY + DESKTOP + ["beta-channel"])
        code, _, _ = run(["--tag", "v0.10.0"], gh)
        self.assertEqual(code, 0)
        self.assertEqual(sorted(gh.deleted), ["v0.1.0", "v0.2.2", "v0.8.0", "v0.9.0"])

    def test_when_deleting_the_git_tag_is_not_cleaned_up(self):
        gh = FakeGh(LIBRARY)
        run(["--tag", "v0.10.0"], gh)
        deletes = [c for c in gh.calls if c[:2] == ["release", "delete"]]
        self.assertTrue(deletes)
        for call in deletes:
            self.assertNotIn("--cleanup-tag", call)
            self.assertIn("--yes", call)

    def test_when_the_given_release_is_not_the_newest_nothing_is_deleted_and_it_succeeds(self):
        gh = FakeGh(LIBRARY)
        code, out, _ = run(["--tag", "v0.8.0"], gh)
        self.assertEqual(code, 0)
        self.assertEqual(gh.deleted, [])
        self.assertIn("Nothing deleted", out)

    def test_when_the_published_release_is_missing_nothing_is_deleted_and_it_fails(self):
        gh = FakeGh(LIBRARY)
        code, _, err = run(["--tag", "v0.11.0"], gh)
        self.assertEqual(code, 1)
        self.assertEqual(gh.deleted, [])
        self.assertIn("does not exist", err)

    def test_when_one_deletion_fails_the_rest_are_deleted_and_the_run_fails(self):
        gh = FakeGh(LIBRARY, fail_on={"v0.8.0"})
        code, _, err = run(["--tag", "v0.10.0"], gh)
        self.assertEqual(code, 1)
        self.assertEqual(sorted(gh.deleted), ["v0.1.0", "v0.2.2", "v0.9.0"])
        self.assertIn("v0.8.0", err)

    def test_when_nothing_is_older_nothing_is_deleted_and_it_succeeds(self):
        gh = FakeGh(["v0.10.0"])
        code, _, _ = run(["--tag", "v0.10.0"], gh)
        self.assertEqual(code, 0)
        self.assertEqual(gh.deleted, [])


if __name__ == "__main__":
    unittest.main()
