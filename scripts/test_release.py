#!/usr/bin/env python3
"""Tests for `scripts/release.py`.

Covers the decisions the script makes before it publishes anything — the
part a refactor could quietly break without any registry noticing:

  1. `decide` refuses a version some channel already serves when the tag
     is not out, refuses a release with nothing left to do, and otherwise
     lists exactly what is pending.
  2. The crates.io token probe separates a dead token from a live scoped
     one, since both answer 403, and the token lookup reports where the
     token came from so a rejection says which one to replace.
  3. The napi packages are published as one step, by a script that exists.
  4. The release is built from the tagged commit once a tag exists, and
     from `origin/main` before that.
  5. The small parsers the preflight relies on. (The publish checks the
     preflight shares with pull requests are tested in
     `test_publish_checks.py`.)
  6. The script is executable, since the documented invocation is
     `scripts/release.py X.Y.Z` rather than `python3 scripts/release.py`.
  7. The napi publish script waits for the registry to serve what it
     published and fails when a package never appears, run against stub
     `npm` and `gh` commands.

Stdlib `unittest` only. Nothing here touches the network, git or gh.
"""

from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
import tempfile
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


def _errors(detail: str) -> str:
    return json.dumps({"errors": [{"detail": detail}]})


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


class CratesTokenProbeTest(unittest.TestCase):
    def test_legacy_token_owned_by_an_owner_passes_silently(self) -> None:
        self.assertEqual(release.interpret_crates_token_probe(200, "{}"), (True, ""))

    def test_scoped_live_token_passes_with_a_note_about_scopes(self) -> None:
        ok, message = release.interpret_crates_token_probe(
            403, _errors("this token does not have the required permissions to perform this action")
        )
        self.assertTrue(ok)
        self.assertIn("publish-new", message)

    def test_expired_or_revoked_token_fails(self) -> None:
        ok, message = release.interpret_crates_token_probe(403, _errors("authentication failed"))
        self.assertFalse(ok)
        self.assertIn("authentication failed", message)
        self.assertIn("https://crates.io/settings/tokens", message)

    def test_token_of_an_account_that_is_not_an_owner_fails(self) -> None:
        ok, message = release.interpret_crates_token_probe(400, _errors("You are not an owner of this crate"))
        self.assertFalse(ok)
        self.assertIn("does not own", message)

    def test_unexpected_answer_fails_with_the_raw_body(self) -> None:
        ok, message = release.interpret_crates_token_probe(503, "Service Unavailable")
        self.assertFalse(ok)
        self.assertIn("HTTP 503: Service Unavailable", message)


class CratesTokenSourceTest(unittest.TestCase):
    def setUp(self) -> None:
        self.home = tempfile.TemporaryDirectory()
        self.addCleanup(self.home.cleanup)
        patcher = mock.patch.dict(os.environ, {"CARGO_HOME": self.home.name})
        patcher.start()
        self.addCleanup(patcher.stop)
        os.environ.pop("CARGO_REGISTRY_TOKEN", None)

    def write_credentials(self, token: str) -> Path:
        path = Path(self.home.name) / "credentials.toml"
        path.write_text(f'[registry]\ntoken = "{token}"\n')
        return path

    def test_environment_variable_wins_over_the_credentials_file_and_is_named_as_the_source(self) -> None:
        self.write_credentials("from-file")
        os.environ["CARGO_REGISTRY_TOKEN"] = "from-env"
        token, source = release.crates_token()
        self.assertEqual(token, "from-env")
        self.assertIn("CARGO_REGISTRY_TOKEN", source)

    def test_credentials_file_is_named_by_its_path(self) -> None:
        path = self.write_credentials("from-file")
        self.assertEqual(release.crates_token(), ("from-file", str(path)))

    def test_no_token_anywhere_returns_none(self) -> None:
        self.assertIsNone(release.crates_token())


class ManifestCoverageTest(unittest.TestCase):
    def test_napi_publish_script_exists(self) -> None:
        self.assertTrue((release.REPO_ROOT / release.NAPI_PUBLISH_SCRIPT).is_file())


class NpmPublishOrderTest(unittest.TestCase):
    def test_napi_platform_packages_publish_as_one_step_after_tree_sitter(self) -> None:
        order = release.npm_publish_order(
            ("@chordsketch/wasm-export", "@chordsketch/node-darwin-arm64", "tree-sitter-chordpro", "@chordsketch/wasm")
        )
        self.assertEqual(
            order,
            ["@chordsketch/wasm", "tree-sitter-chordpro", "@chordsketch/node", "@chordsketch/wasm-export"],
        )

    def test_published_packages_are_left_out(self) -> None:
        self.assertEqual(release.npm_publish_order(("@chordsketch/wasm-export",)), ["@chordsketch/wasm-export"])


class HasDryRunsToSkipTest(unittest.TestCase):
    def test_pending_crate_is_worth_a_skip_note(self) -> None:
        plan = release.decide("1.2.0", BOTH_TAGS, {"docker-hub": True}, {"chordsketch": False}, {})
        self.assertTrue(release.has_dry_runs_to_skip(plan))

    def test_pending_npm_package_is_worth_a_skip_note(self) -> None:
        plan = release.decide("1.2.0", BOTH_TAGS, {"docker-hub": True}, {}, {"@chordsketch/wasm": False})
        self.assertTrue(release.has_dry_runs_to_skip(plan))

    def test_only_a_pending_ci_channel_is_not_worth_a_skip_note(self) -> None:
        plan = release.decide("1.2.0", BOTH_TAGS, {"docker-hub": False}, {"chordsketch": True}, {"@chordsketch/wasm": True})
        self.assertFalse(release.has_dry_runs_to_skip(plan))


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

    def test_cargo_version_is_read_from_cargo_dash_dash_version(self) -> None:
        self.assertEqual(release.parse_cargo_version("cargo 1.98.1 (797e8a9bc 2026-08-05)\n"), (1, 98))
        self.assertIsNone(release.parse_cargo_version("error: no such command"))


NAPI_PACKAGES = (
    "@chordsketch/node",
    "@chordsketch/node-linux-x64-gnu",
    "@chordsketch/node-linux-arm64-gnu",
    "@chordsketch/node-darwin-x64",
    "@chordsketch/node-darwin-arm64",
    "@chordsketch/node-win32-x64-msvc",
)

# `gh release download` drops every tarball the script asks for into the cwd.
STUB_GH = """#!/usr/bin/env bash
for triple in linux-x64-gnu linux-arm64-gnu darwin-x64 darwin-arm64 win32-x64-msvc; do
  touch "chordsketch-node-$triple-$STUB_VERSION.tgz"
done
touch "chordsketch-node-$STUB_VERSION.tgz"
"""

# The registry is a directory: `publish` records a package, and `view` serves
# it only after `$STUB_LAG` lookups of that package, or never when the package
# is listed in `$STUB_NEVER_SERVED`.
STUB_NPM = """#!/usr/bin/env bash
set -eu
case "$1" in
  whoami) echo unchidev ;;
  publish)
    name=$(basename "${!#}" .tgz); name=${name%-$STUB_VERSION}
    touch "$STUB_REGISTRY/published-${name#chordsketch-}" ;;
  view)
    spec=${2%@*}; key=${spec#@chordsketch/}
    [ -e "$STUB_REGISTRY/published-$key" ] || { echo "npm error 404" >&2; exit 1; }
    case " ${STUB_NEVER_SERVED:-} " in *" $spec "*) echo "npm error 404" >&2; exit 1 ;; esac
    count=$(( $(cat "$STUB_REGISTRY/views-$key" 2>/dev/null || echo 0) + 1 ))
    echo "$count" > "$STUB_REGISTRY/views-$key"
    [ "$count" -gt "$STUB_LAG" ] || { echo "npm error 404" >&2; exit 1; }
    echo "$STUB_VERSION" ;;
esac
"""


class NapiPublishVerificationTest(unittest.TestCase):
    """`crates/napi/scripts/local-publish.sh` against stub `npm` and `gh`.

    0.6.0 published all six packages, then the verification looked them up
    straight away, got four 404s while npm was still processing them, printed
    blanks and ended with "Done." either way.
    """

    def run_script(self, lag: int, never_served: str = "") -> subprocess.CompletedProcess[str]:
        with tempfile.TemporaryDirectory() as tmp:
            bin_dir = Path(tmp) / "bin"
            registry = Path(tmp) / "registry"
            bin_dir.mkdir()
            registry.mkdir()
            for name, body in (("gh", STUB_GH), ("npm", STUB_NPM)):
                stub = bin_dir / name
                stub.write_text(body)
                stub.chmod(0o755)
            env = {
                **os.environ,
                "PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}",
                "STUB_VERSION": "1.2.0",
                "STUB_REGISTRY": str(registry),
                "STUB_LAG": str(lag),
                "STUB_NEVER_SERVED": never_served,
                "VERIFY_ATTEMPTS": "3",
                "VERIFY_INTERVAL": "0",
            }
            return subprocess.run(
                ["bash", str(release.REPO_ROOT / release.NAPI_PUBLISH_SCRIPT), "v1.2.0"],
                env=env, capture_output=True, text=True, timeout=60,
            )

    def test_registry_that_serves_the_packages_after_a_lag_passes(self) -> None:
        result = self.run_script(lag=2)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("waiting for the registry to serve", result.stdout)
        for package in NAPI_PACKAGES:
            self.assertRegex(result.stdout, rf"{package}\s+1\.2\.0")
        self.assertTrue(result.stdout.rstrip().endswith("Done."))

    def test_package_the_registry_never_serves_fails_and_is_named(self) -> None:
        result = self.run_script(lag=0, never_served="@chordsketch/node-darwin-arm64")
        self.assertEqual(result.returncode, 1)
        self.assertIn("still does not serve 1.2.0 of: @chordsketch/node-darwin-arm64", result.stderr)
        self.assertNotIn("Done.", result.stdout)


if __name__ == "__main__":
    unittest.main()
