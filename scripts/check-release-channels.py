#!/usr/bin/env python3
"""Post-release channel rollup — query every registry and fail on drift.

Invoked by `.github/workflows/release-verify.yml`, which runs on a daily
schedule and on `workflow_dispatch` for manual re-verification or red-path
dry-runs (`--force-stale <channel-id>`). It is deliberately not on the
release event: at tag time several channels have not been published yet,
so the rollup would be structurally red (ADR-0039).

Usage (workflow context):

    python3 scripts/check-release-channels.py --tag v0.2.0 --channel crates-io-cli

    # Forces the named channel to report a synthetic stale version, turning
    # the workflow red — used to verify the rollup actually fails loud.
    python3 scripts/check-release-channels.py --tag v0.2.0 --channel crates-io-cli \
        --force-stale crates-io-cli

Exits 0 on success, 1 on any failure (registry error, version mismatch,
visibility contract broken). Prints a single-line status to stdout followed
by any diagnostic lines on stderr.

The status word is `OK`, `FAIL`, or `PENDING`. `PENDING` means the channel
accepted the release but has not published it yet — a state only Chocolatey's
community moderation produces (ADR-0049). It exits 0, because no action here
can clear it, and the rollup renders it as its own row rather than as a pass.

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
    """Outcome of a single channel verification.

    `ok` answers "may the rollup stay green for this channel", which is not
    the same question as "has the release arrived". A channel that has
    handed the release to a third party who has not published it yet is
    neither: it sets `pending`, reporting OK-for-exit-status while the
    status column says PENDING rather than claiming a converged channel.
    Only Chocolatey needs it today (ADR-0049) — every other registry
    either publishes synchronously or exposes no state between "accepted"
    and "served", so for them `pending` is never set and the verdict stays
    the binary it always was.
    """

    channel_id: str
    ok: bool
    observed: str  # what we found on the registry (or "<error>")
    expected: str  # what the tag said we should find
    detail: str  # human-readable one-line summary
    pending: bool = False  # accepted upstream, not yet available to users

    @property
    def status(self) -> str:
        """Machine-readable status word — the first column the rollup parses."""
        if self.pending:
            return "PENDING"
        return "OK" if self.ok else "FAIL"


# ---------------------------------------------------------------- HTTP helpers


def _http_get_json(url: str, *, headers: dict[str, str] | None = None) -> dict:
    """GET a URL and parse the body as JSON. Raises on any HTTP error.

    `headers` adds to the defaults, for a registry that refuses a bare
    GET: the Snap Store answers HTTP 400 `bad-argument` ("Snap-Device-Series
    header is required.") without one, measured 2026-09-02.
    """
    request_headers = {"User-Agent": USER_AGENT, "Accept": "application/json"}
    if headers:
        request_headers.update(headers)
    req = urllib.request.Request(url, headers=request_headers)
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


# NuGet v2 servers represent an unlisted package by publishing it at this
# sentinel instant rather than by a separate flag; Chocolatey uses it for a
# version that is on the repository but still queued for moderation.
_NUGET_UNLISTED_PUBLISHED = "1900-01-01"


def _check_chocolatey(channel: Channel, version: str) -> CheckResult:
    """Verify Chocolatey, which has three states where other channels have two.

    A version can sit *on* the Community Repository without being
    installable: community moderation gates publication, and it took 28
    days for 0.2.1 and 54 for 0.5.0 (`Created` vs `PackageApprovedDate` on
    their own feed entries). So this checker reports three verdicts —
    OK / PENDING / FAIL — instead of folding the middle one into either
    neighbour. Rationale and measurements: ADR-0049.

    One probe answers all three: the v2 OData *entity* endpoint,
    `Packages(Id='<package>',Version='<version>')`. It addresses a single
    version directly, so unlike the collection endpoints it cannot paginate
    and cannot return a partial answer.

    - 404 — the repository does not hold the version (FAIL).
    - 200 with `Published` at the NuGet unlisted sentinel — held but not
      published to users (PENDING).
    - 200 with a real `Published` date — installable (OK).

    `Published` is the signal because it is the one that tracks what a user
    can actually install. The obvious alternatives do not:

    - `IsApproved` / `PackageStatus` report `false` / `Exempted` for
      versions that skip moderation review and are fully installable
      (`slack` 4.51.185, measured 2026-09-01). Keying the verdict to either
      reports a live release as stuck in moderation forever, and
      `PackageStatus` is an open enum besides.
    - `FindPackagesById()`, the feed `choco install` reads, applies
      `$filter` *after* paging: `Version eq '1.0.0'` for `slack` returns an
      empty first page and only yields the (listed, approved) version on
      page 3. Any package with more than one page of versions would have
      its published release reported as missing.

    A FAIL therefore means the push did not land — typically a `choco push`
    refused with 403 because an earlier version is still queued and blocks
    every newer push (#1852), which the release fan-out downgrades to a
    warning so one stalled channel of eight cannot fail a release. This
    rollup is the only other place that miss shows up.
    """
    page = f"https://community.chocolatey.org/packages/{channel.package}/{version}"
    entity = (
        "https://community.chocolatey.org/api/v2/"
        f"Packages(Id='{channel.package}',Version='{version}')"
    )
    try:
        text = _http_get_text(entity)
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            return _absent(
                channel,
                version,
                (
                    f"the Chocolatey Community Repository does not hold {version}. "
                    "A push refused with HTTP 403 leaves this state (an earlier "
                    "version still queued for moderation blocks every newer push, "
                    "#1852); publish it with `gh workflow run chocolatey-retry.yml "
                    f"-R koedame/chordsketch -f tag=v{version}` once the queue "
                    f"clears. {page}"
                ),
            )
        return _error(channel, version, f"Chocolatey feed error: HTTP {exc.code}")
    except Exception as exc:  # noqa: BLE001
        return _error(channel, version, f"Chocolatey feed error: {exc}")

    # Narrow regexes rather than an XML parser, matching `_check_maven_central`:
    # the document is small, well-known and attacker-uncontrolled, and the
    # regex carries no XXE surface.
    published = re.search(r"<d:Published[^>]*>([^<]*)</d:Published>", text)
    if published is None:
        # The verdict depends on this field, so a feed that stopped emitting
        # it must not be guessed at in either direction.
        return _error(
            channel,
            version,
            f"Chocolatey feed did not report Published for {version}: {entity}",
        )

    status = re.search(r"<d:PackageStatus>([^<]*)</d:PackageStatus>", text)
    # Reported for the human triaging the row, never used as the verdict.
    reported = status.group(1).strip() if status is not None else "not reported by the feed"

    if published.group(1).strip().startswith(_NUGET_UNLISTED_PUBLISHED):
        return CheckResult(
            channel_id=channel.id,
            ok=True,
            pending=True,
            observed=version,
            expected=version,
            detail=(
                f"accepted by the Chocolatey Community Repository but not yet "
                f"installable — awaiting community moderation "
                f"(PackageStatus={reported}). Nothing to do here: approval is a "
                f"Chocolatey moderator's action and has taken 28-54 days per "
                f"release. {page}"
            ),
        )

    return CheckResult(
        channel_id=channel.id,
        ok=True,
        observed=version,
        expected=version,
        detail=(
            f"published and installable from the Chocolatey Community Repository "
            f"(PackageStatus={reported}): {page}"
        ),
    )


# AUR package versions are `[epoch:]pkgver-pkgrel` (PKGBUILD(5)). Only
# `pkgver` tracks the upstream release: `pkgrel` counts rebuilds of the same
# release (`packaging/aur/PKGBUILD.template` pins it to 1) and `epoch` forces
# a version-ordering reset. Both are stripped before comparing against the
# tag, so a rebuild-only bump does not read as drift.
_AUR_VERSION = re.compile(r"\A(?:\d+:)?(?P<pkgver>.+)-[^-]+\Z")


def _check_aur(channel: Channel, version: str) -> CheckResult:
    """Verify the AUR package, which publishes the instant the push lands.

    `update-aur` in `post-release.yml` pushes a regenerated PKGBUILD over
    SSH; aurweb serves the new version from the same commit, so there is no
    third state between "the AUR has it" and "it does not" and the verdict
    stays the binary every non-Chocolatey channel uses (ADR-0049).

    The RPC v5 `info` endpoint answers with `resultcount: 0` and an empty
    `results` for a name it does not carry (measured 2026-09-02), which is
    the registry answering rather than a transport failure — reported as
    `<absent>`, not `<error>`.
    """
    query = urllib.parse.urlencode({"arg[]": channel.package})
    url = f"https://aur.archlinux.org/rpc/v5/info?{query}"
    try:
        payload = _http_get_json(url)
    except Exception as exc:  # noqa: BLE001
        return _error(channel, version, f"AUR RPC error: {exc}")

    results = payload.get("results") or []
    if not results:
        return _absent(
            channel,
            version,
            f"the AUR carries no package named {channel.package!r}. Re-run the "
            f"publish with `gh workflow run post-release.yml -R "
            f"koedame/chordsketch -f tag=v{version}`, which repeats the "
            f"update-aur SSH push.",
        )

    raw = str(results[0].get("Version") or "")
    match = _AUR_VERSION.match(raw)
    if match is None:
        # `pkgver-pkgrel` is the format the RPC documents; a value that does
        # not parse must not be silently compared as if it were a bare
        # version, because the mismatch would name the wrong problem.
        return _error(
            channel,
            version,
            f"AUR reported {raw!r}, which is not `[epoch:]pkgver-pkgrel`: {url}",
        )
    return _compare(channel, version, match.group("pkgver"))


# A snap that declares no default track is served from `latest`. The Snap
# Store expresses that as `default-track: null` (measured 2026-09-02 for
# chordsketch and for `hello`).
_SNAP_IMPLICIT_DEFAULT_TRACK = "latest"

# The risk level `snap install chordsketch` resolves to, and the one
# `update-snap` in `post-release.yml` uploads to (`snapcraft upload
# --release=stable`). README.md's install line is the bare `sudo snap
# install chordsketch`, so stable is what "published" means for this
# channel; candidate / beta / edge carry pre-release revisions whose drift
# from the tag is not a release failure.
_SNAP_PUBLISHED_RISK = "stable"


def _check_snap(channel: Channel, version: str) -> CheckResult:
    """Verify the Snap Store's stable channel on the snap's default track.

    `channel-map` lists one entry per (track, risk, architecture) that the
    store *serves* — a revision still in store review is simply absent from
    it, indistinguishable from one never uploaded (the endpoint exposes no
    "accepted but unreleased" field). There is therefore no observable
    middle state to report, and this checker stays binary rather than
    reaching for `PENDING` (ADR-0049): if the stable channel does not serve
    the release, `snap install chordsketch` does not install it, which is
    exactly what red means.

    Architectures are compared together rather than sampled. They can
    genuinely disagree — `hello` served 2.12 on riscv64 against 2.10
    everywhere else (measured 2026-09-02) — and an architecture left behind
    is a release users cannot install.
    """
    url = f"https://api.snapcraft.io/v2/snaps/info/{urllib.parse.quote(channel.package)}"
    try:
        payload = _http_get_json(url, headers={"Snap-Device-Series": "16"})
    except Exception as exc:  # noqa: BLE001
        return _error(channel, version, f"Snap Store API error: {exc}")

    track = str(payload.get("default-track") or _SNAP_IMPLICIT_DEFAULT_TRACK)
    served = sorted(
        {
            str(entry.get("version") or "<missing>")
            for entry in payload.get("channel-map") or []
            if isinstance(entry, dict)
            and (entry.get("channel") or {}).get("track") == track
            and (entry.get("channel") or {}).get("risk") == _SNAP_PUBLISHED_RISK
        }
    )
    if not served:
        return _absent(
            channel,
            version,
            f"the Snap Store serves nothing on {track}/{_SNAP_PUBLISHED_RISK} "
            f"for {channel.package}. Re-run the publish with `gh workflow run "
            f"post-release.yml -R koedame/chordsketch -f tag=v{version}`, "
            f"which repeats the `snapcraft upload --release=stable` step.",
        )

    # Joined without spaces: release-verify.yml's summary job pulls the
    # column out of the status line with `grep -oE 'observed=[^ ]+'`, so a
    # space here would truncate the table cell.
    return _compare(channel, version, ",".join(served))


def _check_cocoapods(channel: Channel, version: str) -> CheckResult:
    """Verify the CocoaPods trunk, which registers a push synchronously.

    `pod trunk push` returns once trunk holds the version, so — as with
    every registry other than Chocolatey — there is no moderation state to
    model and the verdict is binary (ADR-0049).

    `versions` is an array of `{name, created_at}` in push order, so the
    last entry is the newest release: chordsketch reads 0.2.1 → 0.2.2 →
    0.3.0 → 0.5.0 with ascending `created_at` (measured 2026-09-02). That
    keeps this check the same "the registry's newest is the tag" assertion
    every other channel makes, rather than the weaker "the tag is in there
    somewhere", which would stay green through a publish that never
    happened for the current release.
    """
    url = f"https://trunk.cocoapods.org/api/v1/pods/{urllib.parse.quote(channel.package)}"
    try:
        payload = _http_get_json(url)
    except Exception as exc:  # noqa: BLE001
        return _error(channel, version, f"CocoaPods trunk API error: {exc}")

    names = [
        str(entry.get("name") or "<missing>")
        for entry in payload.get("versions") or []
        if isinstance(entry, dict)
    ]
    if not names:
        return _absent(
            channel,
            version,
            f"the CocoaPods trunk holds no versions of {channel.package}. "
            f"Re-run the publish with `gh workflow run post-release.yml -R "
            f"koedame/chordsketch -f tag=v{version}`, which repeats the "
            f"`pod trunk push` step.",
        )
    return _compare(channel, version, names[-1])


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


def _absent(channel: Channel, expected: str, detail: str) -> CheckResult:
    """Red for a registry that answered, and answered that it does not
    hold this version.

    Distinct from `_error`'s `<error>`, which means the query itself
    failed. Keeping them apart is what stops a transport problem from
    being read as a missing publish, and vice versa — the same split
    `_check_chocolatey` introduced for its 404.
    """
    return CheckResult(
        channel_id=channel.id,
        ok=False,
        observed="<absent>",
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
    "chocolatey": _check_chocolatey,
    "aur": _check_aur,
    "snap": _check_snap,
    "cocoapods": _check_cocoapods,
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

    status = result.status
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
