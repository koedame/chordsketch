#!/usr/bin/env python3
"""Post-release channel rollup — query every registry and fail on drift.

Invoked by `.github/workflows/release-verify.yml` on `release: published`.
Can also be run with `workflow_dispatch` via the same workflow for manual
re-verification or red-path dry-runs (`--force-stale <channel-id>`).

Usage (workflow context):

    python3 scripts/check-release-channels.py --tag v0.2.0 --channel crates-io-cli

    # Forces the named channel to report a synthetic stale version, turning
    # the workflow red — used to verify the rollup actually fails loud.
    python3 scripts/check-release-channels.py --tag v0.2.0 --channel crates-io-cli \
        --force-stale crates-io-cli

Exits 0 on success, 1 on any failure (registry error, version mismatch,
visibility contract broken). Prints a single-line status to stdout followed
by any diagnostic lines on stderr.

Stdlib only — no external deps. HTTP goes through urllib with an explicit
15s timeout and a named User-Agent so registry rate limiters can identify
us if we misbehave.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

# Ensure the sibling helper module is importable regardless of cwd — scripts
# is added to sys.path so `from _release_channels import ...` works when the
# script is invoked with a bare `python3 scripts/check-release-channels.py`.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from _release_channels import Channel, find_channel, load_channels  # noqa: E402

HTTP_TIMEOUT = 15  # seconds
USER_AGENT = "chordsketch-release-verify (+https://github.com/koedame/chordsketch)"


@dataclass(frozen=True)
class CheckResult:
    """Outcome of a single channel verification."""

    channel_id: str
    ok: bool
    observed: str  # what we found on the registry (or "<error>")
    expected: str  # what the tag said we should find
    detail: str  # human-readable one-line summary


# ---------------------------------------------------------------- HTTP helpers


def _http_get_json(url: str) -> dict:
    """GET a URL and parse the body as JSON. Raises on any HTTP error."""
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:  # noqa: S310
        return json.loads(resp.read().decode("utf-8"))


def _http_get_text(url: str) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:  # noqa: S310
        return resp.read().decode("utf-8")


def _http_head_ok(
    url: str,
    *,
    bearer_token: str | None = None,
    accept: str | None = None,
) -> bool:
    """Return True if the URL responds 200/206 to a GET request.

    HEAD is technically what we want, but several container registries (GHCR
    in particular) return 401 on HEAD for public images while responding 200
    to GET. Using GET with `Range: bytes=0-0` avoids downloading the manifest
    body while still matching what the public visibility contract actually
    guarantees.

    Pass `bearer_token` when the registry requires an OAuth bearer (GHCR
    enforces this even for public packages — anonymous GET always returns
    401, so the caller must obtain a pull token first via
    `_ghcr_pull_token`).

    Pass `accept` to override the Accept header. GHCR's manifest endpoint
    returns 404 unless the request explicitly negotiates a manifest media
    type (OCI / Docker v2); without an Accept header, the registry cannot
    resolve which manifest representation to serve.
    """
    headers = {"User-Agent": USER_AGENT, "Range": "bytes=0-0"}
    if bearer_token is not None:
        headers["Authorization"] = f"Bearer {bearer_token}"
    if accept is not None:
        headers["Accept"] = accept
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:  # noqa: S310
            return resp.status in (200, 206)
    except urllib.error.HTTPError:
        # urllib raises HTTPError only for 4xx/5xx responses; 2xx responses
        # go through the `with` block above. Any HTTPError we see here is
        # therefore a non-success status and should report the URL as
        # unreachable. See #1515.
        return False
    except urllib.error.URLError:
        return False


def _ghcr_pull_token(repo: str) -> str | None:
    """Fetch an anonymous GHCR pull token for `<repo>` (e.g. `koedame/chordsketch`).

    GHCR follows the Docker Registry v2 token-handshake: even for public
    packages, manifest GETs require an `Authorization: Bearer <token>`
    header. The token endpoint serves it without credentials when the
    package's visibility is `public`.

    Returns the token string on success, or `None` if the token endpoint
    is unreachable / returns a malformed payload (which indicates the
    package is private or the registry is misbehaving — both surface as
    `_check_ghcr` failures, which is the right outcome).
    """
    url = (
        "https://ghcr.io/token?service=ghcr.io"
        f"&scope=repository:{repo}:pull"
    )
    try:
        payload = _http_get_json(url)
    except Exception:  # noqa: BLE001
        return None
    token = payload.get("token")
    if isinstance(token, str) and token:
        return token
    return None


def _normalize_tag(tag: str) -> str:
    """Strip the leading `v` from a git tag like `v0.2.0` → `0.2.0`."""
    return tag[1:] if tag.startswith("v") else tag


# ---------------------------------------------------------------- per-kind checkers


def _check_crates_io(channel: Channel, version: str) -> CheckResult:
    url = f"https://crates.io/api/v1/crates/{channel.package}"
    try:
        payload = _http_get_json(url)
    except Exception as exc:  # noqa: BLE001 — any HTTP/JSON failure is a red
        return _error(channel, version, f"crates.io API error: {exc}")
    max_version = str(payload.get("crate", {}).get("max_version") or "<missing>")
    return _compare(channel, version, max_version)


def _check_npm(channel: Channel, version: str) -> CheckResult:
    # urllib-encode the package name so scoped packages like @chordsketch/wasm
    # round-trip correctly through registry.npmjs.org.
    encoded = urllib.parse.quote(channel.package, safe="")
    url = f"https://registry.npmjs.org/{encoded}/latest"
    try:
        payload = _http_get_json(url)
    except Exception as exc:  # noqa: BLE001
        return _error(channel, version, f"npm registry error: {exc}")
    observed = str(payload.get("version") or "<missing>")
    return _compare(channel, version, observed)


def _check_ghcr(channel: Channel, version: str) -> CheckResult:
    # Two assertions: (1) the tag exists, (2) the package is public
    # (anonymous Bearer-token GET returns 200).
    #
    # GHCR follows the Docker Registry v2 token-handshake: the
    # manifest endpoint requires `Authorization: Bearer <token>` even
    # for public packages, and anonymous GET returns 401. The probe
    # therefore acquires a pull token first via
    # `https://ghcr.io/token?…&scope=repository:<repo>:pull`, then
    # GETs the manifest with that token. Token acquisition itself
    # succeeds anonymously only when the package is public — which
    # is exactly the visibility contract this check is asserting.
    #
    # The image tag is the bare `X.Y.Z` (no `v` prefix) — `docker.yml`
    # uses `docker/metadata-action` with `pattern={{version}}`, which
    # strips the `v` from the source git tag. The previous probe
    # targeted `manifests/v<version>` and 404'd on every release (#2418).
    token = _ghcr_pull_token(channel.package)
    if token is None:
        return _error(
            channel, version,
            "GHCR pull token unavailable (package private or token endpoint unreachable)",
        )
    url = f"https://ghcr.io/v2/{channel.package}/manifests/{version}"
    # GHCR's manifest endpoint returns 404 unless the request explicitly
    # negotiates a manifest media type. Both OCI and Docker v2 formats
    # are listed because `docker.yml` builds multi-arch images that
    # surface as either an OCI image-index or a Docker manifest-list,
    # depending on the registry's content negotiation.
    manifest_accept = ",".join([
        "application/vnd.oci.image.index.v1+json",
        "application/vnd.oci.image.manifest.v1+json",
        "application/vnd.docker.distribution.manifest.list.v2+json",
        "application/vnd.docker.distribution.manifest.v2+json",
    ])
    if _http_head_ok(url, bearer_token=token, accept=manifest_accept):
        return CheckResult(
            channel_id=channel.id,
            ok=True,
            observed=version,
            expected=version,
            detail="GHCR manifest is publicly reachable",
        )
    return _error(channel, version, "GHCR manifest not publicly reachable (visibility or missing tag)")


def _check_docker_hub(channel: Channel, version: str) -> CheckResult:
    # Docker Hub tag matches the published image's bare semver
    # (`0.4.0`, `0.4`, `latest`) — `docker.yml` uses
    # `docker/metadata-action` with `pattern={{version}}` which
    # strips the `v` from the git tag. The previous probe targeted
    # `tags/v<version>/` and 404'd on every release (#2418).
    url = f"https://hub.docker.com/v2/repositories/{channel.package}/tags/{version}/"
    try:
        payload = _http_get_json(url)
    except Exception as exc:  # noqa: BLE001
        return _error(channel, version, f"Docker Hub API error: {exc}")
    name = str(payload.get("name") or "<missing>")
    observed = name
    if name == version:
        return CheckResult(
            channel_id=channel.id,
            ok=True,
            observed=observed,
            expected=version,
            detail="Docker Hub tag present",
        )
    return _error(channel, version, f"Docker Hub tag mismatch: got {observed}")


def _check_vscode_marketplace(channel: Channel, version: str) -> CheckResult:
    # The public extensionquery endpoint accepts a POST with a JSON body. The
    # `flags=914` constant asks for IncludeVersions + IncludeAssetUri +
    # IncludeLatestVersionOnly, which is enough for our "does the tag exist"
    # check without pulling the full VSIX bundle.
    url = "https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery"
    body = json.dumps(
        {
            "filters": [
                {
                    "criteria": [
                        {"filterType": 7, "value": channel.package},
                    ],
                    "pageNumber": 1,
                    "pageSize": 1,
                }
            ],
            "flags": 914,
        }
    ).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": "application/json;api-version=3.0-preview.1",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:  # noqa: S310
            payload = json.loads(resp.read().decode("utf-8"))
    except Exception as exc:  # noqa: BLE001
        return _error(channel, version, f"VS Code Marketplace query error: {exc}")
    results = payload.get("results", [])
    if not results:
        return _error(channel, version, "Marketplace returned no results")
    extensions = results[0].get("extensions", [])
    if not extensions:
        return _error(channel, version, "extension not found in Marketplace")
    versions = extensions[0].get("versions", [])
    if not versions:
        return _error(channel, version, "extension has no published versions")
    observed = str(versions[0].get("version") or "<missing>")
    return _compare(channel, version, observed)


def _check_open_vsx(channel: Channel, version: str) -> CheckResult:
    # channel.package is "namespace.extension" (e.g. "koedame.chordsketch").
    # The Open VSX REST API returns the latest published version at:
    #   GET https://open-vsx.org/api/{namespace}/{name}
    try:
        namespace, name = channel.package.split(".", 1)
    except ValueError:
        return _error(channel, version, f"open-vsx package must be 'namespace.name', got {channel.package!r}")
    url = f"https://open-vsx.org/api/{namespace}/{name}"
    try:
        payload = _http_get_json(url)
    except Exception as exc:  # noqa: BLE001
        return _error(channel, version, f"Open VSX API error: {exc}")
    observed = str(payload.get("version") or "<missing>")
    return _compare(channel, version, observed)


def _check_pypi(channel: Channel, version: str) -> CheckResult:
    url = f"https://pypi.org/pypi/{channel.package}/json"
    try:
        payload = _http_get_json(url)
    except Exception as exc:  # noqa: BLE001
        return _error(channel, version, f"PyPI API error: {exc}")
    observed = str(payload.get("info", {}).get("version") or "<missing>")
    return _compare(channel, version, observed)


def _check_rubygems(channel: Channel, version: str) -> CheckResult:
    url = f"https://rubygems.org/api/v1/versions/{channel.package}/latest.json"
    try:
        payload = _http_get_json(url)
    except Exception as exc:  # noqa: BLE001
        return _error(channel, version, f"RubyGems API error: {exc}")
    observed = str(payload.get("version") or "<missing>")
    return _compare(channel, version, observed)


def _check_maven_central(channel: Channel, version: str) -> CheckResult:
    # channel.package is "me.koeda:chordsketch"; split into g and a.
    try:
        group_id, artifact_id = channel.package.split(":", 1)
    except ValueError:
        return _error(channel, version, f"maven package must be 'group:artifact', got {channel.package!r}")
    # Read the authoritative maven-metadata.xml from the canonical Maven
    # Central repository (`repo1.maven.org/maven2`) rather than the
    # `search.maven.org` solrsearch index. The solrsearch index lags
    # publication arbitrarily — empirically, `me.koeda:chordsketch`
    # was unreachable via solrsearch even after multiple releases were
    # accepted by `repo1.maven.org`, producing a perpetual `<error>` in
    # the rollup table (#2418). The metadata.xml endpoint serves the
    # same data the cargo portgroup / Maven clients consume to resolve
    # versions, so it is the publication source of truth.
    group_path = group_id.replace(".", "/")
    url = (
        f"https://repo1.maven.org/maven2/{group_path}/{artifact_id}"
        "/maven-metadata.xml"
    )
    try:
        text = _http_get_text(url)
    except Exception as exc:  # noqa: BLE001
        return _error(channel, version, f"Maven Central metadata error: {exc}")
    # Extract `<release>` from `<versioning><release>X.Y.Z</release>`.
    # Use a narrow regex rather than full XML parsing because the file
    # is a small, well-known, attacker-uncontrolled document and the
    # regex avoids any XXE surface.
    m = re.search(r"<release>([^<]+)</release>", text)
    if not m:
        return _error(channel, version, "Maven Central metadata missing <release>")
    observed = m.group(1).strip()
    return _compare(channel, version, observed)


def _check_homebrew_tap(channel: Channel, version: str) -> CheckResult:
    # The tap is expected to live at koedame/homebrew-tap; the formula file
    # name matches the package name. This fetches the raw formula source
    # directly from GitHub and greps for the version line.
    url = f"https://raw.githubusercontent.com/koedame/homebrew-tap/main/Formula/{channel.package}.rb"
    try:
        text = _http_get_text(url)
    except Exception as exc:  # noqa: BLE001
        return _error(channel, version, f"homebrew-tap fetch error: {exc}")
    match = re.search(r'version\s+"([^"]+)"', text)
    if not match:
        return _error(channel, version, "no version line in formula")
    observed = match.group(1)
    return _compare(channel, version, observed)


def _check_scoop_bucket(channel: Channel, version: str) -> CheckResult:
    url = f"https://raw.githubusercontent.com/koedame/scoop-bucket/main/bucket/{channel.package}.json"
    try:
        payload = json.loads(_http_get_text(url))
    except Exception as exc:  # noqa: BLE001
        return _error(channel, version, f"scoop-bucket fetch error: {exc}")
    observed = str(payload.get("version") or "<missing>")
    return _compare(channel, version, observed)


def _check_manual(channel: Channel, version: str) -> CheckResult:
    # Manual channels are never verified — they are only in the manifest for
    # paper-trail reasons. This function exists so the dispatcher below does
    # not have to special-case their kind.
    return CheckResult(
        channel_id=channel.id,
        ok=True,
        observed="<manual>",
        expected="<skip>",
        detail=channel.skip_reason or "manual channel — verification skipped",
    )


# ---------------------------------------------------------------- comparison helpers


def _compare(channel: Channel, expected: str, observed: str) -> CheckResult:
    if observed == expected:
        return CheckResult(
            channel_id=channel.id,
            ok=True,
            observed=observed,
            expected=expected,
            detail="version matches tag",
        )
    return CheckResult(
        channel_id=channel.id,
        ok=False,
        observed=observed,
        expected=expected,
        detail=f"version mismatch: expected {expected}, observed {observed}",
    )


def _error(channel: Channel, expected: str, detail: str) -> CheckResult:
    return CheckResult(
        channel_id=channel.id,
        ok=False,
        observed="<error>",
        expected=expected,
        detail=detail,
    )


# ---------------------------------------------------------------- dispatcher

_DISPATCH: dict[str, Callable[[Channel, str], CheckResult]] = {
    "crates-io": _check_crates_io,
    "npm": _check_npm,
    "ghcr": _check_ghcr,
    "docker-hub": _check_docker_hub,
    "vscode-marketplace": _check_vscode_marketplace,
    "open-vsx": _check_open_vsx,
    "pypi": _check_pypi,
    "rubygems": _check_rubygems,
    "maven-central": _check_maven_central,
    "homebrew-tap": _check_homebrew_tap,
    "scoop-bucket": _check_scoop_bucket,
    "manual": _check_manual,
}


def verify_channel(channel: Channel, tag: str, force_stale: bool) -> CheckResult:
    """Verify one channel. `tag` is the git tag, e.g. `v0.2.0`.

    If `force_stale` is true, synthesize a failing result with observed
    version "<forced-stale>" so callers can exercise the red path without
    needing a real drift. This satisfies the dry-run acceptance criterion
    in issue #1506.
    """
    if channel.is_skip:
        return _check_manual(channel, "<skip>")

    version = _normalize_tag(tag)

    if force_stale:
        return CheckResult(
            channel_id=channel.id,
            ok=False,
            observed="<forced-stale>",
            expected=version,
            detail="synthetic failure injected via --force-stale for red-path test",
        )

    checker = _DISPATCH.get(channel.kind)
    if checker is None:
        return _error(channel, version, f"no checker implemented for kind {channel.kind!r}")
    return checker(channel, version)


# ---------------------------------------------------------------- CLI


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    parser.add_argument("--tag", required=True, help="git tag to verify against, e.g. v0.2.0")
    parser.add_argument("--channel", required=True, help="channel id from ci/release-channels.toml")
    parser.add_argument(
        "--force-stale",
        metavar="CHANNEL_ID",
        default="",
        help="force the named channel to report a synthetic stale version (red-path test)",
    )
    parser.add_argument(
        "--manifest",
        type=Path,
        default=None,
        help="override manifest path (defaults to ci/release-channels.toml)",
    )
    args = parser.parse_args()

    channels = load_channels(args.manifest) if args.manifest else load_channels()
    try:
        channel = find_channel(channels, args.channel)
    except Exception as exc:  # noqa: BLE001
        print(f"error: {exc}", file=sys.stderr)
        return 1

    force_stale = bool(args.force_stale) and args.force_stale == channel.id
    result = verify_channel(channel, args.tag, force_stale)

    status = "OK" if result.ok else "FAIL"
    # Ordering matters: the release-verify rollup (.github/workflows/release-verify.yml)
    # reads `head -n1 result.txt` and parses `<status> <channel_id>
    # expected=… observed=…`. Previously `detail:` was written to stderr;
    # the workflow redirects stderr into the same file via `> out 2>&1`,
    # and Python's unbuffered stderr landed above the block-buffered
    # stdout, so the first line was `detail: …` and the rollup misparsed
    # the status column (#1853).
    #
    # Fix both parts of the contract:
    #   1. Always print the machine-readable status line to stdout first,
    #      with explicit flush so the file offset reflects the write
    #      order even when stdout is block-buffered.
    #   2. Put the human detail on stdout on the second line (instead of
    #      stderr) so it can't outrun the status line through a different
    #      stream's buffering policy.
    print(
        f"{status} {result.channel_id} expected={result.expected} observed={result.observed}",
        flush=True,
    )
    print(f"detail: {result.detail}", flush=True)
    return 0 if result.ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
