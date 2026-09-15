#!/usr/bin/env python3
"""Tests for `scripts/release.py`.

Covers the decisions the script makes before it publishes anything — the
part a refactor could quietly break without any registry noticing:

  1. `decide` refuses a version some channel already serves when the tag
     is not out, refuses a release with nothing left to do, and otherwise
     lists exactly what is pending.
  2. The release is built from the tagged commit once a tag exists, and
     from `origin/main` before that; `publish-registries.yml` is pointed at
     that commit before the tag and at the tag after it.
  3. A failed dispatched run is reported by the errors its jobs annotated,
     not by GitHub's generic exit-code annotation.
  4. The small parsers the preflight relies on. (What crates.io and npm are
     checked for is tested in `test_publish_checks.py` and
     `test_publish_registries.py`.)
  5. The script is executable, since the documented invocation is
     `scripts/release.py X.Y.Z` rather than `python3 scripts/release.py`.

Stdlib `unittest` only. Nothing here touches the network, git or gh.
"""

from __future__ import annotations

import importlib.util
import os
import sys
import unittest
from pathlib import Path
from unittest import mock

SCRIPTS_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS_DIR))

_spec = importlib.util.spec_from_file_location("release", SCRIPTS_DIR / "release.py")
assert _spec is not None and _spec.loader is not None
release = importlib.util.module_from_spec(_spec)
sys.modules["release"] = release
_spec.loader.exec_module(release)

SHA = "3066fb8bb5b3a966b804d76e63eb8727199ae30e"
NO_TAGS = {"v1.2.0": None, "desktop-v1.2.0": None}
BOTH_TAGS = {"v1.2.0": SHA, "desktop-v1.2.0": SHA}


class DecideTest(unittest.TestCase):
    def test_untagged_version_nobody_serves_plans_the_whole_release(self) -> None:
        plan = release.decide(
            "1.2.0",
            NO_TAGS,
            {"docker-hub": False, "pypi": False},
            {"chordsketch": False},
            {"@chordsketch/wasm": False},
        )
        self.assertEqual(plan.refusal, "")
        self.assertEqual(plan.tags_to_push, ("v1.2.0", "desktop-v1.2.0"))
        self.assertEqual(plan.pending_ci, ("docker-hub", "pypi"))
        self.assertEqual(plan.pending_crates, ("chordsketch",))
        self.assertEqual(plan.pending_npm, ("@chordsketch/wasm",))

    def test_untagged_version_already_on_a_registry_is_refused(self) -> None:
        plan = release.decide(
            "1.2.0",
            NO_TAGS,
            {"docker-hub": False},
            {"chordsketch": True},
            {"@chordsketch/wasm": False},
        )
        self.assertIn("already serve 1.2.0: chordsketch", plan.refusal)
        self.assertEqual(plan.tags_to_push, ())

    def test_untagged_version_already_on_a_ci_channel_is_refused(self) -> None:
        plan = release.decide("1.2.0", NO_TAGS, {"pypi": True}, {}, {})
        self.assertIn("pypi", plan.refusal)

    def test_tagged_version_with_every_channel_published_is_refused(self) -> None:
        plan = release.decide(
            "1.2.0",
            BOTH_TAGS,
            {"docker-hub": True},
            {"chordsketch": True},
            {"@chordsketch/wasm": True},
        )
        self.assertIn("already fully released", plan.refusal)

    def test_tagged_version_resumes_with_only_the_missing_channels(self) -> None:
        plan = release.decide(
            "1.2.0",
            BOTH_TAGS,
            {"docker-hub": False, "pypi": True},
            {"chordsketch-chordpro": True, "chordsketch": False},
            {"@chordsketch/wasm": True, "@chordsketch/node": False},
        )
        self.assertEqual(plan.refusal, "")
        self.assertEqual(plan.tags_to_push, ())
        self.assertEqual(plan.pending_ci, ("docker-hub",))
        self.assertEqual(plan.pending_crates, ("chordsketch",))
        self.assertEqual(plan.pending_npm, ("@chordsketch/node",))

    def test_one_missing_tag_is_pushed_even_when_every_channel_is_published(self) -> None:
        plan = release.decide(
            "1.2.0",
            {"v1.2.0": SHA, "desktop-v1.2.0": None},
            {"docker-hub": True},
            {"chordsketch": True},
            {},
        )
        self.assertEqual(plan.refusal, "")
        self.assertEqual(plan.tags_to_push, ("desktop-v1.2.0",))


class ChooseReleaseCommitTest(unittest.TestCase):
    MAIN = "5e23481527a9591d631cb8a1938561950b3a72e0"

    def test_untagged_release_is_built_from_origin_main(self) -> None:
        self.assertEqual(release.choose_release_commit(NO_TAGS, self.MAIN), (self.MAIN, ""))

    def test_tagged_release_is_built_from_the_tag_even_after_main_moved(self) -> None:
        self.assertEqual(release.choose_release_commit(BOTH_TAGS, self.MAIN), (SHA, ""))

    def test_a_single_existing_tag_decides_the_commit(self) -> None:
        tags = {"v1.2.0": None, "desktop-v1.2.0": SHA}
        self.assertEqual(release.choose_release_commit(tags, self.MAIN), (SHA, ""))

    def test_tags_on_different_commits_are_refused(self) -> None:
        tags = {"v1.2.0": SHA, "desktop-v1.2.0": self.MAIN}
        commit, refusal = release.choose_release_commit(tags, self.MAIN)
        self.assertEqual(commit, "")
        self.assertIn("different commits", refusal)


class RegistryRefTest(unittest.TestCase):
    def survey(self) -> "release.Survey":
        return release.Survey("1.2.0", SHA, Path("/nonexistent"), NO_TAGS, [], ["chordsketch"], [])

    def test_before_the_tag_the_check_runs_on_the_release_commit(self) -> None:
        plan = release.decide("1.2.0", NO_TAGS, {}, {"chordsketch": False}, {})
        self.assertEqual(release.registry_ref(self.survey(), plan), SHA)

    def test_once_the_tag_is_out_the_tag_is_what_is_checked(self) -> None:
        plan = release.decide("1.2.0", BOTH_TAGS, {}, {"chordsketch": False}, {})
        self.assertEqual(release.registry_ref(self.survey(), plan), "v1.2.0")

    def test_only_the_desktop_tag_missing_still_points_at_the_tag(self) -> None:
        plan = release.decide("1.2.0", {"v1.2.0": SHA, "desktop-v1.2.0": None}, {}, {"chordsketch": False}, {})
        self.assertEqual(release.registry_ref(self.survey(), plan), "v1.2.0")


class AnnotationErrorsTest(unittest.TestCase):
    EXIT = {"annotation_level": "failure", "message": "Process completed with exit code 1."}

    def test_the_jobs_own_errors_replace_the_exit_code_annotation(self) -> None:
        annotations = [
            self.EXIT,
            {"annotation_level": "failure", "message": "npm will not let this workflow publish @chordsketch/vue"},
            {"annotation_level": "warning", "message": "Node.js 20 actions are deprecated"},
        ]
        self.assertEqual(
            release.annotation_errors(annotations),
            ["npm will not let this workflow publish @chordsketch/vue"],
        )

    def test_the_exit_code_annotation_is_kept_when_it_is_all_there_is(self) -> None:
        self.assertEqual(release.annotation_errors([self.EXIT]), ["Process completed with exit code 1."])


class ConfirmReleaseTest(unittest.TestCase):
    def test_matching_answer_confirms(self) -> None:
        with mock.patch("builtins.input", return_value="1.2.0"):
            self.assertTrue(release.confirm_release("1.2.0"))

    def test_non_matching_answer_refuses(self) -> None:
        with mock.patch("builtins.input", return_value="nope"):
            self.assertFalse(release.confirm_release("1.2.0"))

    def test_closed_stdin_refuses_instead_of_raising(self) -> None:
        with mock.patch("builtins.input", side_effect=EOFError):
            self.assertFalse(release.confirm_release("1.2.0"))


class InvocationTest(unittest.TestCase):
    def test_script_runs_as_documented_without_python3_prefix(self) -> None:
        # docs/releasing.md runs `scripts/release.py X.Y.Z`. Without the
        # executable bit, bash answers "Permission denied" and zsh answers
        # "command not found", neither of which points at the file mode.
        script = SCRIPTS_DIR / "release.py"
        self.assertTrue(script.read_text().startswith("#!/usr/bin/env python3\n"))
        self.assertTrue(os.access(script, os.X_OK), f"{script} is not executable")


class ParserTest(unittest.TestCase):
    def test_changelog_heading_must_be_dated(self) -> None:
        changelog = "## [Unreleased]\n\n## [1.2.0] - 2026-09-14\n\n## [1.1.0] - 2026-05-20\n"
        self.assertTrue(release.dated_changelog_heading(changelog, "1.2.0"))
        self.assertFalse(release.dated_changelog_heading("## [1.2.0] - Unreleased\n", "1.2.0"))

    def test_changelog_heading_does_not_match_a_longer_version(self) -> None:
        self.assertFalse(release.dated_changelog_heading("## [1.2.00] - 2026-09-14\n", "1.2.0"))


if __name__ == "__main__":
    unittest.main()
