#!/usr/bin/env python3
"""Tests for `_release_channels.load_channels` and
`check-release-channels.verify_channel`.

Uses only `unittest` and `unittest.mock` from stdlib so CI does not need a
`pip install` step to run. Live registry lookups are NOT exercised here —
those are best tested by running the real workflow against a real release
tag. This file covers the behaviors most likely to break under refactoring:

  1. Manifest validation (missing field, duplicate id, skip without reason,
     unknown kind)
  2. `verify_channel` on a skip channel returns OK without touching the
     registry
  3. `verify_channel` with `force_stale=True` returns a synthetic red
     result with the expected diagnostic string
  4. Per-kind dispatch mocks: one test per registry kind that asserts the
     HTTP URL the checker requests and the tag/observed comparison logic,
     so a silent refactor of URL construction cannot go unnoticed.
"""

from __future__ import annotations

import importlib.util
import subprocess
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

SCRIPTS_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS_DIR))

from _release_channels import Channel, ManifestError, load_channels  # noqa: E402

# Load the hyphenated script as a module so tests can import its symbols.
# The module must be registered in sys.modules BEFORE exec_module so that
# dataclasses' type introspection can find it (otherwise @dataclass fails
# with "NoneType has no attribute __dict__" during class definition).
_spec = importlib.util.spec_from_file_location(
    "check_release_channels", SCRIPTS_DIR / "check-release-channels.py"
)
assert _spec is not None and _spec.loader is not None
check_release_channels = importlib.util.module_from_spec(_spec)
sys.modules["check_release_channels"] = check_release_channels
_spec.loader.exec_module(check_release_channels)


# ---------------------------------------------------------------- helpers


def _write_manifest(tmp: Path, body: str) -> Path:
    path = tmp / "release-channels.toml"
    path.write_text(body, encoding="utf-8")
    return path


def _fake_channel(
    *,
    channel_id: str = "fake-channel",
    kind: str = "crates-io",
    package: str = "fake-pkg",
    expected_version: str = "tag",
    skip_reason: str = "",
) -> Channel:
    return Channel(
        id=channel_id,
        display=channel_id,
        kind=kind,
        package=package,
        expected_version=expected_version,
        required_secrets=(),
        skip_reason=skip_reason,
        notes="",
    )


# ---------------------------------------------------------------- manifest validation


class ManifestValidationTests(unittest.TestCase):
    def test_happy_path(self) -> None:
        """The real manifest in ci/release-channels.toml MUST parse."""
        channels = load_channels()
        self.assertGreater(len(channels), 0, "manifest should have at least one channel")
        # Every channel id must be unique (load_channels enforces this, but
        # we assert it here too as a regression guard).
        ids = [c.id for c in channels]
        self.assertEqual(len(ids), len(set(ids)), "channel ids must be unique")

    def test_missing_required_field(self) -> None:
        from tempfile import TemporaryDirectory

        with TemporaryDirectory() as td:
            path = _write_manifest(
                Path(td),
                '[[channels]]\nid = "x"\ndisplay = "X"\nkind = "crates-io"\n',
            )
            with self.assertRaises(ManifestError) as ctx:
                load_channels(path)
            self.assertIn("expected_version", str(ctx.exception))

    def test_duplicate_id(self) -> None:
        from tempfile import TemporaryDirectory

        with TemporaryDirectory() as td:
            path = _write_manifest(
                Path(td),
                """
[[channels]]
id = "dup"
display = "A"
kind = "crates-io"
package = "a"
expected_version = "tag"

[[channels]]
id = "dup"
display = "B"
kind = "crates-io"
package = "b"
expected_version = "tag"
""",
            )
            with self.assertRaises(ManifestError) as ctx:
                load_channels(path)
            self.assertIn("duplicate", str(ctx.exception))

    def test_unknown_kind(self) -> None:
        from tempfile import TemporaryDirectory

        with TemporaryDirectory() as td:
            path = _write_manifest(
                Path(td),
                """
[[channels]]
id = "x"
display = "X"
kind = "nonexistent-kind"
package = "p"
expected_version = "tag"
""",
            )
            with self.assertRaises(ManifestError) as ctx:
                load_channels(path)
            self.assertIn("unknown kind", str(ctx.exception))

    def test_skip_without_reason(self) -> None:
        from tempfile import TemporaryDirectory

        with TemporaryDirectory() as td:
            path = _write_manifest(
                Path(td),
                """
[[channels]]
id = "x"
display = "X"
kind = "manual"
expected_version = "skip"
""",
            )
            with self.assertRaises(ManifestError) as ctx:
                load_channels(path)
            self.assertIn("skip_reason", str(ctx.exception))


# ---------------------------------------------------------------- verify_channel


class VerifyChannelTests(unittest.TestCase):
    def test_skip_channel_is_ok_without_http(self) -> None:
        channel = _fake_channel(
            kind="manual", expected_version="skip", skip_reason="manual PR", package=""
        )
        # Intercept any real HTTP to prove the path didn't hit the network.
        with patch("check_release_channels._http_get_json") as mock_http:
            result = check_release_channels.verify_channel(channel, "v0.2.0", force_stale=False)
        self.assertTrue(result.ok)
        self.assertEqual(result.observed, "<manual>")
        mock_http.assert_not_called()

    def test_force_stale_returns_red(self) -> None:
        channel = _fake_channel()
        result = check_release_channels.verify_channel(channel, "v0.2.0", force_stale=True)
        self.assertFalse(result.ok)
        self.assertEqual(result.observed, "<forced-stale>")
        self.assertEqual(result.expected, "0.2.0")
        self.assertIn("synthetic failure", result.detail)

    def test_crates_io_version_match(self) -> None:
        channel = _fake_channel(kind="crates-io", package="chordsketch")
        with patch(
            "check_release_channels._http_get_json",
            return_value={"crate": {"max_version": "0.2.0"}},
        ) as mock_http:
            result = check_release_channels.verify_channel(channel, "v0.2.0", force_stale=False)
        self.assertTrue(result.ok, f"expected OK, got {result}")
        self.assertEqual(result.observed, "0.2.0")
        called_url = mock_http.call_args.args[0]
        self.assertEqual(called_url, "https://crates.io/api/v1/crates/chordsketch")

    def test_crates_io_version_mismatch(self) -> None:
        channel = _fake_channel(kind="crates-io", package="chordsketch")
        with patch(
            "check_release_channels._http_get_json",
            return_value={"crate": {"max_version": "0.1.9"}},
        ):
            result = check_release_channels.verify_channel(channel, "v0.2.0", force_stale=False)
        self.assertFalse(result.ok)
        self.assertEqual(result.observed, "0.1.9")
        self.assertIn("version mismatch", result.detail)

    def test_npm_scoped_package_url_encoding(self) -> None:
        channel = _fake_channel(kind="npm", package="@chordsketch/wasm")
        with patch(
            "check_release_channels._http_get_json",
            return_value={"version": "0.2.0"},
        ) as mock_http:
            check_release_channels.verify_channel(channel, "v0.2.0", force_stale=False)
        called_url = mock_http.call_args.args[0]
        # The scoped slash MUST be percent-encoded for the registry URL, or
        # npm returns a 404 for @chordsketch/wasm while happily serving
        # %40chordsketch%2Fwasm. This has bitten projects before.
        self.assertIn("%40chordsketch%2Fwasm", called_url)

    def test_ghcr_head_ok_path(self) -> None:
        channel = _fake_channel(kind="ghcr", package="koedame/chordsketch")
        with patch(
            "check_release_channels._ghcr_pull_token",
            return_value="fake-bearer-token",
        ) as mock_token, patch(
            "check_release_channels._http_head_ok",
            return_value=True,
        ) as mock_head:
            result = check_release_channels.verify_channel(channel, "v0.2.0", force_stale=False)
        self.assertTrue(result.ok)
        # Token must be fetched for the exact package being probed.
        mock_token.assert_called_once_with("koedame/chordsketch")
        # The image tag is the bare semver (`0.2.0`, not `v0.2.0`) —
        # `docker.yml` uses `metadata-action` with
        # `pattern={{version}}` which strips the `v` from the git tag.
        # Probing with `manifests/v0.2.0` 404'd on every release before
        # this fix (#2418). The probe must also pass a Bearer token
        # because GHCR requires auth even for public packages.
        called = mock_head.call_args
        self.assertEqual(
            called.args[0],
            "https://ghcr.io/v2/koedame/chordsketch/manifests/0.2.0",
        )
        self.assertEqual(called.kwargs.get("bearer_token"), "fake-bearer-token")
        # GHCR's manifest endpoint returns 404 without an Accept header
        # negotiating a manifest media type. Both OCI and Docker v2
        # formats must be advertised — `docker.yml` produces multi-arch
        # images that come back as either an OCI image-index or a
        # Docker manifest-list.
        accept = called.kwargs.get("accept", "")
        self.assertIn("application/vnd.oci.image.index.v1+json", accept)
        self.assertIn(
            "application/vnd.docker.distribution.manifest.list.v2+json",
            accept,
        )
        self.assertEqual(result.observed, "0.2.0")
        self.assertEqual(result.expected, "0.2.0")

    def test_ghcr_head_fail_path(self) -> None:
        channel = _fake_channel(kind="ghcr", package="koedame/chordsketch")
        with patch(
            "check_release_channels._ghcr_pull_token",
            return_value="fake-bearer-token",
        ), patch(
            "check_release_channels._http_head_ok",
            return_value=False,
        ):
            result = check_release_channels.verify_channel(channel, "v0.2.0", force_stale=False)
        self.assertFalse(result.ok)
        self.assertIn("not publicly reachable", result.detail)

    def test_ghcr_token_unavailable_reports_distinct_error(self) -> None:
        # When `_ghcr_pull_token` returns None (token endpoint
        # unreachable, or package is private), the manifest GET is
        # never attempted — the failure is attributed to the visibility
        # / token layer specifically so on-call can act on it directly
        # without inspecting the manifest URL.
        channel = _fake_channel(kind="ghcr", package="koedame/chordsketch")
        with patch(
            "check_release_channels._ghcr_pull_token",
            return_value=None,
        ), patch(
            "check_release_channels._http_head_ok",
        ) as mock_head:
            result = check_release_channels.verify_channel(channel, "v0.2.0", force_stale=False)
        self.assertFalse(result.ok)
        self.assertIn("pull token unavailable", result.detail)
        mock_head.assert_not_called()

    def test_pypi_mismatch(self) -> None:
        channel = _fake_channel(kind="pypi", package="chordsketch")
        with patch(
            "check_release_channels._http_get_json",
            return_value={"info": {"version": "0.1.0"}},
        ):
            result = check_release_channels.verify_channel(channel, "v0.2.0", force_stale=False)
        self.assertFalse(result.ok)
        self.assertEqual(result.observed, "0.1.0")

    def test_maven_invalid_package_format(self) -> None:
        channel = _fake_channel(kind="maven-central", package="no-colon")
        result = check_release_channels.verify_channel(channel, "v0.2.0", force_stale=False)
        self.assertFalse(result.ok)
        self.assertIn("group:artifact", result.detail)

    # ----------------------------------------------------------------
    # Per-kind mocked tests for the 6 checkers that previously had no
    # unit coverage. Regression guard for silent URL-construction or
    # response-parsing breaks. See #1516.
    # ----------------------------------------------------------------

    def test_docker_hub_match_bare_semver_tag(self) -> None:
        """Regression test for #2418: Docker Hub tags are bare semver
        (`0.2.0`, `0.2`, `latest`) — `docker.yml` uses metadata-action
        with `pattern={{version}}` which strips the `v` prefix from the
        git tag. The probe URL must therefore target `tags/0.2.0/`,
        and the API's `name` field comes back as `0.2.0` (without `v`).
        Earlier the probe targeted `tags/v0.2.0/` and 404'd on every
        release."""
        channel = _fake_channel(kind="docker-hub", package="koedame/chordsketch")
        with patch(
            "check_release_channels._http_get_json",
            return_value={"name": "0.2.0"},
        ) as mock_http:
            result = check_release_channels.verify_channel(channel, "v0.2.0", force_stale=False)
        self.assertTrue(result.ok, f"expected OK, got {result}")
        self.assertEqual(result.observed, "0.2.0")
        self.assertEqual(result.expected, "0.2.0")
        self.assertEqual(
            mock_http.call_args.args[0],
            "https://hub.docker.com/v2/repositories/koedame/chordsketch/tags/0.2.0/",
        )

    def test_docker_hub_mismatch(self) -> None:
        channel = _fake_channel(kind="docker-hub", package="koedame/chordsketch")
        with patch(
            "check_release_channels._http_get_json",
            return_value={"name": "0.1.9"},
        ):
            result = check_release_channels.verify_channel(channel, "v0.2.0", force_stale=False)
        self.assertFalse(result.ok)
        self.assertIn("tag mismatch", result.detail)

    def test_vscode_marketplace_match(self) -> None:
        channel = _fake_channel(
            kind="vscode-marketplace", package="koedame.chordsketch"
        )
        fake_payload = {
            "results": [
                {
                    "extensions": [
                        {
                            "versions": [
                                {"version": "0.2.0"},
                                {"version": "0.1.0"},
                            ]
                        }
                    ]
                }
            ]
        }

        # The Marketplace checker uses urlopen directly (POST), not
        # _http_get_json, so patch the module-level symbol.
        class _FakeResponse:
            def __init__(self, body):
                self._body = body

            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

            def read(self):
                import json as _json

                return _json.dumps(self._body).encode("utf-8")

        with patch(
            "check_release_channels.urllib.request.urlopen",
            return_value=_FakeResponse(fake_payload),
        ):
            result = check_release_channels.verify_channel(
                channel, "v0.2.0", force_stale=False
            )
        self.assertTrue(result.ok, f"expected OK, got {result}")
        self.assertEqual(result.observed, "0.2.0")

    def test_vscode_marketplace_no_results(self) -> None:
        channel = _fake_channel(
            kind="vscode-marketplace", package="koedame.chordsketch"
        )

        class _FakeResponse:
            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

            def read(self):
                return b'{"results": []}'

        with patch(
            "check_release_channels.urllib.request.urlopen",
            return_value=_FakeResponse(),
        ):
            result = check_release_channels.verify_channel(
                channel, "v0.2.0", force_stale=False
            )
        self.assertFalse(result.ok)
        self.assertIn("no results", result.detail)

    def test_homebrew_tap_match(self) -> None:
        channel = _fake_channel(kind="homebrew-tap", package="chordsketch")
        formula = """class Chordsketch < Formula
  desc "ChordPro tool"
  homepage "https://example.com"
  version "0.2.0"
  sha256 "abc"
end
"""
        with patch(
            "check_release_channels._http_get_text",
            return_value=formula,
        ) as mock_http:
            result = check_release_channels.verify_channel(
                channel, "v0.2.0", force_stale=False
            )
        self.assertTrue(result.ok, f"expected OK, got {result}")
        self.assertEqual(result.observed, "0.2.0")
        self.assertEqual(
            mock_http.call_args.args[0],
            "https://raw.githubusercontent.com/koedame/homebrew-tap/main/Formula/chordsketch.rb",
        )

    def test_homebrew_tap_no_version_line(self) -> None:
        channel = _fake_channel(kind="homebrew-tap", package="chordsketch")
        with patch(
            "check_release_channels._http_get_text",
            return_value="class Chordsketch < Formula\nend\n",
        ):
            result = check_release_channels.verify_channel(
                channel, "v0.2.0", force_stale=False
            )
        self.assertFalse(result.ok)
        self.assertIn("no version line", result.detail)

    def test_scoop_bucket_match(self) -> None:
        channel = _fake_channel(kind="scoop-bucket", package="chordsketch")
        manifest = '{"version": "0.2.0", "architecture": {}}'
        with patch(
            "check_release_channels._http_get_text",
            return_value=manifest,
        ) as mock_http:
            result = check_release_channels.verify_channel(
                channel, "v0.2.0", force_stale=False
            )
        self.assertTrue(result.ok, f"expected OK, got {result}")
        self.assertEqual(result.observed, "0.2.0")
        self.assertEqual(
            mock_http.call_args.args[0],
            "https://raw.githubusercontent.com/koedame/scoop-bucket/main/bucket/chordsketch.json",
        )

    def test_rubygems_match(self) -> None:
        channel = _fake_channel(kind="rubygems", package="chordsketch")
        with patch(
            "check_release_channels._http_get_json",
            return_value={"version": "0.2.0"},
        ) as mock_http:
            result = check_release_channels.verify_channel(
                channel, "v0.2.0", force_stale=False
            )
        self.assertTrue(result.ok, f"expected OK, got {result}")
        self.assertEqual(result.observed, "0.2.0")
        self.assertEqual(
            mock_http.call_args.args[0],
            "https://rubygems.org/api/v1/versions/chordsketch/latest.json",
        )

    def test_maven_central_match(self) -> None:
        # Maven groupId is `me.koeda` (reverse-DNS of the koeda.me
        # domain registered on Sonatype Central Portal), NOT
        # `io.github.koedame`. The probe also reads the canonical
        # `repo1.maven.org/maven2/<group>/<artifact>/maven-metadata.xml`
        # rather than `search.maven.org/solrsearch` because the latter
        # was empirically not indexing this artifact, surfacing as
        # `<error>` in the rollup table for every release until #2418.
        channel = _fake_channel(
            kind="maven-central", package="me.koeda:chordsketch"
        )
        fake_metadata = (
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n"
            "<metadata>\n"
            "  <groupId>me.koeda</groupId>\n"
            "  <artifactId>chordsketch</artifactId>\n"
            "  <versioning>\n"
            "    <latest>0.2.0</latest>\n"
            "    <release>0.2.0</release>\n"
            "    <versions>\n"
            "      <version>0.1.0</version>\n"
            "      <version>0.2.0</version>\n"
            "    </versions>\n"
            "    <lastUpdated>20260506110000</lastUpdated>\n"
            "  </versioning>\n"
            "</metadata>\n"
        )
        with patch(
            "check_release_channels._http_get_text",
            return_value=fake_metadata,
        ) as mock_http:
            result = check_release_channels.verify_channel(
                channel, "v0.2.0", force_stale=False
            )
        self.assertTrue(result.ok, f"expected OK, got {result}")
        self.assertEqual(result.observed, "0.2.0")
        called_url = mock_http.call_args.args[0]
        # The group's dots must be converted to slashes in the
        # repository path: `me.koeda` → `me/koeda/`.
        self.assertEqual(
            called_url,
            "https://repo1.maven.org/maven2/me/koeda/chordsketch/maven-metadata.xml",
        )

    def test_maven_central_metadata_missing_release(self) -> None:
        # If the metadata.xml is reachable but lacks a <release> element,
        # treat as error rather than silently passing on `<missing>`.
        channel = _fake_channel(
            kind="maven-central", package="me.koeda:chordsketch"
        )
        bad_metadata = (
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n"
            "<metadata>\n"
            "  <groupId>me.koeda</groupId>\n"
            "  <artifactId>chordsketch</artifactId>\n"
            "  <versioning>\n"
            "    <versions/>\n"
            "  </versioning>\n"
            "</metadata>\n"
        )
        with patch(
            "check_release_channels._http_get_text",
            return_value=bad_metadata,
        ):
            result = check_release_channels.verify_channel(
                channel, "v0.2.0", force_stale=False
            )
        self.assertFalse(result.ok)
        self.assertIn("missing <release>", result.detail)

    def test_maven_central_metadata_unreachable(self) -> None:
        # Network / 404 / other transport failure must surface as a
        # _error result rather than crashing the whole rollup.
        channel = _fake_channel(
            kind="maven-central", package="me.koeda:chordsketch"
        )
        with patch(
            "check_release_channels._http_get_text",
            side_effect=RuntimeError("HTTP 404"),
        ):
            result = check_release_channels.verify_channel(
                channel, "v0.2.0", force_stale=False
            )
        self.assertFalse(result.ok)
        self.assertIn("Maven Central metadata error", result.detail)


class CliOutputOrderingTests(unittest.TestCase):
    """Regression guard for #1853.

    The release-verify rollup reads `head -n1 result.txt` and expects the
    first word to be `OK` or `FAIL`. Before the fix the CLI wrote
    `detail: …` to stderr and the machine-readable status line to stdout;
    when the workflow redirected both streams into the same file with
    `> out 2>&1`, Python's stderr buffering landed the detail line first
    and the rollup parser saw `detail:` as the status column. Docker /
    GHCR / Maven Central silently showed `❌ detail:` on v0.2.2.

    This test invokes the script as a subprocess with the same shell
    redirection the workflow uses and asserts that the first line of the
    combined output is always the status line.
    """

    SCRIPT = SCRIPTS_DIR / "check-release-channels.py"

    def _run_with_combined_redirect(self, argv: list[str]) -> tuple[int, str]:
        # The workflow does `> out 2>&1`; emulate that by merging streams
        # so we observe whichever Python actually writes first.
        completed = subprocess.run(
            [sys.executable, str(self.SCRIPT), *argv],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            check=False,
            text=True,
        )
        return completed.returncode, completed.stdout

    def test_first_line_is_status_on_skip_channel(self) -> None:
        # `aur` is a `kind = "manual"` channel in the checked-in manifest,
        # so no HTTP request is made; this exercises the happy path
        # deterministically.
        rc, out = self._run_with_combined_redirect(
            ["--tag", "v0.0.0", "--channel", "aur"]
        )
        self.assertEqual(rc, 0)
        first = out.splitlines()[0]
        self.assertTrue(
            first.startswith("OK aur "),
            f"first line must start with the status word; got {first!r}",
        )
        self.assertIn("expected=", first)
        self.assertIn("observed=", first)

    def test_first_line_is_status_on_force_stale(self) -> None:
        # `--force-stale` produces a synthetic red result and exits with
        # status 1; the detail line must not outrun the status line.
        rc, out = self._run_with_combined_redirect(
            [
                "--tag",
                "v0.0.0",
                "--channel",
                "npm-wasm",
                "--force-stale",
                "npm-wasm",
            ]
        )
        self.assertEqual(rc, 1)
        first = out.splitlines()[0]
        self.assertTrue(
            first.startswith("FAIL npm-wasm "),
            f"first line must start with the status word; got {first!r}",
        )


if __name__ == "__main__":
    unittest.main()
