#!/usr/bin/env python3
"""Tests for `scripts/publish-registries.py`.

The script decides, inside `publish-registries.yml`, what reaches crates.io
and npm. These tests pin the decisions a registry would otherwise be the
first to notice:

  1. `plan` publishes exactly what the registries do not serve yet, checks
     every package of the set, reads the workspace set from the release
     manifest, and refuses a package that has never been published, since
     trusted publishing cannot create one.
  2. The workflow's `set` choices are the framework packages of the publish
     definition, so a package added there cannot be missing from the
     dispatch form.
  3. The napi platform packages are published before their resolver.
  4. A failed OIDC token exchange names the package and what its trusted
     publisher must say.
  5. After publishing, the script waits for npm to serve every package and
     fails naming the ones it never serves.

Stdlib `unittest` only. Nothing here touches the network.
"""

from __future__ import annotations

import importlib.util
import json
import os
import re
import sys
import unittest
from pathlib import Path
from unittest import mock

SCRIPTS_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS_DIR))

_spec = importlib.util.spec_from_file_location("publish_registries", SCRIPTS_DIR / "publish-registries.py")
assert _spec is not None and _spec.loader is not None
publish = importlib.util.module_from_spec(_spec)
sys.modules["publish_registries"] = publish
_spec.loader.exec_module(publish)

REPO_ROOT = publish.REPO_ROOT
WORKFLOW = REPO_ROOT / ".github" / "workflows" / "publish-registries.yml"


def registry(serving: set[tuple[str, str | None]]):
    """A `served(kind, name, version)` that answers from a set of (name, version)."""

    def served(kind: str, name: str, version: str | None) -> bool:
        if version is None:
            return any(entry[0] == name for entry in serving)
        return (name, version) in serving

    return served


class PlanTest(unittest.TestCase):
    def setUp(self) -> None:
        self.crates, self.npm = publish.workspace_packages(REPO_ROOT)
        self.crate_versions = publish.crate_versions(REPO_ROOT)

    def everything_published(self) -> set[tuple[str, str | None]]:
        serving = {(c, self.crate_versions[c]) for c in self.crates}
        serving |= {(p, publish.npm_version(REPO_ROOT, p)) for p in publish.checks.NPM_PACKAGES}
        return serving

    def test_workspace_set_is_the_tag_versioned_crates_and_npm_packages_of_the_manifest(self) -> None:
        self.assertIn("chordsketch", self.crates)
        self.assertIn("@chordsketch/wasm", self.npm)
        self.assertIn("@chordsketch/node-darwin-arm64", self.npm)
        self.assertNotIn("@chordsketch/react", self.npm)

    def test_nothing_is_published_when_every_version_is_served(self) -> None:
        crates, npm, problems = publish.plan(REPO_ROOT, "workspace", "publish", registry(self.everything_published()))
        self.assertEqual((crates, npm, problems), ([], [], []))

    def test_a_check_covers_every_package_of_the_set_even_when_all_are_served(self) -> None:
        crates, npm, problems = publish.plan(REPO_ROOT, "workspace", "check", registry(self.everything_published()))
        self.assertEqual((crates, npm, problems), (self.crates, self.npm, []))

    def test_only_the_unserved_versions_are_pending(self) -> None:
        serving = self.everything_published()
        serving.discard(("chordsketch", self.crate_versions["chordsketch"]))
        serving.add(("chordsketch", "0.0.1"))
        wasm = publish.npm_version(REPO_ROOT, "@chordsketch/wasm")
        serving.discard(("@chordsketch/wasm", wasm))
        serving.add(("@chordsketch/wasm", "0.0.1"))
        crates, npm, problems = publish.plan(REPO_ROOT, "workspace", "publish", registry(serving))
        self.assertEqual(crates, ["chordsketch"])
        self.assertEqual(npm, ["@chordsketch/wasm"])
        self.assertEqual(problems, [])

    def test_a_pending_package_that_was_never_published_is_refused_by_name(self) -> None:
        serving = {entry for entry in self.everything_published() if entry[0] not in ("chordsketch-mcp", "@chordsketch/wasm-export")}
        crates, npm, problems = publish.plan(REPO_ROOT, "workspace", "publish", registry(serving))
        self.assertEqual(crates, ["chordsketch-mcp"])
        self.assertEqual(npm, ["@chordsketch/wasm-export"])
        self.assertEqual(len(problems), 2)
        self.assertIn("chordsketch-mcp has never been published", problems[0])
        self.assertIn("publish-new", problems[0])
        self.assertIn("@chordsketch/wasm-export has never been published", problems[1])

    def test_framework_set_is_that_one_package(self) -> None:
        serving = {e for e in self.everything_published() if e[0] != "@chordsketch/vue"} | {("@chordsketch/vue", "0.0.1")}
        crates, npm, problems = publish.plan(REPO_ROOT, "@chordsketch/vue", "publish", registry(serving))
        self.assertEqual((crates, npm, problems), ([], ["@chordsketch/vue"], []))

    def test_a_workspace_package_is_not_a_set_of_its_own(self) -> None:
        _, _, problems = publish.plan(REPO_ROOT, "@chordsketch/wasm", "check", registry(self.everything_published()))
        self.assertIn("neither `workspace` nor a framework package", problems[0])


class WorkflowTest(unittest.TestCase):
    def workflow_input_options(self, name: str) -> list[str]:
        text = WORKFLOW.read_text()
        block = re.search(rf"^      {name}:\n(?:        .*\n)*?        options:\n((?:          - .*\n)+)", text, re.MULTILINE)
        assert block is not None, f"no options for input {name}"
        return [line.strip()[2:].strip('"') for line in block.group(1).splitlines()]

    def test_set_choices_are_workspace_and_every_framework_package(self) -> None:
        self.assertEqual(
            self.workflow_input_options("set"),
            ["workspace", *publish.framework_packages(REPO_ROOT)],
        )

    def test_mode_choices_are_what_the_script_accepts(self) -> None:
        self.assertEqual(self.workflow_input_options("mode"), ["check", "publish"])

    def test_script_runs_as_invoked_by_path(self) -> None:
        script = SCRIPTS_DIR / "publish-registries.py"
        self.assertTrue(script.read_text().startswith("#!/usr/bin/env python3\n"))
        self.assertTrue(os.access(script, os.X_OK), f"{script} is not executable")


class NpmPublishOrderTest(unittest.TestCase):
    def test_platform_packages_come_before_their_resolver(self) -> None:
        order = publish.npm_publish_order(
            ["@chordsketch/wasm", "@chordsketch/node", "tree-sitter-chordpro", "@chordsketch/node-darwin-arm64"]
        )
        self.assertEqual(
            order,
            ["@chordsketch/node-darwin-arm64", "@chordsketch/node", "@chordsketch/wasm", "tree-sitter-chordpro"],
        )


class NpmExchangeTest(unittest.TestCase):
    def test_a_token_in_the_answer_is_no_problem(self) -> None:
        self.assertEqual(publish.interpret_npm_exchange("@chordsketch/wasm", 201, json.dumps({"token": "npm_x"})), "")

    def test_a_refused_exchange_names_the_package_and_the_expected_publisher(self) -> None:
        problem = publish.interpret_npm_exchange(
            "@chordsketch/vue", 404, json.dumps({"message": "No trusted publisher configured"})
        )
        self.assertIn("@chordsketch/vue", problem)
        self.assertIn("No trusted publisher configured", problem)
        self.assertIn("publish-registries.yml", problem)
        self.assertIn("environment npm", problem)

    def test_an_answer_without_a_token_is_a_problem(self) -> None:
        self.assertIn("no publish token", publish.interpret_npm_exchange("tree-sitter-chordpro", 201, "{}"))

    def test_the_exchange_url_escapes_the_scope_as_npm_does(self) -> None:
        calls = []

        def fetch(url: str, **kwargs: object) -> tuple[int, str]:
            calls.append((url, kwargs))
            return 201, json.dumps({"token": "npm_x"})

        self.assertEqual(publish.npm_exchange_problem("@chordsketch/react-ui", "id-token", fetch), "")
        url, kwargs = calls[0]
        self.assertEqual(url, "https://registry.npmjs.org/-/npm/v1/oidc/token/exchange/package/@chordsketch%2freact-ui")
        self.assertEqual(kwargs["method"], "POST")
        self.assertEqual(kwargs["headers"]["Authorization"], "Bearer id-token")  # type: ignore[index]

    def test_a_job_without_id_token_permission_says_so(self) -> None:
        with mock.patch.dict(os.environ, {}, clear=True):
            with self.assertRaises(SystemExit), mock.patch("builtins.print") as printed:
                publish.github_id_token("npm:registry.npmjs.org")
        self.assertIn("id-token: write", printed.call_args.args[0])


class WaitUntilServedTest(unittest.TestCase):
    """0.6.0 published six napi packages, looked them up straight away, got
    four 404s while npm was still processing them, and reported success."""

    def test_packages_served_after_a_lag_pass(self) -> None:
        lookups: dict[str, int] = {}

        def served(name: str, version: str) -> bool:
            lookups[name] = lookups.get(name, 0) + 1
            return lookups[name] > 2

        self.assertEqual(publish.wait_until_served({"a": "1.0.0", "b": "1.0.0"}, served, attempts=5, interval=0), [])

    def test_a_package_never_served_fails_and_is_named(self) -> None:
        problems = publish.wait_until_served(
            {"@chordsketch/node": "1.0.0", "@chordsketch/node-darwin-arm64": "1.0.0"},
            lambda name, version: name == "@chordsketch/node",
            attempts=3,
            interval=0,
        )
        self.assertEqual(len(problems), 1)
        self.assertIn("@chordsketch/node-darwin-arm64@1.0.0", problems[0])


class ParserTest(unittest.TestCase):
    def test_cargo_version_is_read_from_cargo_dash_dash_version(self) -> None:
        self.assertEqual(publish.parse_cargo_version("cargo 1.98.1 (797e8a9bc 2026-08-05)\n"), (1, 98))
        self.assertIsNone(publish.parse_cargo_version("error: no such command"))


if __name__ == "__main__":
    unittest.main()
