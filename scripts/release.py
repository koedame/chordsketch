#!/usr/bin/env python3
"""Run a workspace release end to end, refusing to start one that cannot finish.

    scripts/release.py 0.7.0           # preflight, confirm, then release
    scripts/release.py 0.7.0 --check   # preflight only; publishes nothing

Run it from an up-to-date checkout of `main`, after the `Release vX.Y.Z`
commit (docs/releasing.md steps 1-3) is on `main`. It replaces the hand-run
steps 4-6 and 8. It reads the release from a temporary worktree of the
release commit — the tagged commit once the tags exist, `origin/main`
before — so the local checkout's branch and uncommitted changes play no
part, and a release tagged before this script existed can still be
finished with it.

The failure it exists to prevent is a half-published release. A release
touches ~30 registries; most are published by CI from the tag push, and
crates.io and npm by `.github/workflows/publish-registries.yml`, which this
script dispatches once the others have converged (ADR-0069). Every one of
them can refuse the release for a reason that was knowable beforehand — an
expired token, a missing trusted publisher, a build that does not package —
and once the tag is out there is no undoing the channels that already
accepted it.
So the script asks every question it can answer without publishing first,
and only if every answer is yes does it push the tag (ADR-0068):

  * the release commit is at the requested version, with a dated CHANGELOG
    heading and consistent manifests;
  * `ci.yml` and `publishable.yml` passed on that commit;
  * no registry has this version yet — or, when the tags are already out,
    what is still missing, so a re-run resumes instead of re-publishing;
  * every CI publish credential is still accepted by its service
    (`.github/workflows/release-credentials.yml`);
  * `publish-registries.yml` in `check` mode passes for the release commit:
    every pending crate and npm package passes the checks every pull request
    runs (`scripts/_publish_checks.py`), none of them is new to its
    registry, and crates.io and npm each mint a token for that workflow.

Then, in order: push `vX.Y.Z` and `desktop-vX.Y.Z`; wait for the tag runs;
refuse to publish crates.io and npm unless every CI-published channel has
converged on the version; dispatch `publish-registries.yml` in `publish`
mode and wait for it; dispatch `release-verify.yml` and wait for it.

It needs only `git`, `gh` with push access and Python: nothing is built or
published on this machine.

Re-running with the same version is always safe. Every step checks the
registry before acting, so an interrupted release resumes where it
stopped, and a finished one is refused.

Stdlib only.
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
import tempfile
import time
import tomllib
import urllib.error
import urllib.parse
import urllib.request
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator

SCRIPTS_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPTS_DIR.parent
sys.path.insert(0, str(SCRIPTS_DIR))

import _publish_checks as checks  # noqa: E402
from _release_channels import Channel, load_channels  # noqa: E402

REPO = "koedame/chordsketch"
USER_AGENT = "chordsketch-release (+https://github.com/koedame/chordsketch)"
HTTP_TIMEOUT = 15
POLL_SECONDS = 30

# Channels published by PUBLISH_WORKFLOW, which this script dispatches after
# every other `expected_version = "tag"` channel — published by CI from the
# tag push — has converged.
REGISTRY_KINDS = frozenset({"crates-io", "npm"})
PUBLISH_WORKFLOW = "publish-registries.yml"
# Workflows that must have passed on the release commit before it is tagged.
REQUIRED_WORKFLOWS = ("ci.yml", "publishable.yml")


def tags_for(version: str) -> tuple[str, str]:
    return f"v{version}", f"desktop-v{version}"


def choose_release_commit(remote_tags: dict[str, str | None], main_sha: str) -> tuple[str, str]:
    """Return `(commit, refusal)`: the commit the release is built from.

    Once either tag exists, that tag's commit is the release — the CI
    channels were built from it, so crates.io and npm must be too. Before
    that, it is the tip of `origin/main`. Tags on two different commits
    are refused: there is no single release to finish.
    """
    tagged = {sha for sha in remote_tags.values() if sha}
    if len(tagged) > 1:
        described = ", ".join(f"{tag} -> {sha[:12]}" for tag, sha in remote_tags.items() if sha)
        return "", f"the release tags point at different commits ({described}); fix the tags before releasing"
    if tagged:
        return tagged.pop(), ""
    return main_sha, ""


# ---------------------------------------------------------------- decisions


@dataclass(frozen=True)
class Plan:
    """What a release of this version still needs, or why it must not run.

    `refusal` is set when the release must not proceed at all; the pending
    lists are then irrelevant.
    """

    refusal: str = ""
    tags_to_push: tuple[str, ...] = ()
    pending_ci: tuple[str, ...] = ()
    pending_crates: tuple[str, ...] = ()
    pending_npm: tuple[str, ...] = ()


def decide(
    version: str,
    remote_tags: dict[str, str | None],
    ci_published: dict[str, bool],
    crates_published: dict[str, bool],
    npm_published: dict[str, bool],
) -> Plan:
    """Turn the observed state of every channel into a plan.

    `remote_tags` maps each release tag to the commit it points at on
    origin (None when absent). The `*_published` maps say, per channel,
    whether the registry already serves this version.
    """
    missing_tags = tuple(tag for tag in tags_for(version) if remote_tags.get(tag) is None)
    pending_ci = tuple(cid for cid, done in ci_published.items() if not done)
    pending_crates = tuple(name for name, done in crates_published.items() if not done)
    pending_npm = tuple(name for name, done in npm_published.items() if not done)

    if len(missing_tags) == 2:
        already = sorted(
            [cid for cid, done in ci_published.items() if done]
            + [name for name, done in crates_published.items() if done]
            + [name for name, done in npm_published.items() if done]
        )
        if already:
            return Plan(
                refusal=(
                    f"v{version} is not tagged, but these channels already serve "
                    f"{version}: {', '.join(already)}. A version cannot be released "
                    f"twice; bump to a new version."
                )
            )
    elif not (missing_tags or pending_ci or pending_crates or pending_npm):
        return Plan(refusal=f"v{version} is already fully released; there is nothing to do.")

    return Plan(
        tags_to_push=missing_tags,
        pending_ci=pending_ci,
        pending_crates=pending_crates,
        pending_npm=pending_npm,
    )


def dated_changelog_heading(changelog: str, version: str) -> bool:
    pattern = rf"^## \[{re.escape(version)}\] - \d{{4}}-\d{{2}}-\d{{2}}$"
    return re.search(pattern, changelog, flags=re.MULTILINE) is not None


# ---------------------------------------------------------------- process / HTTP helpers


class ReleaseError(Exception):
    """Aborts the release with a message for the maintainer."""


def run(cmd: list[str], *, check: bool = True, capture: bool = True, cwd: Path = REPO_ROOT,
        env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        cmd, cwd=cwd, text=True, env=env,
        stdout=subprocess.PIPE if capture else None,
        stderr=subprocess.PIPE if capture else None,
    )
    if check and result.returncode != 0:
        detail = (result.stderr or result.stdout or "").strip() if capture else ""
        raise ReleaseError(f"`{' '.join(cmd)}` exited {result.returncode}" + (f": {detail}" if detail else ""))
    return result


def gh_api(path: str) -> object:
    return json.loads(run(["gh", "api", path]).stdout)


def http_status(url: str, headers: dict[str, str] | None = None) -> tuple[int, str]:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, **(headers or {})})
    try:
        with urllib.request.urlopen(request, timeout=HTTP_TIMEOUT) as response:
            return response.status, response.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode("utf-8", "replace")
    except (urllib.error.URLError, TimeoutError) as exc:
        raise ReleaseError(f"could not reach {urllib.parse.urlsplit(url).netloc}: {exc}") from exc


def crate_version_exists(crate: str, version: str) -> bool:
    status, _ = http_status(f"https://crates.io/api/v1/crates/{crate}/{version}")
    if status not in (200, 404):
        raise ReleaseError(f"crates.io answered HTTP {status} for {crate} {version}")
    return status == 200


def npm_version_exists(package: str, version: str) -> bool:
    encoded = urllib.parse.quote(package, safe="@")
    status, _ = http_status(f"https://registry.npmjs.org/{encoded}/{version}")
    if status not in (200, 404):
        raise ReleaseError(f"the npm registry answered HTTP {status} for {package}@{version}")
    return status == 200


def load_channel_checker():
    """`check-release-channels.py` is hyphenated, so import it by path."""
    import importlib.util

    spec = importlib.util.spec_from_file_location(
        "check_release_channels", SCRIPTS_DIR / "check-release-channels.py"
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules["check_release_channels"] = module
    spec.loader.exec_module(module)
    return module


def section(title: str) -> None:
    print(f"\n==> {title}", flush=True)


# ---------------------------------------------------------------- GitHub Actions


def dispatch_and_wait(workflow: str, inputs: dict[str, str], login: str) -> dict:
    """Dispatch a workflow on main, wait for the run to finish, return it."""
    return wait_for_run(dispatch(workflow, inputs, login))


def dispatch(workflow: str, inputs: dict[str, str], login: str) -> int:
    """Dispatch a workflow on main and return the id of the run it started."""
    started = datetime.now(timezone.utc)
    cmd = ["gh", "workflow", "run", workflow, "-R", REPO, "--ref", "main"]
    for key, value in inputs.items():
        cmd += ["-f", f"{key}={value}"]
    run(cmd)

    run_id = None
    for _ in range(40):
        runs = gh_api(f"repos/{REPO}/actions/workflows/{workflow}/runs?event=workflow_dispatch&per_page=10")
        for candidate in runs["workflow_runs"]:  # type: ignore[index]
            created = datetime.fromisoformat(candidate["created_at"].replace("Z", "+00:00"))
            if candidate["actor"]["login"] == login and (created - started).total_seconds() > -10:
                run_id = candidate["id"]
                break
        if run_id:
            break
        time.sleep(3)
    if run_id is None:
        raise ReleaseError(f"dispatched {workflow} but could not find its run")

    print(f"    https://github.com/{REPO}/actions/runs/{run_id}", flush=True)
    return run_id


def wait_for_run(run_id: int) -> dict:
    while True:
        details = gh_api(f"repos/{REPO}/actions/runs/{run_id}")
        if details["status"] == "completed":  # type: ignore[index]
            return details  # type: ignore[return-value]
        time.sleep(POLL_SECONDS)


def failed_jobs(run_id: int) -> list[str]:
    jobs = gh_api(f"repos/{REPO}/actions/runs/{run_id}/jobs?per_page=100")
    return [
        job["name"]
        for job in jobs["jobs"]  # type: ignore[index]
        if job["conclusion"] not in ("success", "skipped")
    ]


def failure_reasons(run: dict) -> list[str]:
    """One line per failed job, with the errors it annotated.

    `publish-registries.yml` and `release-credentials.yml` report each
    problem as a `::error::` annotation, so the reason reaches the
    maintainer's terminal instead of only the run page.
    """
    jobs = gh_api(f"repos/{REPO}/actions/runs/{run['id']}/jobs?per_page=100")
    reasons = []
    for job in jobs["jobs"]:  # type: ignore[index]
        if job["conclusion"] in ("success", "skipped"):
            continue
        annotations = gh_api(f"repos/{REPO}/check-runs/{job['id']}/annotations?per_page=50")
        errors = annotation_errors(annotations)  # type: ignore[arg-type]
        reasons.append(f"{job['name']}: " + ("; ".join(errors) if errors else f"{job['conclusion']} — {run['html_url']}"))
    return reasons


def annotation_errors(annotations: list[dict]) -> list[str]:
    """The messages of the failure annotations a job wrote.

    GitHub adds its own "Process completed with exit code 1" annotation to
    every failed step; it repeats the failure without a reason, so it is
    dropped when the job said anything else.
    """
    errors = [a["message"] for a in annotations if a.get("annotation_level") == "failure"]
    meaningful = [e for e in errors if not re.fullmatch(r"Process completed with exit code \d+\.?", e)]
    return meaningful or errors


def tag_runs(tag: str) -> list[dict]:
    runs = gh_api(f"repos/{REPO}/actions/runs?event=push&branch={urllib.parse.quote(tag)}&per_page=50")
    return list(runs["workflow_runs"])  # type: ignore[index]


# ---------------------------------------------------------------- survey


@dataclass
class Survey:
    version: str
    commit: str
    tree: Path
    remote_tags: dict[str, str | None]
    ci_channels: list[Channel]
    crates: list[str]
    npm: list[str]
    ci_published: dict[str, bool] = field(default_factory=dict)
    ci_detail: dict[str, str] = field(default_factory=dict)
    crates_published: dict[str, bool] = field(default_factory=dict)
    npm_published: dict[str, bool] = field(default_factory=dict)


def read_remote_tags(version: str) -> dict[str, str | None]:
    remote_tags: dict[str, str | None] = {}
    for tag in tags_for(version):
        out = run(["git", "ls-remote", "origin", f"refs/tags/{tag}", f"refs/tags/{tag}^{{}}"]).stdout
        refs = dict(line.split("\t")[::-1] for line in out.splitlines() if line)
        remote_tags[tag] = refs.get(f"refs/tags/{tag}^{{}}") or refs.get(f"refs/tags/{tag}")
    return remote_tags


@contextmanager
def release_tree(commit: str) -> Iterator[Path]:
    """A detached worktree of the release commit, removed on exit."""
    run(["git", "fetch", "--quiet", "origin", commit])
    tree = Path(tempfile.mkdtemp(prefix="chordsketch-release-")) / "tree"
    run(["git", "worktree", "add", "--quiet", "--detach", str(tree), commit])
    try:
        yield tree
    finally:
        run(["git", "worktree", "remove", "--force", str(tree)], check=False)
        shutil.rmtree(tree.parent, ignore_errors=True)


def survey(version: str, commit: str, tree: Path, remote_tags: dict[str, str | None]) -> Survey:
    # The release's own manifest decides which channels it publishes to.
    tag_channels = [c for c in load_channels(tree / "ci" / "release-channels.toml") if c.expected_version == "tag"]
    state = Survey(
        version=version,
        commit=commit,
        tree=tree,
        remote_tags=remote_tags,
        ci_channels=[c for c in tag_channels if c.kind not in REGISTRY_KINDS],
        crates=[c.package for c in tag_channels if c.kind == "crates-io"],
        npm=[c.package for c in tag_channels if c.kind == "npm"],
    )
    refresh_ci_channels(state)
    for crate in state.crates:
        state.crates_published[crate] = crate_version_exists(crate, version)
    for package in state.npm:
        state.npm_published[package] = npm_version_exists(package, version)
    return state


def refresh_ci_channels(state: Survey) -> None:
    checker = load_channel_checker()
    tag = tags_for(state.version)[0]
    for channel in state.ci_channels:
        result = checker.verify_channel(channel, tag, False)
        state.ci_published[channel.id] = bool(result.ok)
        state.ci_detail[channel.id] = f"{result.status} (observed {result.observed})"


# ---------------------------------------------------------------- preflight


@dataclass
class Findings:
    problems: list[str] = field(default_factory=list)

    def check(self, ok: bool, problem: str) -> bool:
        if not ok:
            self.problems.append(problem)
        return ok


def registry_ref(state: Survey, plan: Plan) -> str:
    """What `publish-registries.yml` checks out: the tag once it is pushed."""
    tag = tags_for(state.version)[0]
    return state.commit if tag in plan.tags_to_push else tag


def preflight(state: Survey, plan: Plan, login: str) -> Findings:
    findings = Findings()
    version = state.version
    fresh = len(plan.tags_to_push) == 2

    section(f"Release commit {state.commit[:12]}")
    tree = state.tree
    cli_version = tomllib.loads((tree / "crates/cli/Cargo.toml").read_text())["package"]["version"]
    findings.check(cli_version == version, f"the release commit's workspace is at {cli_version}, not {version}")
    consistency = run([sys.executable, "scripts/check-version-consistency.py"], cwd=tree, check=False)
    findings.check(consistency.returncode == 0, "scripts/check-version-consistency.py fails:\n" + consistency.stdout + consistency.stderr)
    changelog = (tree / "CHANGELOG.md").read_text()
    findings.check(dated_changelog_heading(changelog, version), f"CHANGELOG.md has no dated `## [{version}] - YYYY-MM-DD` heading")

    if fresh:
        section(f"CI on {state.commit[:12]}")
        for workflow in REQUIRED_WORKFLOWS:
            runs = gh_api(f"repos/{REPO}/actions/workflows/{workflow}/runs?head_sha={state.commit}&event=push&per_page=5")
            latest = next(iter(runs["workflow_runs"]), None)  # type: ignore[index]
            if latest is None:
                findings.problems.append(f"{workflow} has not run on the release commit")
            else:
                findings.check(
                    latest["status"] == "completed" and latest["conclusion"] == "success",
                    f"{workflow} on the release commit is {latest['status']}/{latest['conclusion']}: {latest['html_url']}",
                )

    section("GitHub")
    push = run(["gh", "api", f"repos/{REPO}", "--jq", ".permissions.push"], check=False).stdout.strip()
    findings.check(push == "true", f"the gh login `{login}` cannot push to {REPO}")

    # Both are dispatched before anything waits, so they run side by side.
    runs: dict[str, int] = {}
    if fresh or plan.pending_ci:
        section("CI publish credentials (release-credentials.yml)")
        try:
            runs["CI credential check"] = dispatch("release-credentials.yml", {}, login)
        except ReleaseError as exc:
            findings.problems.append(f"could not run the CI credential check: {exc}")
    if plan.pending_crates or plan.pending_npm:
        section(f"crates.io and npm ({PUBLISH_WORKFLOW}, mode: check)")
        try:
            runs["crates.io and npm check"] = dispatch(
                PUBLISH_WORKFLOW, {"ref": registry_ref(state, plan), "mode": "check"}, login
            )
        except ReleaseError as exc:
            findings.problems.append(f"could not run the crates.io and npm check: {exc}")

    if not fresh and plan.pending_ci:
        preflight_stalled_ci(state, plan, findings)
    if not fresh:
        preflight_release_assets(state, plan, findings)

    for label, run_id in runs.items():
        section(f"Waiting for the {label}")
        result = wait_for_run(run_id)
        if result["conclusion"] != "success":
            findings.problems.extend(f"{label} failed: {reason}" for reason in failure_reasons(result))

    return findings


def preflight_stalled_ci(state: Survey, plan: Plan, findings: Findings) -> None:
    """With the tag out, a CI channel that is behind and has nothing running
    will still be behind after the wait, so say so now rather than after it."""
    section("Tag runs")
    runs = [r for tag in tags_for(state.version) for r in tag_runs(tag)]
    if any(r["status"] != "completed" for r in runs):
        print("    a tag run is still in progress; the channels are re-checked after it finishes", flush=True)
        return
    for cid in plan.pending_ci:
        findings.problems.append(
            f"{cid} does not serve {state.version} ({state.ci_detail[cid]}) and no tag run is in progress; "
            f"re-run that channel first (docs/releasing.md step 8)"
        )


def preflight_release_assets(state: Survey, plan: Plan, findings: Findings) -> None:
    """With the tag already out, the napi tarballs must be on the Release.

    What is inside them is checked by the `check` run, which downloads them.
    """
    if not any(checks.is_napi(p) for p in plan.pending_npm):
        return
    tag = tags_for(state.version)[0]
    missing = missing_napi_assets(state, tag)
    if missing is not None:
        findings.check(not missing, f"the {tag} Release lacks napi tarballs: {', '.join(missing)}")


def missing_napi_assets(state: Survey, tag: str) -> list[str] | None:
    """Missing tarball names, or None when the Release does not exist yet."""
    view = run(["gh", "release", "view", tag, "-R", REPO, "--json", "assets"], check=False)
    if view.returncode != 0:
        return None
    assets = {asset["name"] for asset in json.loads(view.stdout)["assets"]}
    wanted = [checks.npm_tarball_name(p, state.version) for p in state.npm if checks.is_napi(p)]
    return [name for name in wanted if name not in assets]


# ---------------------------------------------------------------- release steps


def push_tags(state: Survey, tags: tuple[str, ...]) -> None:
    section(f"Pushing {', '.join(tags)}")
    run(["git", "push", "origin", *[f"{state.commit}:refs/tags/{tag}" for tag in tags]], capture=False)


def wait_for_tag_runs(state: Survey) -> None:
    section("Waiting for the tag runs")
    tag, desktop_tag = tags_for(state.version)
    expected = {(tag, ".github/workflows/release.yml"), (desktop_tag, ".github/workflows/desktop-release.yml")}
    deadline = time.monotonic() + 600
    reported: dict[int, str] = {}
    while True:
        runs = [(t, r) for t in (tag, desktop_tag) for r in tag_runs(t)]
        present = {(t, r["path"]) for t, r in runs}
        for _, r in runs:
            state_word = r["status"] if r["status"] != "completed" else r["conclusion"]
            if reported.get(r["id"]) != state_word:
                reported[r["id"]] = state_word
                print(f"    {r['name']}: {state_word}  {r['html_url']}", flush=True)
        if not expected <= present:
            if time.monotonic() > deadline:
                raise ReleaseError(f"no Release / Desktop Release run appeared for {tag} within 10 minutes")
        elif all(r["status"] == "completed" for _, r in runs):
            return
        time.sleep(POLL_SECONDS)


def gate_registry_publish(state: Survey, plan: Plan) -> None:
    """Refuse crates.io and npm unless every CI-published channel converged.

    Their versions are permanent, so they go last: a release abandoned
    because a CI channel cannot be fixed leaves nothing on them.
    """
    section("Checking that CI published every channel")
    tag, desktop_tag = tags_for(state.version)
    refresh_ci_channels(state)
    problems = [
        f"{cid}: {state.ci_detail[cid]}" for cid, done in state.ci_published.items() if not done
    ]

    release = run(["gh", "release", "view", tag, "-R", REPO, "--json", "isDraft"], check=False)
    if release.returncode != 0 or json.loads(release.stdout)["isDraft"]:
        problems.append(f"the GitHub Release {tag} is missing or still a draft")
    desktop = [r for r in tag_runs(desktop_tag) if r["path"] == ".github/workflows/desktop-release.yml"]
    if not desktop or desktop[0]["conclusion"] != "success":
        problems.append(f"Desktop Release for {desktop_tag} did not succeed")
    if any(checks.is_napi(p) for p in plan.pending_npm):
        missing = missing_napi_assets(state, tag)
        if missing is None or missing:
            problems.append(f"the {tag} Release lacks napi tarballs: {', '.join(missing or ['all of them'])}")

    for r in tag_runs(tag) + tag_runs(desktop_tag):
        if r["conclusion"] not in ("success", "skipped"):
            jobs = ", ".join(failed_jobs(r["id"]))
            print(f"    note: {r['name']} ended {r['conclusion']} ({jobs}) {r['html_url']}", flush=True)

    if problems:
        raise ReleaseError(
            "not publishing to crates.io or npm while CI-published channels are behind:\n  - "
            + "\n  - ".join(problems)
            + "\nRe-run the failed channel (docs/releasing.md step 8), then re-run this script; it resumes here."
        )
    print("    every CI-published channel serves the version", flush=True)


def publish_registries(state: Survey, login: str) -> None:
    section(f"Publishing to crates.io and npm ({PUBLISH_WORKFLOW}, mode: publish)")
    tag = tags_for(state.version)[0]
    result = dispatch_and_wait(PUBLISH_WORKFLOW, {"ref": tag, "mode": "publish"}, login)
    if result["conclusion"] != "success":
        raise ReleaseError(
            f"{PUBLISH_WORKFLOW} ended {result['conclusion']}: {result['html_url']}\n  - "
            + "\n  - ".join(failure_reasons(result))
        )


def verify_release(state: Survey, login: str) -> None:
    section("Dispatching release-verify.yml")
    tag = tags_for(state.version)[0]
    result = dispatch_and_wait("release-verify.yml", {"tag": tag}, login)
    if result["conclusion"] != "success":
        raise ReleaseError(
            f"release-verify.yml ended {result['conclusion']}: {result['html_url']}\n"
            f"A registry can lag a minute after publishing; re-run `gh workflow run release-verify.yml -f tag={tag}` "
            f"before treating a red row as a failure."
        )


# ---------------------------------------------------------------- main


def confirm_release(version: str) -> bool:
    """Ask the operator to type the version back to confirm the release.

    A closed stdin (no TTY, no `--yes`, e.g. an unattended invocation) raises
    `EOFError` from `input()`; treat that the same as a non-matching answer
    so the caller aborts cleanly instead of letting the exception propagate
    as a raw traceback.
    """
    try:
        answer = input(f"\nType {version} to start the release: ")
    except EOFError:
        answer = ""
    return answer.strip() == version


def print_plan(state: Survey, plan: Plan) -> None:
    section("Plan")
    if plan.tags_to_push:
        print(f"    push tags: {', '.join(plan.tags_to_push)} at {state.commit[:12]}")
        print("    wait for the tag runs (the CI-published channels)")
    if plan.pending_ci:
        print(f"    CI channels not yet on {state.version}: {', '.join(plan.pending_ci)}")
    print(f"    then {PUBLISH_WORKFLOW} publishes, once every CI channel serves {state.version}:")
    print(f"      crates.io: {', '.join(plan.pending_crates) or 'nothing pending'}")
    print(f"      npm: {', '.join(plan.pending_npm) or 'nothing pending'}")
    print("    dispatch release-verify.yml")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    parser.add_argument("version", help="the version being released, without the leading v (e.g. 0.7.0)")
    parser.add_argument("--check", action="store_true", help="run the preflight and stop; publishes nothing")
    parser.add_argument("--yes", action="store_true", help="do not ask for confirmation after the preflight")
    args = parser.parse_args()

    if not re.fullmatch(r"\d+\.\d+\.\d+", args.version):
        print(f"error: {args.version!r} is not X.Y.Z", file=sys.stderr)
        return 2
    for tool in ("git", "gh"):
        if shutil.which(tool) is None:
            print(f"error: {tool} is not on PATH", file=sys.stderr)
            return 1

    try:
        login = run(["gh", "api", "user", "--jq", ".login"]).stdout.strip()
        run(["git", "fetch", "--quiet", "origin", "main"])
        main_sha = run(["git", "rev-parse", "origin/main"]).stdout.strip()
        remote_tags = read_remote_tags(args.version)
        commit, refusal = choose_release_commit(remote_tags, main_sha)
        if refusal:
            print(f"\nerror: {refusal}", file=sys.stderr)
            return 1

        with release_tree(commit) as tree:
            return release(args, login, commit, tree, remote_tags)
    except ReleaseError as exc:
        print(f"\nerror: {exc}", file=sys.stderr)
        print(f"Re-running `scripts/release.py {args.version}` resumes from what is still missing.", file=sys.stderr)
        return 1


def release(args: argparse.Namespace, login: str, commit: str, tree: Path, remote_tags: dict[str, str | None]) -> int:
    section(f"Surveying every channel for {args.version}")
    state = survey(args.version, commit, tree, remote_tags)
    plan = decide(args.version, state.remote_tags, state.ci_published, state.crates_published, state.npm_published)
    if plan.refusal:
        print(f"\nerror: {plan.refusal}", file=sys.stderr)
        return 1
    print_plan(state, plan)

    findings = preflight(state, plan, login)
    if findings.problems:
        print("\nPreflight failed. Nothing was published. Fix these and re-run:", file=sys.stderr)
        for problem in findings.problems:
            print(f"  - {problem}", file=sys.stderr)
        return 1
    print("\nPreflight passed.")
    if args.check:
        return 0

    if not args.yes and not confirm_release(args.version):
        print("Aborted. Nothing was published.")
        return 1

    if plan.tags_to_push:
        push_tags(state, plan.tags_to_push)
    wait_for_tag_runs(state)
    gate_registry_publish(state, plan)
    if plan.pending_crates or plan.pending_npm:
        publish_registries(state, login)
    verify_release(state, login)

    print(f"\nv{args.version} is released. winget and MacPorts are still manual (docs/releasing.md, Post-Release).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
