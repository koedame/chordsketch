#!/usr/bin/env python3
"""Run a workspace release end to end, refusing to start one that cannot finish.

    scripts/release.py 0.7.0           # preflight, confirm, then release
    scripts/release.py 0.7.0 --check   # preflight only; changes nothing

Run it from a clean checkout of the release commit on the maintainer's
machine, after the `Release vX.Y.Z` commit (docs/releasing.md steps 1-3)
is on `main`. It replaces the hand-run steps 4-8.

The failure it exists to prevent is a half-published release. A release
touches ~30 registries; some are published by CI after the tag push, and
crates.io and npm are published from this machine (ADR-0008). Every one of
them can refuse the release for a reason that was knowable beforehand — an
expired token, a missing login, a build that does not package — and once
the tag is out there is no undoing the channels that already accepted it.
So the script asks every question it can answer without publishing first,
and only if every answer is yes does it push the tag (ADR-0068):

  * the checkout is clean, on the release commit, at the requested version;
  * `ci.yml` passed on that commit;
  * no registry has this version yet — or, when the tags are already out,
    what is still missing, so a re-run resumes instead of re-publishing;
  * every CI publish credential is still accepted by its service
    (`.github/workflows/release-credentials.yml`);
  * the local crates.io token and npm login are accepted, and the account
    owns the packages;
  * every pending crate and npm package builds and packages (dry runs).

Then, in order: push `vX.Y.Z` and `desktop-vX.Y.Z`; wait for the tag runs;
refuse to publish locally unless every CI-published channel has converged
on the version; publish the pending crates (one `cargo publish` call, which
verifies all of them before uploading any); publish the pending npm
packages; dispatch `release-verify.yml` and wait for it.

Re-running with the same version is always safe. Every step checks the
registry before acting, so an interrupted release resumes where it
stopped, and a finished one is refused.

Stdlib only.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time
import tomllib
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPTS_DIR.parent
sys.path.insert(0, str(SCRIPTS_DIR))

from _release_channels import Channel, load_channels  # noqa: E402

REPO = "koedame/chordsketch"
USER_AGENT = "chordsketch-release (+https://github.com/koedame/chordsketch)"
HTTP_TIMEOUT = 15
POLL_SECONDS = 30

# Channels this machine publishes. Every other `expected_version = "tag"`
# channel is published by CI from the tag push.
LOCAL_KINDS = frozenset({"crates-io", "npm"})

# `cargo publish` with several `-p` flags verifies every package against a
# local overlay registry before uploading any, then uploads in dependency
# order. Stabilised in Cargo 1.90.
MIN_CARGO = (1, 90)


@dataclass(frozen=True)
class NpmRecipe:
    directory: str
    build: bool


# How each npm channel in ci/release-channels.toml is published, in the order
# docs/releasing.md step 7 publishes them. A new npm channel with no recipe
# fails preflight rather than being silently left out of the release.
NPM_RECIPES: dict[str, NpmRecipe] = {
    "@chordsketch/wasm": NpmRecipe("packages/npm", build=True),
    "tree-sitter-chordpro": NpmRecipe("packages/tree-sitter-chordpro", build=False),
    "@chordsketch/wasm-export": NpmRecipe("packages/npm-export", build=True),
}
# The napi resolver and its platform packages are prebuilt by CI and
# published from the Release assets by crates/napi/scripts/local-publish.sh.
NAPI_PACKAGE = "@chordsketch/node"
NAPI_PUBLISH_SCRIPT = "crates/napi/scripts/local-publish.sh"


def tags_for(version: str) -> tuple[str, str]:
    return f"v{version}", f"desktop-v{version}"


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


def interpret_crates_token_probe(status: int, body: str) -> tuple[bool, str]:
    """Classify crates.io's answer to an authenticated read.

    The probe is `GET /api/v1/trusted_publishing/github_configs?crate=chordsketch`,
    which crates.io authenticates before it checks the token's scopes, so the
    answer separates a dead token from a live one without publishing:

      200                                   legacy (unscoped) token, owner
      400 "not an owner"                    live token, wrong account
      403 "does not have the required ..."  live token scoped to publishing
      403 "authentication failed"           expired, revoked or mistyped
    """
    try:
        detail = "; ".join(e.get("detail", "") for e in json.loads(body).get("errors", []))
    except (ValueError, AttributeError):
        detail = body.strip()[:200]
    if status == 200:
        return True, ""
    if status == 403 and "does not have the required permissions" in detail:
        return True, (
            "the crates.io token is scoped, and crates.io does not reveal a token's "
            "scopes: it must allow publish-update for every chordsketch crate and "
            "publish-new for any crate that has never been published"
        )
    if status == 400 and "not an owner" in detail:
        return False, "the crates.io token belongs to an account that does not own `chordsketch`"
    return False, f"crates.io rejected the token (HTTP {status}: {detail or 'no detail'})"


def dated_changelog_heading(changelog: str, version: str) -> bool:
    pattern = rf"^## \[{re.escape(version)}\] - \d{{4}}-\d{{2}}-\d{{2}}$"
    return re.search(pattern, changelog, flags=re.MULTILINE) is not None


def parse_cargo_version(output: str) -> tuple[int, int] | None:
    match = re.match(r"cargo (\d+)\.(\d+)", output)
    return (int(match.group(1)), int(match.group(2))) if match else None


def npm_publish_order(pending: tuple[str, ...]) -> list[str]:
    """Recipe packages in docs order, with the napi set after tree-sitter.

    The napi set is one step: the local-publish script handles the platform
    packages and the resolver together, platform packages first.
    """
    order = ["@chordsketch/wasm", "tree-sitter-chordpro", NAPI_PACKAGE, "@chordsketch/wasm-export"]
    napi_pending = any(is_napi(name) for name in pending)
    return [name for name in order if name in pending or (name == NAPI_PACKAGE and napi_pending)]


def is_napi(package: str) -> bool:
    return package == NAPI_PACKAGE or package.startswith(NAPI_PACKAGE + "-")


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


def tag_runs(tag: str) -> list[dict]:
    runs = gh_api(f"repos/{REPO}/actions/runs?event=push&branch={urllib.parse.quote(tag)}&per_page=50")
    return list(runs["workflow_runs"])  # type: ignore[index]


# ---------------------------------------------------------------- survey


@dataclass
class Survey:
    version: str
    head: str
    remote_tags: dict[str, str | None]
    ci_channels: list[Channel]
    crates: list[str]
    npm: list[str]
    ci_published: dict[str, bool] = field(default_factory=dict)
    ci_detail: dict[str, str] = field(default_factory=dict)
    crates_published: dict[str, bool] = field(default_factory=dict)
    npm_published: dict[str, bool] = field(default_factory=dict)


def survey(version: str) -> Survey:
    run(["git", "fetch", "--quiet", "origin", "main"])
    head = run(["git", "rev-parse", "HEAD"]).stdout.strip()

    remote_tags: dict[str, str | None] = {}
    for tag in tags_for(version):
        out = run(["git", "ls-remote", "origin", f"refs/tags/{tag}", f"refs/tags/{tag}^{{}}"]).stdout
        refs = dict(line.split("\t")[::-1] for line in out.splitlines() if line)
        remote_tags[tag] = refs.get(f"refs/tags/{tag}^{{}}") or refs.get(f"refs/tags/{tag}")

    tag_channels = [c for c in load_channels() if c.expected_version == "tag"]
    state = Survey(
        version=version,
        head=head,
        remote_tags=remote_tags,
        ci_channels=[c for c in tag_channels if c.kind not in LOCAL_KINDS],
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
    notes: list[str] = field(default_factory=list)

    def check(self, ok: bool, problem: str) -> bool:
        if not ok:
            self.problems.append(problem)
        return ok


def preflight(state: Survey, plan: Plan, login: str) -> Findings:
    findings = Findings()
    version = state.version
    fresh = len(plan.tags_to_push) == 2

    section("Checkout")
    dirty = run(["git", "status", "--porcelain"]).stdout.strip()
    findings.check(not dirty, "the working tree has uncommitted or untracked files; release from a clean checkout")
    if fresh:
        main = run(["git", "rev-parse", "origin/main"]).stdout.strip()
        findings.check(state.head == main, f"HEAD is {state.head[:12]}, not origin/main ({main[:12]}); check out the release commit")
    else:
        tagged = {sha for sha in state.remote_tags.values() if sha}
        findings.check(
            tagged == {state.head},
            f"HEAD is {state.head[:12]}, but the release tags point at {', '.join(s[:12] for s in sorted(tagged))}; "
            f"check out the tagged commit",
        )
    cli_version = tomllib.loads((REPO_ROOT / "crates/cli/Cargo.toml").read_text())["package"]["version"]
    findings.check(cli_version == version, f"the workspace is at {cli_version}, not {version}")
    consistency = run([sys.executable, "scripts/check-version-consistency.py"], check=False)
    findings.check(consistency.returncode == 0, "scripts/check-version-consistency.py fails:\n" + consistency.stdout + consistency.stderr)
    changelog = (REPO_ROOT / "CHANGELOG.md").read_text()
    findings.check(dated_changelog_heading(changelog, version), f"CHANGELOG.md has no dated `## [{version}] - YYYY-MM-DD` heading")

    if fresh:
        section(f"CI on {state.head[:12]}")
        runs = gh_api(f"repos/{REPO}/actions/workflows/ci.yml/runs?head_sha={state.head}&event=push&per_page=5")
        latest = next(iter(runs["workflow_runs"]), None)  # type: ignore[index]
        if latest is None:
            findings.problems.append("ci.yml has not run on the release commit")
        else:
            findings.check(
                latest["status"] == "completed" and latest["conclusion"] == "success",
                f"ci.yml on the release commit is {latest['status']}/{latest['conclusion']}: {latest['html_url']}",
            )

    section("GitHub")
    push = run(["gh", "api", f"repos/{REPO}", "--jq", ".permissions.push"], check=False).stdout.strip()
    findings.check(push == "true", f"the gh login `{login}` cannot push to {REPO}")

    credentials_run = None
    if fresh or plan.pending_ci:
        # Dispatched now so the local checks below use the time it takes.
        section("CI publish credentials (release-credentials.yml)")
        try:
            credentials_run = dispatch("release-credentials.yml", {}, login)
        except ReleaseError as exc:
            findings.problems.append(f"could not run the CI credential check: {exc}")

    if plan.pending_crates:
        preflight_crates(plan, findings)
    if plan.pending_npm:
        preflight_npm(state, plan, findings)
    if not fresh and plan.pending_ci:
        preflight_stalled_ci(state, plan, findings)
    if not fresh:
        preflight_release_assets(state, plan, findings)

    if credentials_run is not None:
        section("Waiting for release-credentials.yml")
        credentials = wait_for_run(credentials_run)
        if credentials["conclusion"] != "success":
            for job in failed_jobs(credentials_run):
                findings.problems.append(f"CI credential check failed: {job} — {credentials['html_url']}")

    # The dry runs build every pending package, which takes minutes. Every
    # other check is cheap, so a run that is going to fail anyway reports
    # that first instead of after the builds.
    if findings.problems:
        findings.notes.append("the crates.io and npm dry runs were skipped; they run once the preflight problems are fixed")
    else:
        if plan.pending_crates:
            dry_run_crates(plan, findings)
        if plan.pending_npm:
            dry_run_npm(plan, findings)

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


def preflight_crates(plan: Plan, findings: Findings) -> None:
    section(f"crates.io ({len(plan.pending_crates)} pending)")
    if not findings.check(shutil.which("cargo") is not None, "cargo is not on PATH"):
        return
    cargo = parse_cargo_version(run(["cargo", "--version"]).stdout)
    if not findings.check(
        cargo is not None and cargo >= MIN_CARGO,
        f"cargo {MIN_CARGO[0]}.{MIN_CARGO[1]}+ is required to publish several crates in one call",
    ):
        return

    token = crates_token()
    if findings.check(token is not None, "no crates.io token: set CARGO_REGISTRY_TOKEN or run `cargo login`"):
        status, body = http_status(
            "https://crates.io/api/v1/trusted_publishing/github_configs?crate=chordsketch",
            {"Authorization": token or ""},
        )
        ok, message = interpret_crates_token_probe(status, body)
        if ok and message:
            new = [c for c in plan.pending_crates if not crate_exists(c)]
            findings.notes.append(message + (f" (never published: {', '.join(new)})" if new else ""))
        elif not ok:
            findings.problems.append(message)


def dry_run_crates(plan: Plan, findings: Findings) -> None:
    section("cargo publish --dry-run (verifies every pending crate together)")
    dry = run(["cargo", "publish", "--dry-run", "--locked", *flag_each("-p", plan.pending_crates)], check=False, capture=False)
    findings.check(dry.returncode == 0, "`cargo publish --dry-run` failed for the pending crates (output above)")


def crates_token() -> str | None:
    if os.environ.get("CARGO_REGISTRY_TOKEN"):
        return os.environ["CARGO_REGISTRY_TOKEN"]
    cargo_home = Path(os.environ.get("CARGO_HOME", Path.home() / ".cargo"))
    for name in ("credentials.toml", "credentials"):
        path = cargo_home / name
        if path.is_file():
            token = tomllib.loads(path.read_text()).get("registry", {}).get("token")
            if token:
                return str(token)
    return None


def crate_exists(crate: str) -> bool:
    status, _ = http_status(f"https://crates.io/api/v1/crates/{crate}")
    return status == 200


def flag_each(flag: str, values: tuple[str, ...] | list[str]) -> list[str]:
    return [item for value in values for item in (flag, value)]


def preflight_npm(state: Survey, plan: Plan, findings: Findings) -> None:
    section(f"npm ({len(plan.pending_npm)} pending)")
    unknown = [p for p in state.npm if p not in NPM_RECIPES and not is_napi(p)]
    findings.check(not unknown, f"no publish recipe in scripts/release.py for npm channel(s): {', '.join(unknown)}")
    if not findings.check(shutil.which("npm") is not None, "npm is not on PATH"):
        return

    whoami = run(["npm", "whoami"], check=False)
    user = whoami.stdout.strip()
    if findings.check(whoami.returncode == 0 and bool(user), "npm is not logged in: run `npm login`"):
        for package in plan.pending_npm:
            owners = run(["npm", "owner", "ls", package], check=False)
            if owners.returncode == 0:
                names = {line.split()[0] for line in owners.stdout.splitlines() if line.strip()}
                findings.check(user in names, f"npm user `{user}` is not an owner of {package}")
            elif package.startswith("@chordsketch/"):
                members = run(["npm", "org", "ls", "chordsketch", user, "--json"], check=False)
                findings.check(
                    members.returncode == 0 and user in json.loads(members.stdout or "{}"),
                    f"{package} does not exist yet and `{user}` is not a member of the chordsketch npm org",
                )
        findings.notes.append(
            "npm asks for a one-time password on each publish if the account uses 2FA"
        )

    needs_wasm = any(NPM_RECIPES.get(p, NpmRecipe("", False)).build for p in plan.pending_npm)
    if needs_wasm:
        findings.check(shutil.which("wasm-pack") is not None, "wasm-pack is not on PATH (needed to build the wasm packages)")


def dry_run_npm(plan: Plan, findings: Findings) -> None:
    section("npm build and publish --dry-run")
    for package in plan.pending_npm:
        recipe = NPM_RECIPES.get(package)
        if recipe is None:
            continue
        directory = REPO_ROOT / recipe.directory
        if recipe.build:
            print(f"    building {package}", flush=True)
            build = run(["npm", "run", "build"], cwd=directory, check=False, capture=False)
            if not findings.check(build.returncode == 0, f"`npm run build` failed for {package} (output above)"):
                continue
        dry = run(["npm", "publish", "--dry-run", "--access", "public"], cwd=directory, check=False)
        findings.check(dry.returncode == 0, f"`npm publish --dry-run` failed for {package}:\n{dry.stderr.strip()}")


def preflight_release_assets(state: Survey, plan: Plan, findings: Findings) -> None:
    """With the tag already out, the napi tarballs must be on the Release."""
    if not any(is_napi(p) for p in plan.pending_npm):
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
    wanted = [f"chordsketch-node-{state.version}.tgz"] + [
        f"chordsketch-{p.removeprefix('@chordsketch/')}-{state.version}.tgz"
        for p in state.npm
        if is_napi(p) and p != NAPI_PACKAGE
    ]
    return [name for name in wanted if name not in assets]


# ---------------------------------------------------------------- release steps


def push_tags(state: Survey, tags: tuple[str, ...]) -> None:
    section(f"Pushing {', '.join(tags)}")
    for tag in tags:
        run(["git", "tag", "--force", tag, state.head])
    run(["git", "push", "origin", *[f"refs/tags/{tag}" for tag in tags]], capture=False)


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


def gate_local_publish(state: Survey, plan: Plan) -> None:
    """Refuse crates.io and npm unless every CI-published channel converged."""
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
    if any(is_napi(p) for p in plan.pending_npm):
        missing = missing_napi_assets(state, tag)
        if missing:
            problems.append(f"the {tag} Release lacks napi tarballs: {', '.join(missing)}")

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


def ensure_local_logins(plan: Plan) -> None:
    """The CI wait can outlast an npm login session; re-check before publishing."""
    if plan.pending_npm and run(["npm", "whoami"], check=False).returncode != 0:
        if not sys.stdin.isatty():
            raise ReleaseError("npm is no longer logged in; run `npm login` and re-run the script")
        print("    npm is no longer logged in; starting `npm login`", flush=True)
        run(["npm", "login"], capture=False)
        run(["npm", "whoami"])
    if plan.pending_crates:
        token = crates_token()
        if token is None:
            raise ReleaseError("the crates.io token disappeared; set CARGO_REGISTRY_TOKEN and re-run the script")
        ok, message = interpret_crates_token_probe(*http_status(
            "https://crates.io/api/v1/trusted_publishing/github_configs?crate=chordsketch",
            {"Authorization": token},
        ))
        if not ok:
            raise ReleaseError(message)


def publish_crates(plan: Plan) -> None:
    section(f"Publishing {len(plan.pending_crates)} crates")
    run(["cargo", "publish", "--locked", *flag_each("-p", plan.pending_crates)], capture=False)


def publish_npm(state: Survey, plan: Plan) -> None:
    tag = tags_for(state.version)[0]
    for package in npm_publish_order(plan.pending_npm):
        section(f"Publishing {package}")
        if package == NAPI_PACKAGE:
            run(["bash", NAPI_PUBLISH_SCRIPT, tag], capture=False)
            continue
        recipe = NPM_RECIPES[package]
        run(["npm", "publish", "--access", "public"], cwd=REPO_ROOT / recipe.directory, capture=False)


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
        print(f"    push tags: {', '.join(plan.tags_to_push)} at {state.head[:12]}")
        print("    wait for the tag runs (the CI-published channels)")
    if plan.pending_ci:
        print(f"    CI channels not yet on {state.version}: {', '.join(plan.pending_ci)}")
    print(f"    crates.io: {', '.join(plan.pending_crates) or 'nothing pending'}")
    print(f"    npm: {', '.join(plan.pending_npm) or 'nothing pending'}")
    print("    dispatch release-verify.yml")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    parser.add_argument("version", help="the version being released, without the leading v (e.g. 0.7.0)")
    parser.add_argument("--check", action="store_true", help="run the preflight and stop; changes nothing")
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
        section(f"Surveying every channel for {args.version}")
        state = survey(args.version)
        plan = decide(args.version, state.remote_tags, state.ci_published, state.crates_published, state.npm_published)
        if plan.refusal:
            print(f"\nerror: {plan.refusal}", file=sys.stderr)
            return 1
        print_plan(state, plan)

        findings = preflight(state, plan, login)
        for note in findings.notes:
            print(f"\nnote: {note}", flush=True)
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
        gate_local_publish(state, plan)
        ensure_local_logins(plan)
        if plan.pending_crates:
            publish_crates(plan)
        if plan.pending_npm:
            publish_npm(state, plan)
        verify_release(state, login)
    except ReleaseError as exc:
        print(f"\nerror: {exc}", file=sys.stderr)
        print(f"Re-running `scripts/release.py {args.version}` resumes from what is still missing.", file=sys.stderr)
        return 1

    print(f"\nv{args.version} is released. winget and MacPorts are still manual (docs/releasing.md, Post-Release).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
