#!/usr/bin/env python3
"""Publish the crates.io and npm packages from CI, with trusted publishing.

    python3 scripts/publish-registries.py plan
    python3 scripts/publish-registries.py crates --crates '["chordsketch"]'
    python3 scripts/publish-registries.py npm --packages '["@chordsketch/wasm"]' --all-packages '[...]' --mode check --tag v0.7.0 --out DIR

Run only by `.github/workflows/publish-registries.yml` (ADR-0069). The jobs
there authenticate with the registries through GitHub's OIDC token, so this
script never sees a stored credential.

Subcommands:

  plan    List the crates and npm packages the release publishes, and those
          whose manifest version the registry does not serve yet (pending),
          as JSON lists in `$GITHUB_OUTPUT`. Fails when one of them has never
          been published: neither registry lets trusted publishing create a
          package.
  crates  Run the pull-request publish checks (`scripts/_publish_checks.py`)
          over the pending crates, including one `cargo publish --dry-run`
          over all of them, so the real publish that follows is not the
          first build and fits in the 30 minutes its token lives.
  npm     Build, pack and check every pending npm package — the napi
          resolver and platform packages from the tarballs on the tag's
          GitHub Release. Then, with `--mode check`, exchange the job's OIDC
          token for every package the release publishes (`--all-packages`), published
          or not, which fails for a package whose trusted publisher does not
          name this workflow and environment; with `--mode publish`, publish
          the checked tarballs and wait until the registry serves them.

Only pending packages are built and dry-run: npm 11's `publish --dry-run`
refuses a version that is already published.

Every problem is printed as a `::error::` annotation, so
`scripts/release.py` can report why a dispatched run failed without the
maintainer opening the run. Stdlib only.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
import tomllib
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, NoReturn

SCRIPTS_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPTS_DIR.parent
sys.path.insert(0, str(SCRIPTS_DIR))

import _publish_checks as checks  # noqa: E402
from _release_channels import load_channels  # noqa: E402

REPO = "koedame/chordsketch"
USER_AGENT = "chordsketch-publish-registries (+https://github.com/koedame/chordsketch)"
HTTP_TIMEOUT = 30
NPM_REGISTRY = "https://registry.npmjs.org"

# `cargo publish` with several `-p` flags verifies every package against a
# local overlay registry before uploading any, then uploads in dependency
# order. Stabilised in Cargo 1.90.
MIN_CARGO = (1, 90)

# npm accepts a publish before it serves it, so a lookup straight after
# publishing can 404 for a package that did publish (0.6.0 saw four).
SERVE_ATTEMPTS = 30
SERVE_INTERVAL_SECONDS = 10


# ---------------------------------------------------------------- packages


def workspace_packages(tree: Path) -> tuple[list[str], list[str]]:
    """The crates and npm packages versioned with the release tag.

    Read from `ci/release-channels.toml`, the same manifest `release.py`
    surveys, so the two cannot disagree about what a release publishes.
    Every crate and npm package this repository publishes is among them
    (ADR-0073).
    """
    channels = [c for c in load_channels(tree / "ci" / "release-channels.toml") if c.expected_version == "tag"]
    return (
        [c.package for c in channels if c.kind == "crates-io"],
        [c.package for c in channels if c.kind == "npm"],
    )


def crate_versions(tree: Path) -> dict[str, str]:
    versions = {}
    for manifest in sorted((tree / "crates").glob("*/Cargo.toml")):
        package = tomllib.loads(manifest.read_text()).get("package", {})
        if isinstance(package.get("version"), str):
            versions[package["name"]] = package["version"]
    return versions


def npm_version(tree: Path, package: str) -> str:
    directory = tree / checks.NPM_PACKAGES[package].directory
    return json.loads((directory / "package.json").read_text())["version"]


def npm_publish_order(packages: list[str]) -> list[str]:
    """The napi platform packages before their resolver, the rest as given.

    The resolver's `optionalDependencies` name the platform packages; an
    install of a resolver whose platform package is not served yet silently
    skips it and then fails at `require()`.
    """
    platforms = [p for p in packages if checks.is_napi(p) and p != checks.NAPI_PACKAGE]
    resolver = [p for p in packages if p == checks.NAPI_PACKAGE]
    others = [p for p in packages if not checks.is_napi(p)]
    return platforms + resolver + others


# ---------------------------------------------------------------- registries


def fail(message: str) -> NoReturn:
    """Stop the step on a condition no later check can get past."""
    print(f"::error::{message}", flush=True)
    raise SystemExit(1)


def http(url: str, *, method: str = "GET", headers: dict[str, str] | None = None) -> tuple[int, str]:
    request = urllib.request.Request(url, method=method, headers={"User-Agent": USER_AGENT, **(headers or {})})
    try:
        with urllib.request.urlopen(request, timeout=HTTP_TIMEOUT) as response:
            return response.status, response.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode("utf-8", "replace")


def registry_answer(url: str, what: str, fetch: Callable[..., tuple[int, str]] = http) -> bool:
    status, _ = fetch(url)
    if status not in (200, 404):
        fail(f"{what}: the registry answered HTTP {status}")
    return status == 200


def crate_served(crate: str, version: str | None = None, fetch: Callable[..., tuple[int, str]] = http) -> bool:
    path = f"{crate}/{version}" if version else crate
    return registry_answer(f"https://crates.io/api/v1/crates/{path}", f"crates.io {path}", fetch)


def npm_escaped(package: str) -> str:
    """How npm writes a package name into a registry URL (`@scope%2fname`)."""
    return package.replace("/", "%2f")


def npm_served(package: str, version: str | None = None, fetch: Callable[..., tuple[int, str]] = http) -> bool:
    path = npm_escaped(package) + (f"/{version}" if version else "")
    return registry_answer(f"{NPM_REGISTRY}/{path}", f"npm {package}", fetch)


def github_id_token(audience: str, fetch: Callable[..., tuple[int, str]] = http) -> str:
    """The job's OIDC token for `audience`; needs `id-token: write`."""
    url = os.environ.get("ACTIONS_ID_TOKEN_REQUEST_URL")
    token = os.environ.get("ACTIONS_ID_TOKEN_REQUEST_TOKEN")
    if not url or not token:
        fail("no GitHub OIDC token in this job: it needs `permissions: id-token: write`")
    separator = "&" if "?" in url else "?"
    status, body = fetch(
        f"{url}{separator}audience={urllib.parse.quote(audience)}",
        headers={"Authorization": f"bearer {token}", "Accept": "application/json"},
    )
    if status != 200:
        fail(f"GitHub refused an OIDC token (HTTP {status})")
    return json.loads(body)["value"]


def interpret_npm_exchange(package: str, status: int, body: str) -> str:
    """The problem an OIDC token exchange reports for `package`, or "" when it worked.

    The exchange is the call `npm publish` makes before uploading, so its
    answer is the answer the publish would get.
    """
    if status in (200, 201):
        try:
            if json.loads(body).get("token"):
                return ""
        except ValueError:
            pass
        return f"npm accepted the OIDC token for {package} but returned no publish token"
    try:
        detail = json.loads(body).get("message") or json.loads(body).get("error") or ""
    except ValueError:
        detail = body.strip()[:200]
    return (
        f"npm will not let this workflow publish {package} (HTTP {status}: {detail or 'no detail'}): its trusted "
        f"publisher must name repository {REPO}, workflow publish-registries.yml and environment npm "
        f"(docs/releasing.md, \"Trusted publishing\")"
    )


def npm_exchange_problem(package: str, id_token: str, fetch: Callable[..., tuple[int, str]] = http) -> str:
    status, body = fetch(
        f"{NPM_REGISTRY}/-/npm/v1/oidc/token/exchange/package/{npm_escaped(package)}",
        method="POST",
        headers={"Authorization": f"Bearer {id_token}", "Accept": "application/json"},
    )
    return interpret_npm_exchange(package, status, body)


# ---------------------------------------------------------------- reporting


def report(problems: list[str]) -> int:
    """Print every problem as an annotation; the exit code of the step."""
    for problem in problems:
        first, _, rest = problem.partition("\n")
        # An annotation is one line; the detail follows it in the log.
        print(f"::error::{first}", flush=True)
        if rest:
            print(rest, flush=True)
    return 1 if problems else 0


def write_output(name: str, value: str) -> None:
    path = os.environ.get("GITHUB_OUTPUT")
    if path:
        with open(path, "a", encoding="utf-8") as handle:
            handle.write(f"{name}={value}\n")
    print(f"{name}={value}", flush=True)


def run(cmd: list[str], cwd: Path = REPO_ROOT) -> subprocess.CompletedProcess[str]:
    print(f"$ {' '.join(cmd)}", flush=True)
    return subprocess.run(cmd, cwd=cwd, text=True)


# ---------------------------------------------------------------- plan


@dataclass(frozen=True)
class Plan:
    """The packages a release publishes, and those the registries do not serve yet.

    A check exchanges a token for every one of them, but builds and
    dry-runs only the unpublished ones: npm 11's `publish --dry-run` refuses
    a version that is already published. A publish covers the unpublished
    ones alone.
    """

    crates: list[str] = field(default_factory=list)
    npm: list[str] = field(default_factory=list)
    pending_crates: list[str] = field(default_factory=list)
    pending_npm: list[str] = field(default_factory=list)
    problems: list[str] = field(default_factory=list)


def plan(tree: Path, served: Callable[[str, str, str | None], bool]) -> Plan:
    """What a run for the release at `tree` covers.

    `served(kind, name, version)` answers whether the registry serves that
    version, or with `version=None` whether the package exists at all.
    """
    crates, npm = workspace_packages(tree)

    problems = []
    unknown = [name for name in npm if name not in checks.NPM_PACKAGES]
    if unknown:
        problems.append(f"no publish definition in scripts/_publish_checks.py for npm package(s): {', '.join(unknown)}")
        npm = [name for name in npm if name in checks.NPM_PACKAGES]

    for kind, names, how in (
        ("crates-io", crates, "`cargo publish -p {name}` with a token scoped to publish-new"),
        ("npm", npm, "`npm publish` after `npm login`"),
    ):
        for name in names:
            if not served(kind, name, None):
                problems.append(
                    f"{name} has never been published, and trusted publishing cannot create a package: publish its "
                    f"first version by hand ({how.format(name=name)}), register its trusted publisher, then dispatch "
                    f"this workflow again (docs/releasing.md, \"Adding a package\")"
                )

    versions = crate_versions(tree)
    return Plan(
        crates=crates,
        npm=npm,
        pending_crates=[c for c in crates if not served("crates-io", c, versions[c])],
        pending_npm=[p for p in npm if not served("npm", p, npm_version(tree, p))],
        problems=problems,
    )


def served_on_registry(kind: str, name: str, version: str | None) -> bool:
    return crate_served(name, version) if kind == "crates-io" else npm_served(name, version)


def cmd_plan(args: argparse.Namespace) -> int:
    result = plan(REPO_ROOT, served_on_registry)
    write_output("crates", json.dumps(result.crates))
    write_output("npm", json.dumps(result.npm))
    write_output("pending_crates", json.dumps(result.pending_crates))
    write_output("pending_npm", json.dumps(result.pending_npm))
    write_output("wasm", json.dumps(any("wasm-pack" in checks.NPM_PACKAGES[p].tools for p in result.pending_npm)))
    if not result.pending_crates and not result.pending_npm and not result.problems:
        print("::notice::every package is already published at its manifest version", flush=True)
    return report(result.problems)


# ---------------------------------------------------------------- crates.io


def parse_cargo_version(output: str) -> tuple[int, int] | None:
    match = re.match(r"cargo (\d+)\.(\d+)", output)
    return (int(match.group(1)), int(match.group(2))) if match else None


def cmd_crates(args: argparse.Namespace) -> int:
    crates = tuple(json.loads(args.crates))
    if not crates:
        print("every crate is already published at its manifest version; only the token is checked", flush=True)
        return 0
    version = subprocess.run(["cargo", "--version"], text=True, capture_output=True).stdout
    cargo = parse_cargo_version(version)
    if cargo is None or cargo < MIN_CARGO:
        return report([f"cargo {MIN_CARGO[0]}.{MIN_CARGO[1]}+ is required to publish several crates in one call (found: {version.strip()})"])
    target = Path(os.environ.get("CARGO_TARGET_DIR", REPO_ROOT / "target"))
    return report(checks.crates_problems(REPO_ROOT, crates, target))


# ---------------------------------------------------------------- npm


def napi_release_tarballs(packages: list[str], tag: str, out: Path, mode: str) -> list[str]:
    """Download the pending napi tarballs `napi.yml` put on the Release, and check them."""
    if not tag:
        if mode == "publish":
            return ["publishing the napi packages needs `--tag`: their tarballs come from the tag's GitHub Release"]
        print("::notice::not tagged yet, so the napi tarballs are not on a Release to check; "
              "publishable.yml checks their staging on every pull request", flush=True)
        return []
    napi = [p for p in packages if checks.is_napi(p)]
    names = [checks.npm_tarball_name(p, npm_version(REPO_ROOT, p)) for p in napi]
    patterns = [item for name in names for item in ("-p", name)]
    download = run(["gh", "release", "download", tag, "-R", REPO, "-D", str(out), "--clobber", *patterns])
    if download.returncode != 0:
        if mode == "check":
            print(f"::notice::the {tag} Release has no napi tarballs yet; they are checked again when publishing", flush=True)
            return []
        return [f"could not download the napi tarballs from the {tag} Release; re-run napi.yml for {tag} first"]
    missing = [name for name in names if not (out / name).is_file()]
    if missing:
        return [f"the {tag} Release lacks napi tarballs: {', '.join(missing)}"]
    return checks.napi_problems(
        out, npm_version(REPO_ROOT, checks.NAPI_PACKAGE), checks.repo_npm_versions(REPO_ROOT), packages=napi
    )


def check_npm_packages(packages: list[str], tag: str, out: Path, mode: str) -> list[str]:
    problems = []
    released_together = checks.repo_npm_versions(REPO_ROOT)
    for package in packages:
        if checks.is_napi(package):
            continue
        print(f"\n==> {package}", flush=True)
        problems += checks.npm_problems(checks.NPM_PACKAGES[package], REPO_ROOT, out, released_together)
    if any(checks.is_napi(p) for p in packages):
        print("\n==> the napi tarballs", flush=True)
        problems += napi_release_tarballs(packages, tag, out, mode)
    return problems


def wait_until_served(
    expected: dict[str, str],
    served: Callable[[str, str], bool],
    attempts: int = SERVE_ATTEMPTS,
    interval: float = SERVE_INTERVAL_SECONDS,
) -> list[str]:
    """The packages npm still does not serve at their version after waiting."""
    pending = dict(expected)
    for attempt in range(1, attempts + 1):
        pending = {name: version for name, version in pending.items() if not served(name, version)}
        if not pending:
            return []
        if attempt < attempts:
            print(f"    waiting for the registry to serve: {', '.join(pending)}", flush=True)
            time.sleep(interval)
    return [
        f"npm still does not serve {name}@{version} after {(attempts - 1) * interval:.0f}s; "
        f"dispatch this workflow again, published packages are skipped"
        for name, version in pending.items()
    ]


def publish_npm_packages(packages: list[str], out: Path) -> list[str]:
    published = {}
    for package in npm_publish_order(packages):
        version = npm_version(REPO_ROOT, package)
        if npm_served(package, version):
            print(f"    {package}@{version} is already published", flush=True)
            continue
        # The tarball the checks above read, so what is uploaded is exactly
        # what passed. No token is configured: npm exchanges the job's OIDC
        # token itself, and adds a provenance attestation.
        result = run(["npm", "publish", "--access", "public", str(out / checks.npm_tarball_name(package, version))])
        if result.returncode != 0:
            return [f"`npm publish` failed for {package}@{version}; dispatch this workflow again to resume"]
        published[package] = version
    return wait_until_served(published, npm_served)


def cmd_npm(args: argparse.Namespace) -> int:
    packages = npm_publish_order(json.loads(args.packages))
    args.out.mkdir(parents=True, exist_ok=True)
    problems = check_npm_packages(packages, args.tag, args.out, args.mode)
    if problems:
        return report(problems)

    if args.mode == "check":
        print("\n==> trusted publisher of every package", flush=True)
        id_token = github_id_token("npm:registry.npmjs.org")
        return report([problem for p in json.loads(args.all_packages) if (problem := npm_exchange_problem(p, id_token))])
    return report(publish_npm_packages(packages, args.out))


# ---------------------------------------------------------------- main


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("plan", help="decide what the release still needs")
    crates_parser = sub.add_parser("crates", help="check the pending crates before publishing them")
    crates_parser.add_argument("--crates", required=True, help="JSON list, from `plan`")
    npm_parser = sub.add_parser("npm", help="check, then token-check or publish, the pending npm packages")
    npm_parser.add_argument("--packages", required=True, help="the pending packages, a JSON list from `plan`")
    npm_parser.add_argument("--all-packages", default="[]", help="every npm package of the release, a JSON list from `plan`; `--mode check` exchanges a token for each")
    npm_parser.add_argument("--mode", choices=("check", "publish"), required=True)
    npm_parser.add_argument("--tag", default="", help="the release tag whose GitHub Release carries the napi tarballs")
    npm_parser.add_argument("--out", type=Path, required=True, help="directory to pack into")
    args = parser.parse_args(argv)
    return {"plan": cmd_plan, "crates": cmd_crates, "npm": cmd_npm}[args.command](args)


if __name__ == "__main__":
    raise SystemExit(main())
