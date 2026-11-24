#!/usr/bin/env python3
"""Tests that the pull request automation acts only on this repository's branches.

Outside pull requests are not accepted. The conflict automation
(`auto-rebase.yml`, `auto-resolve-conflicts.yml`), the review request
(`claude-review.yml`) and `claude.yml` therefore act only on a pull request
whose head is a branch of this repository.

The `actions/github-script` blocks are taken from the workflow files as they
are and run under Node with a stub `github` client, so the tests check the
code the workflows run, not a copy of it. The `claude.yml` gate is a script
run with a stub `gh` on PATH.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import textwrap
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

REPO_ROOT = Path(__file__).resolve().parent.parent
WORKFLOWS = REPO_ROOT / ".github" / "workflows"
GATE = REPO_ROOT / ".github" / "scripts" / "require-same-repo-pr.sh"
REPOSITORY = "koedame/chordsketch"


def github_script(workflow: str, step_name: str) -> str:
    """Return the `script:` block of the named `actions/github-script` step."""
    lines = (WORKFLOWS / workflow).read_text(encoding="utf-8").splitlines()
    start = next(i for i, line in enumerate(lines) if line.strip() == f"- name: {step_name}")
    header = next(i for i in range(start, len(lines)) if lines[i].strip() == "script: |")
    indent = len(lines[header]) - len(lines[header].lstrip()) + 2
    body: list[str] = []
    for line in lines[header + 1 :]:
        if line.strip() and len(line) - len(line.lstrip()) < indent:
            break
        body.append(line)
    return textwrap.dedent("\n".join(body))


HARNESS = r"""
const fs = require('fs');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const calls = { comments: [], outputs: {} };
// The scripts log their progress; keep stdout for the result.
console.log = (...args) => { process.stderr.write(args.join(' ') + '\n'); };
const github = {
  paginate: async (fn, args) => (await fn(args)).data,
  rest: {
    pulls: {
      list: async () => ({ data: input.prs }),
      get: async ({ pull_number }) => ({ data: input.prs.find((p) => p.number === pull_number) }),
    },
    issues: {
      listComments: async () => ({ data: [] }),
      createComment: async ({ issue_number }) => { calls.comments.push(issue_number); },
    },
  },
};
const [owner, repo] = input.repository.split('/');
const context = { repo: { owner, repo }, payload: input.payload };
const core = { setOutput: (name, value) => { calls.outputs[name] = value; } };
const setTimeout = (resolve) => resolve();
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
new AsyncFunction('github', 'context', 'core', 'setTimeout', input.script)(github, context, core, setTimeout)
  .then(() => { process.stdout.write(JSON.stringify(calls)); });
"""


def pr(number: int, head_repo: str | None) -> dict:
    return {
        "number": number,
        "user": {"login": "someone"},
        "labels": [{"name": "has-conflicts"}],
        "head": {
            "ref": f"branch-{number}",
            "sha": f"{number:040x}",
            "repo": None if head_repo is None else {"full_name": head_repo},
        },
    }


def run_script(script: str, prs: list[dict], payload: dict | None = None) -> dict:
    node = shutil.which("node")
    if node is None:
        raise unittest.SkipTest("node is not installed")
    result = subprocess.run(
        [node, "-e", HARNESS],
        input=json.dumps({"script": script, "prs": prs, "repository": REPOSITORY, "payload": payload or {}}),
        capture_output=True,
        text=True,
        check=True,
    )
    return json.loads(result.stdout)


SAME = pr(1, REPOSITORY)
FORK = pr(2, "someone/chordsketch")
DELETED_FORK = pr(3, None)


class ConflictAutomationTest(unittest.TestCase):
    def test_auto_rebase_lists_conflicted_prs_then_only_this_repositorys_branches_are_rebased(self) -> None:
        calls = run_script(github_script("auto-rebase.yml", "Find conflicted PRs"), [SAME, FORK, DELETED_FORK])
        self.assertEqual([p["number"] for p in json.loads(calls["outputs"]["prs"])], [1])

    def test_auto_resolve_finds_conflicted_prs_then_only_this_repositorys_branches_get_a_request(self) -> None:
        script = github_script("auto-resolve-conflicts.yml", "Request resolution for conflicted PRs")
        calls = run_script(script, [SAME, FORK, DELETED_FORK])
        self.assertEqual(calls["comments"], [1])


class ReviewRequestTest(unittest.TestCase):
    def review(self, head: dict) -> list[int]:
        payload = {"workflow_run": {"pull_requests": [{"number": head["number"]}], "head_sha": head["head"]["sha"]}}
        return run_script(github_script("claude-review.yml", "Request Claude review"), [head], payload)["comments"]

    def test_ci_passes_on_this_repositorys_branch_then_a_review_is_requested(self) -> None:
        self.assertEqual(self.review(SAME), [1])

    def test_ci_passes_on_a_pull_request_from_another_repository_then_no_review_is_requested(self) -> None:
        self.assertEqual(self.review(FORK), [])
        self.assertEqual(self.review(DELETED_FORK), [])


class ClaudeGateTest(unittest.TestCase):
    def gate(self, head_repo: str) -> subprocess.CompletedProcess[str]:
        with TemporaryDirectory() as tmp:
            stub = Path(tmp) / "gh"
            stub.write_text(f"#!/bin/sh\nprintf '%s\\n' '{head_repo}'\n", encoding="utf-8")
            stub.chmod(0o755)
            env = {**os.environ, "PATH": f"{tmp}{os.pathsep}{os.environ['PATH']}", "GITHUB_REPOSITORY": REPOSITORY}
            return subprocess.run(["bash", str(GATE), "7"], env=env, capture_output=True, text=True)

    def test_pull_request_head_is_a_branch_of_this_repository_then_the_gate_passes(self) -> None:
        self.assertEqual(self.gate(REPOSITORY).returncode, 0)

    def test_pull_request_head_is_in_another_repository_then_the_gate_fails(self) -> None:
        result = self.gate("someone/chordsketch")
        self.assertEqual(result.returncode, 1)
        self.assertIn("someone/chordsketch", result.stdout)

    def test_pull_request_head_repository_was_deleted_then_the_gate_fails(self) -> None:
        self.assertEqual(self.gate("").returncode, 1)

    def test_claude_workflow_runs_the_gate_before_the_action(self) -> None:
        text = (WORKFLOWS / "claude.yml").read_text(encoding="utf-8")
        gate = text.index(".github/scripts/require-same-repo-pr.sh")
        self.assertLess(gate, text.index("anthropics/claude-code-action@"))


if __name__ == "__main__":
    unittest.main()
