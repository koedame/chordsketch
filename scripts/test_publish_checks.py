#!/usr/bin/env python3
"""Tests for `scripts/_publish_checks.py`.

The module decides whether a package could be published, for every pull
request and for the release preflight alike. These tests pin the decisions
that would otherwise only be exercised by a registry refusing an upload:

  1. Every package the release manifest lists has a publish definition, and
     every definition is a real package of this repository.
  2. crates.io's upload limit and the metadata every crate must carry.
  3. What must never be in a package: forbidden files, leaked credentials
     and large files nobody declared.
  4. A publish tool's warnings are problems, except the two cargo prints on
     every dry run of an already-published version.
  5. npm entry points, README and dependencies a user could not resolve.
  6. What the VS Code Marketplace / Open VSX, PyPI, RubyGems, Maven
     Central and the container registries require of their artifacts,
     including the VSIX set the publish jobs upload and the JNA layout the
     published jars lacked up to 0.6.0.
  7. With npm on PATH, `npm publish --dry-run` really does warn about the
     `repository.url` form that npm rewrote on four packages in 0.6.0, and
     the check turns that warning into a failure.
  8. The napi check narrows to the packages a resumed publish still has
     to upload, since npm 11 refuses a dry run over a published version.

Stdlib `unittest` only. Only the last group runs a tool (npm, offline).
"""

from __future__ import annotations

import contextlib
import io
import json
import re
import shutil
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest import mock

SCRIPTS_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS_DIR))

import _publish_checks as checks  # noqa: E402
from _release_channels import load_channels  # noqa: E402

MIB = checks.MIB


def packed(path: str, data: bytes = b"", size: int | None = None) -> checks.PackedFile:
    return checks.PackedFile(path, len(data) if size is None else size, data)


def write_tarball(path: Path, top: str, files: dict[str, bytes]) -> None:
    with tarfile.open(path, "w:gz") as archive:
        for name, data in files.items():
            info = tarfile.TarInfo(f"{top}/{name}")
            info.size = len(data)
            archive.addfile(info, io.BytesIO(data))


class DefinitionCoverageTest(unittest.TestCase):
    def test_when_the_manifest_lists_an_npm_package_it_has_a_publish_definition(self) -> None:
        npm = {c.package for c in load_channels() if c.kind == "npm"}
        self.assertTrue(npm)
        self.assertEqual(npm - set(checks.NPM_PACKAGES), set())

    def test_when_an_npm_package_has_a_publish_definition_the_manifest_lists_it(self) -> None:
        npm = {c.package for c in load_channels() if c.kind == "npm"}
        self.assertEqual(set(checks.NPM_PACKAGES) - npm, set())

    def test_when_an_npm_package_is_defined_its_directory_holds_that_package(self) -> None:
        for name, package in checks.NPM_PACKAGES.items():
            manifest = json.loads((checks.REPO_ROOT / package.directory / "package.json").read_text())
            self.assertEqual(manifest["name"], name)

    def test_when_the_manifest_lists_a_crate_it_has_a_publish_definition_and_vice_versa(self) -> None:
        crates = {c.package for c in load_channels() if c.kind == "crates-io"}
        self.assertEqual(crates, set(checks.CRATES))

    def test_when_a_large_file_is_declared_the_file_exists_in_the_source_tree(self) -> None:
        for crate in checks.CRATES.values():
            directory = checks.REPO_ROOT / "crates" / crate.name.removeprefix("chordsketch-")
            for glob in crate.large_files:
                self.assertTrue(list(directory.glob(glob)), f"{crate.name}: {glob}")

    def test_when_napi_packages_are_staged_the_staging_script_exists_and_is_executable(self) -> None:
        script = checks.REPO_ROOT / "crates/napi/scripts/stage-release-tarballs.sh"
        self.assertTrue(script.is_file())
        self.assertTrue(script.stat().st_mode & 0o111)


class CrateSizeTest(unittest.TestCase):
    def test_when_a_crate_is_exactly_at_the_limit_it_passes(self) -> None:
        self.assertEqual(checks.crate_size_problems({"chordsketch": checks.CRATES_IO_MAX_UPLOAD}), [])

    def test_when_a_crate_is_over_the_limit_it_is_named_with_its_size(self) -> None:
        # chordsketch-render-pdf 0.6.0 packaged to 15.6 MiB and crates.io answered 413.
        problems = checks.crate_size_problems({"chordsketch-chordpro": 316_000, "chordsketch-render-pdf": 16_382_393})
        self.assertEqual(len(problems), 1)
        self.assertIn("chordsketch-render-pdf packages to 15.6 MiB", problems[0])

    def test_when_packaging_left_no_crate_file_it_is_not_assumed_to_fit(self) -> None:
        problems = checks.crate_size_problems({"chordsketch-mcp": None})
        self.assertEqual(len(problems), 1)
        self.assertIn("chordsketch-mcp", problems[0])


class CrateMetadataTest(unittest.TestCase):
    COMPLETE = {
        "name": "chordsketch",
        "description": "d",
        "license": "MIT",
        "repository": "https://github.com/koedame/chordsketch",
        "readme": "README.md",
        "publish": None,
    }

    def test_when_every_field_is_present_the_crate_passes(self) -> None:
        self.assertEqual(checks.crate_metadata_problems([self.COMPLETE], ["chordsketch"]), [])

    def test_when_a_crate_has_no_readme_it_is_reported(self) -> None:
        problems = checks.crate_metadata_problems([{**self.COMPLETE, "readme": None}], ["chordsketch"])
        self.assertEqual(problems, ["chordsketch has no `readme` in its Cargo.toml"])

    def test_when_a_crate_uses_a_license_file_instead_of_a_license_it_passes(self) -> None:
        package = {**self.COMPLETE, "license": None, "license_file": "LICENSE"}
        self.assertEqual(checks.crate_metadata_problems([package], ["chordsketch"]), [])

    def test_when_a_crate_sets_publish_false_it_is_reported(self) -> None:
        problems = checks.crate_metadata_problems([{**self.COMPLETE, "publish": []}], ["chordsketch"])
        self.assertIn("publish = false", problems[0])

    def test_when_the_named_readme_is_not_packaged_it_is_reported(self) -> None:
        problems = checks.crate_readme_problems("chordsketch", "README.md", [packed("src/lib.rs")])
        self.assertEqual(len(problems), 1)


class ContentTest(unittest.TestCase):
    def test_when_a_package_carries_a_dotenv_file_in_a_subdirectory_it_is_reported(self) -> None:
        problems = checks.content_problems("pkg", [packed("tests/fixtures/.env", b"X=1")], ())
        self.assertEqual(len(problems), 1)
        self.assertIn("tests/fixtures/.env", problems[0])

    def test_when_a_file_contains_a_private_key_it_is_reported(self) -> None:
        key = b"-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n"
        problems = checks.content_problems("pkg", [packed("src/data.txt", key)], ())
        self.assertEqual(problems, ["pkg would publish what looks like a private key in `src/data.txt`"])

    def test_when_a_file_contains_an_npm_token_it_is_reported(self) -> None:
        problems = checks.content_problems("pkg", [packed("dist/index.js", b'token="npm_' + b"a" * 36 + b'"')], ())
        self.assertIn("npm token", problems[0])

    def test_when_an_undeclared_file_is_over_one_mib_it_is_reported(self) -> None:
        problems = checks.content_problems("pkg", [packed("tests/golden/out.pdf", size=5 * MIB)], ())
        self.assertEqual(len(problems), 1)
        self.assertIn("`tests/golden/out.pdf` (5.0 MiB)", problems[0])

    def test_when_a_large_file_is_declared_it_passes(self) -> None:
        files = [packed("assets/font.otf", size=6 * MIB)]
        self.assertEqual(checks.content_problems("pkg", files, ("assets/font.otf",)), [])

    def test_when_a_declared_large_file_is_no_longer_packed_the_declaration_is_reported_as_stale(self) -> None:
        problems = checks.content_problems("pkg", [packed("assets/other.otf", size=10)], ("assets/font.otf",))
        self.assertEqual(len(problems), 1)
        self.assertIn("stale", problems[0])

    def test_when_a_declared_file_shrinks_below_one_mib_it_still_passes(self) -> None:
        self.assertEqual(checks.content_problems("pkg", [packed("dist/index.js.map", size=MIB - 1)], ("dist/index.js.map",)), [])

    def test_when_a_file_only_mentions_a_forbidden_name_it_passes(self) -> None:
        files = [packed("src/env.rs", b"// reads .env files"), packed("src/key.rs", b"fn key() {}")]
        self.assertEqual(checks.content_problems("pkg", files, ()), [])


class ToolWarningTest(unittest.TestCase):
    def test_when_cargo_warns_about_a_yanked_lock_entry_it_is_a_problem(self) -> None:
        output = (
            "   Packaging chordsketch v0.6.0\n"
            "warning: package `fastrand v2.4.0` in Cargo.lock is yanked in registry `crates-io`\n"
        )
        problems = checks.tool_warnings("cargo", output, prefix=checks.CARGO_WARNING, expected=checks.EXPECTED_CARGO_WARNINGS)
        self.assertEqual(len(problems), 1)
        self.assertIn("is yanked", problems[0])

    def test_when_cargo_colours_its_output_a_yanked_lock_entry_is_still_a_problem(self) -> None:
        # CI sets CARGO_TERM_COLOR=always; the first run of this check let the
        # yanked warning through because the colour codes hid the prefix.
        output = "\x1b[1m\x1b[33mwarning\x1b[0m: package `fastrand v2.4.0` in Cargo.lock is yanked in registry `crates-io`\n"
        problems = checks.tool_warnings("cargo", output, prefix=checks.CARGO_WARNING, expected=checks.EXPECTED_CARGO_WARNINGS)
        self.assertEqual(problems, ["cargo warned: warning: package `fastrand v2.4.0` in Cargo.lock is yanked in registry `crates-io`"])

    def test_when_cargo_dry_runs_an_already_published_version_its_two_notices_are_not_problems(self) -> None:
        output = (
            "warning: crate chordsketch-chordpro@0.6.0 already exists on crates.io index\n"
            "warning: aborting upload due to dry run\n"
        )
        problems = checks.tool_warnings("cargo", output, prefix=checks.CARGO_WARNING, expected=checks.EXPECTED_CARGO_WARNINGS)
        self.assertEqual(problems, [])

    def test_when_npm_rewrites_the_package_json_while_publishing_it_is_a_problem(self) -> None:
        output = (
            'npm warn publish npm auto-corrected some errors in your package.json when publishing.  Please run "npm pkg fix" to address these errors.\n'
            "npm notice package: tree-sitter-chordpro@0.6.0\n"
        )
        self.assertEqual(len(checks.tool_warnings("npm", output, prefix=checks.NPM_WARNING)), 1)


class NpmManifestTest(unittest.TestCase):
    MANIFEST = {
        "name": "@chordsketch/example",
        "description": "d",
        "license": "MIT",
        "repository": {"type": "git", "url": "git+https://github.com/koedame/chordsketch.git"},
        "main": "./dist/index.cjs",
        "exports": {".": {"import": {"types": "./dist/index.d.ts", "default": "./dist/index.js"}}, "./package.json": "./package.json"},
    }
    FILES = [packed(p) for p in ("package.json", "README.md", "dist/index.cjs", "dist/index.js", "dist/index.d.ts")]

    def test_when_every_entry_point_is_packed_the_package_passes(self) -> None:
        self.assertEqual(checks.npm_manifest_problems(self.MANIFEST, self.FILES), [])

    def test_when_an_exports_target_is_not_packed_it_is_reported(self) -> None:
        files = [f for f in self.FILES if f.path != "dist/index.d.ts"]
        problems = checks.npm_manifest_problems(self.MANIFEST, files)
        self.assertEqual(problems, ["@chordsketch/example points `./dist/index.d.ts` at a file the packed tarball does not contain"])

    def test_when_main_names_a_directory_with_an_index_it_passes(self) -> None:
        manifest = {**self.MANIFEST, "main": "bindings/node", "exports": None}
        files = [*self.FILES, packed("bindings/node/index.js")]
        self.assertEqual(checks.npm_manifest_problems(manifest, files), [])

    def test_when_the_package_has_no_readme_it_is_reported(self) -> None:
        files = [f for f in self.FILES if f.path != "README.md"]
        self.assertIn("@chordsketch/example would publish without a README", checks.npm_manifest_problems(self.MANIFEST, files))

    def test_when_the_package_has_no_repository_it_is_reported(self) -> None:
        manifest = {k: v for k, v in self.MANIFEST.items() if k != "repository"}
        self.assertIn("@chordsketch/example has no `repository` in its package.json", checks.npm_manifest_problems(manifest, self.FILES))


class NpmDependencyTest(unittest.TestCase):
    @staticmethod
    def never_published(name: str, spec: str) -> bool:
        return False

    def test_when_a_dependency_points_at_a_local_path_it_is_reported(self) -> None:
        manifest = {"name": "a", "dependencies": {"@chordsketch/react": "file:../react"}}
        problems = checks.npm_dependency_problems(manifest, {}, lambda n, s: True)
        self.assertEqual(len(problems), 1)
        self.assertIn("file:../react", problems[0])

    def test_when_a_dependency_is_pinned_to_a_package_released_together_it_passes_without_asking_the_registry(self) -> None:
        manifest = {"name": "@chordsketch/node", "optionalDependencies": {"@chordsketch/node-darwin-arm64": "0.7.0"}}
        released = {"@chordsketch/node-darwin-arm64": "0.7.0"}
        self.assertEqual(checks.npm_dependency_problems(manifest, released, self.never_published), [])

    def test_when_a_dependency_is_the_caret_range_of_a_package_released_together_it_passes_without_asking_the_registry(self) -> None:
        manifest = {
            "name": "@chordsketch/react",
            "dependencies": {"@chordsketch/wasm": "^0.7.0"},
            "peerDependencies": {"@chordsketch/wasm-export": "^0.7.0"},
        }
        released = {"@chordsketch/wasm": "0.7.0", "@chordsketch/wasm-export": "0.7.0"}
        self.assertEqual(checks.npm_dependency_problems(manifest, released, self.never_published), [])

    def test_when_a_caret_range_names_another_version_than_the_one_released_together_the_registry_is_asked(self) -> None:
        manifest = {"name": "@chordsketch/vue", "dependencies": {"@chordsketch/wasm": "^0.6.0"}}
        problems = checks.npm_dependency_problems(manifest, {"@chordsketch/wasm": "0.7.0"}, self.never_published)
        self.assertEqual(problems, ["@chordsketch/vue dependencies `@chordsketch/wasm@^0.6.0` matches no version published on npm"])

    def test_when_no_published_version_satisfies_a_range_it_is_reported(self) -> None:
        manifest = {"name": "@chordsketch/react", "peerDependencies": {"@chordsketch/wasm-export": "^9.0.0"}}
        problems = checks.npm_dependency_problems(manifest, {"@chordsketch/wasm-export": "0.6.0"}, self.never_published)
        self.assertEqual(problems, ["@chordsketch/react peerDependencies `@chordsketch/wasm-export@^9.0.0` matches no version published on npm"])

    def test_when_a_published_version_satisfies_a_range_it_passes(self) -> None:
        manifest = {"name": "@chordsketch/vue", "dependencies": {"vue": ">=3.3"}}
        self.assertEqual(checks.npm_dependency_problems(manifest, {}, lambda n, s: (n, s) == ("vue", ">=3.3")), [])

    def test_when_a_dependency_uses_github_shorthand_it_is_reported(self) -> None:
        manifest = {"name": "a", "dependencies": {"x": "someone/x"}}
        self.assertEqual(len(checks.npm_dependency_problems(manifest, {}, lambda n, s: True)), 1)


class NapiSubsetTest(unittest.TestCase):
    """A publish that resumes after some napi packages went out checks only the rest.

    npm 11's `publish --dry-run` refuses a version that is already
    published, so checking all six again would fail every resumed publish.
    """

    def run_check(self, packages: list[str] | None) -> tuple[list[str], list[list[str]]]:
        checked: list[str] = []
        smoked: list[list[str]] = []
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            for name in checks.NPM_PACKAGES:
                if checks.is_napi(name):
                    (directory / checks.npm_tarball_name(name, "1.2.0")).write_bytes(b"")
            with (
                mock.patch.object(checks, "npm_tarball_problems", side_effect=lambda package, *a, **k: checked.append(package.name) or []),
                mock.patch.object(checks, "npm_smoke_problems", side_effect=lambda package, tarballs, *a: smoked.append([t.name for t in tarballs]) or []),
                mock.patch.object(checks, "host_napi_triple", return_value="linux-x64-gnu"),
            ):
                self.assertEqual(checks.napi_problems(directory, "1.2.0", {}, packages=packages), [])
        return checked, smoked

    def test_when_no_subset_is_given_all_six_are_checked_and_the_host_pair_is_smoked(self) -> None:
        checked, smoked = self.run_check(None)
        self.assertEqual(len(checked), 6)
        self.assertEqual(smoked, [["chordsketch-node-linux-x64-gnu-1.2.0.tgz", "chordsketch-node-1.2.0.tgz"]])

    def test_when_a_subset_is_given_only_those_are_checked(self) -> None:
        checked, smoked = self.run_check(["@chordsketch/node-darwin-arm64"])
        self.assertEqual(checked, ["@chordsketch/node-darwin-arm64"])
        self.assertEqual(smoked, [])

    def test_when_only_the_resolver_is_left_it_is_smoked_against_the_published_platform_package(self) -> None:
        checked, smoked = self.run_check(["@chordsketch/node"])
        self.assertEqual(checked, ["@chordsketch/node"])
        self.assertEqual(smoked, [["chordsketch-node-1.2.0.tgz"]])


class NamingTest(unittest.TestCase):
    def test_when_npm_packs_a_scoped_package_the_tarball_drops_the_at_sign(self) -> None:
        self.assertEqual(checks.npm_tarball_name("@chordsketch/node-win32-x64-msvc", "0.6.0"), "chordsketch-node-win32-x64-msvc-0.6.0.tgz")
        self.assertEqual(checks.npm_tarball_name("tree-sitter-chordpro", "0.6.0"), "tree-sitter-chordpro-0.6.0.tgz")

    def test_when_a_package_only_shares_the_napi_prefix_it_is_not_a_napi_package(self) -> None:
        self.assertTrue(checks.is_napi("@chordsketch/node-win32-x64-msvc"))
        self.assertFalse(checks.is_napi("@chordsketch/nodejs-helpers"))

    def test_when_a_crate_is_read_from_its_tarball_paths_are_relative_to_the_crate_root(self) -> None:
        with tempfile.TemporaryDirectory() as scratch:
            path = Path(scratch) / "x-1.0.0.crate"
            write_tarball(path, "x-1.0.0", {"Cargo.toml": b"[package]", "src/lib.rs": b""})
            self.assertEqual(sorted(f.path for f in checks.read_tarball(path)), ["Cargo.toml", "src/lib.rs"])


def write_zip(path: Path, files: dict[str, bytes]) -> None:
    import zipfile

    with zipfile.ZipFile(path, "w") as archive:
        for name, data in files.items():
            archive.writestr(name, data)


def png(width: int, height: int) -> bytes:
    return checks.PNG_SIGNATURE + b"\x00\x00\x00\rIHDR" + width.to_bytes(4, "big") + height.to_bytes(4, "big") + b"\x08\x06\x00\x00\x00"


class VsixTest(unittest.TestCase):
    MANIFEST = {
        "name": "chordsketch",
        "publisher": "koedame",
        "version": "1.2.0",
        "license": "MIT",
        "repository": {"type": "git", "url": "https://github.com/koedame/chordsketch.git"},
        "engines": {"vscode": "^1.85.0"},
        "icon": "icon.png",
    }
    LINUX = checks.VSCODE_TARGETS[0]

    def vsix(self, scratch: Path, name: str, manifest: dict, extra: dict[str, bytes], target: str = "") -> Path:
        path = scratch / name
        vsixmanifest = f'<Identity Id="chordsketch" TargetPlatform="{target}" />'.encode() if target else b"<Identity />"
        engine = {glob: b"\0asm" for glob in checks.VSIX_LARGE_FILES}
        write_zip(path, {"extension.vsixmanifest": vsixmanifest, "extension/package.json": json.dumps(manifest).encode(), "extension/icon.png": png(256, 256), **engine, **extra})
        return path

    def test_when_the_manifest_is_complete_and_the_icon_is_a_large_png_the_universal_vsix_passes(self) -> None:
        with tempfile.TemporaryDirectory() as scratch:
            self.assertEqual(checks.vsix_problems(self.vsix(Path(scratch), "chordsketch-1.2.0.vsix", self.MANIFEST, {}), None), [])

    def test_when_the_version_carries_a_prerelease_suffix_the_marketplace_would_refuse_it(self) -> None:
        problems = checks.vsix_manifest_problems("x", {**self.MANIFEST, "version": "1.2.0-beta.1"}, [packed("extension/icon.png", png(256, 256))])
        self.assertEqual(len(problems), 1)
        self.assertIn("major.minor.patch", problems[0])

    def test_when_the_icon_is_an_svg_it_is_reported(self) -> None:
        problems = checks.vsix_manifest_problems("x", {**self.MANIFEST, "icon": "icon.svg"}, [packed("extension/icon.svg", b"<svg/>")])
        self.assertIn("not a PNG", problems[0])

    def test_when_the_icon_is_smaller_than_128_pixels_it_is_reported(self) -> None:
        problems = checks.vsix_manifest_problems("x", self.MANIFEST, [packed("extension/icon.png", png(64, 64))])
        self.assertIn("64x64", problems[0])

    def test_when_the_manifest_has_no_license_open_vsx_would_refuse_it(self) -> None:
        manifest = {k: v for k, v in self.MANIFEST.items() if k != "license"}
        self.assertIn("x has no `license` in its package.json", checks.vsix_manifest_problems("x", manifest, [packed("extension/icon.png", png(256, 256))]))

    def test_when_a_platform_vsix_lacks_its_language_server_it_is_reported(self) -> None:
        with tempfile.TemporaryDirectory() as scratch:
            path = self.vsix(Path(scratch), "chordsketch-linux-x64-1.2.0.vsix", self.MANIFEST, {}, target="linux-x64")
            problems = checks.vsix_problems(path, self.LINUX)
        self.assertEqual(len(problems), 1)
        self.assertIn("extension/server/linux-x64/chordsketch-lsp", problems[0])

    def test_when_a_platform_vsix_also_bundles_another_targets_server_it_is_reported(self) -> None:
        servers = {"extension/server/linux-x64/chordsketch-lsp": b"elf", "extension/server/win32-x64/chordsketch-lsp.exe": b"pe"}
        with tempfile.TemporaryDirectory() as scratch:
            path = self.vsix(Path(scratch), "chordsketch-linux-x64-1.2.0.vsix", self.MANIFEST, servers, target="linux-x64")
            problems = checks.vsix_problems(path, self.LINUX)
        self.assertEqual(len(problems), 1)
        self.assertIn("win32-x64", problems[0])

    def test_when_a_platform_vsix_is_not_marked_for_its_target_it_is_reported(self) -> None:
        servers = {"extension/server/linux-x64/chordsketch-lsp": b"elf"}
        with tempfile.TemporaryDirectory() as scratch:
            path = self.vsix(Path(scratch), "chordsketch-linux-x64-1.2.0.vsix", self.MANIFEST, servers, target="darwin-x64")
            problems = checks.vsix_problems(path, self.LINUX)
        self.assertEqual(problems, ["chordsketch-linux-x64-1.2.0.vsix is not marked as the linux-x64 build in extension.vsixmanifest"])

    def test_when_a_target_vsix_is_missing_from_the_set_the_publish_jobs_would_ship_an_incomplete_release(self) -> None:
        with tempfile.TemporaryDirectory() as scratch:
            directory = Path(scratch)
            (directory / "package.json").write_text(json.dumps(self.MANIFEST))
            self.vsix(directory, "chordsketch-1.2.0.vsix", self.MANIFEST, {})
            problems = checks.vsix_set_problems(directory)
        self.assertEqual(len(problems), 1)
        self.assertIn("missing VSIX(es)", problems[0])
        self.assertIn("chordsketch-alpine-arm64-1.2.0.vsix", problems[0])


class PythonDistributionTest(unittest.TestCase):
    METADATA = "Metadata-Version: 2.4\nName: chordsketch\nVersion: 1.2.0\nSummary: s\nLicense: MIT\nRequires-Python: >=3.8\nProject-URL: Homepage, https://github.com/koedame/chordsketch\n\n# chordsketch\n"

    def test_when_the_core_metadata_is_complete_it_passes(self) -> None:
        self.assertEqual(checks.python_metadata_problems("w", checks.core_metadata(self.METADATA), True), [])

    def test_when_the_version_is_not_pep_440_pypi_would_refuse_it(self) -> None:
        metadata = checks.core_metadata(self.METADATA.replace("Version: 1.2.0", "Version: 1.2.0-beta"))
        self.assertEqual(checks.python_metadata_problems("w", metadata, True), ["w version `1.2.0-beta` is not a PEP 440 version PyPI accepts"])

    def test_when_there_is_no_long_description_it_is_reported(self) -> None:
        self.assertIn("long description", checks.python_metadata_problems("w", checks.core_metadata(self.METADATA), False)[0])

    def test_when_a_wheel_carries_a_bare_linux_tag_pypi_would_refuse_it(self) -> None:
        with tempfile.TemporaryDirectory() as scratch:
            dist = Path(scratch)
            wheel = dist / "chordsketch-1.2.0-py3-none-linux_x86_64.whl"
            write_zip(wheel, {"chordsketch-1.2.0.dist-info/METADATA": self.METADATA.encode(), "chordsketch/_native/libchordsketch_ffi.so": b"elf"})
            problems = checks.python_dist_problems(dist, runner=lambda cmd, cwd, env=None: checks.subprocess.CompletedProcess(cmd, 0, ""))
        self.assertIn("chordsketch-1.2.0-py3-none-linux_x86_64.whl has a bare linux platform tag, which PyPI refuses; build it manylinux-compliant", problems)
        self.assertIn(f"no sdist in {dist}", problems)


class GemTest(unittest.TestCase):
    SPEC = {
        "name": "chordsketch",
        "version": "1.2.0",
        "summary": "s",
        "authors": ["koedame"],
        "licenses": ["MIT"],
        "homepage": "https://github.com/koedame/chordsketch",
        "files": ["lib/chordsketch.rb", *checks.GEM_PLATFORM_LIBRARIES],
    }

    def test_when_every_attribute_and_platform_library_is_present_it_passes(self) -> None:
        self.assertEqual(checks.gem_spec_problems("g", self.SPEC), [])

    def test_when_a_platform_library_is_not_in_the_gem_that_platform_is_named(self) -> None:
        spec = {**self.SPEC, "files": [f for f in self.SPEC["files"] if "windows" not in f]}
        problems = checks.gem_spec_problems("g", spec)
        self.assertEqual(len(problems), 1)
        self.assertIn("lib/x86_64-windows/chordsketch_ffi.dll", problems[0])

    def test_when_the_gemspec_has_no_license_it_is_reported(self) -> None:
        self.assertEqual(checks.gem_spec_problems("g", {**self.SPEC, "licenses": []}), ["g has no `licenses` in its gemspec"])


class MavenTest(unittest.TestCase):
    POM = b"""<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <groupId>me.koeda</groupId><artifactId>chordsketch</artifactId><version>1.2.0</version>
  <name>ChordSketch</name><description>d</description><url>https://github.com/koedame/chordsketch</url>
  <licenses><license><name>MIT</name></license></licenses>
  <developers><developer><name>koedame</name></developer></developers>
  <scm><url>u</url><connection>c</connection><developerConnection>d</developerConnection></scm>
  <dependencies>
    <dependency><groupId>net.java.dev.jna</groupId><artifactId>jna</artifactId><version>5.17.0</version><scope>runtime</scope></dependency>
    <dependency><groupId>org.jetbrains.kotlin</groupId><artifactId>kotlin-test</artifactId><version>1.9.25</version><scope>test</scope></dependency>
  </dependencies>
</project>"""

    def test_when_the_pom_has_everything_maven_central_requires_it_passes(self) -> None:
        self.assertEqual(checks.pom_problems("p", self.POM), [])

    def test_when_the_pom_has_no_scm_connection_it_is_reported(self) -> None:
        pom = self.POM.replace(b"<connection>c</connection>", b"")
        self.assertEqual(checks.pom_problems("p", pom), ["p has no <scm/connection>"])

    def test_when_the_version_is_a_snapshot_maven_central_would_refuse_it(self) -> None:
        pom = self.POM.replace(b"<artifactId>chordsketch</artifactId><version>1.2.0</version>", b"<artifactId>chordsketch</artifactId><version>1.2.0-SNAPSHOT</version>")
        self.assertIn("p is a SNAPSHOT, which Maven Central refuses", checks.pom_problems("p", pom))

    def test_when_a_dependency_is_test_scoped_it_is_left_off_the_smoke_classpath(self) -> None:
        self.assertEqual(checks.pom_runtime_dependencies(self.POM), [("net.java.dev.jna", "jna", "5.17.0")])

    def test_when_the_jar_keeps_the_download_artifacts_prefix_jna_cannot_find_the_library(self) -> None:
        # Every published jar up to 0.6.0 carried jni-linux-x86-64/... instead of linux-x86-64/...
        with tempfile.TemporaryDirectory() as scratch:
            repository = Path(scratch)
            directory = repository / "me/koeda/chordsketch/1.2.0"
            directory.mkdir(parents=True)
            for name in ("chordsketch-1.2.0.pom", "chordsketch-1.2.0-sources.jar", "chordsketch-1.2.0-javadoc.jar", "chordsketch-1.2.0.jar"):
                (directory / f"{name}.asc").write_text("sig")
            (directory / "chordsketch-1.2.0.pom").write_bytes(self.POM)
            for name in ("chordsketch-1.2.0-sources.jar", "chordsketch-1.2.0-javadoc.jar"):
                write_zip(directory / name, {"README": b""})
            write_zip(directory / "chordsketch-1.2.0.jar", {f"jni-{path}": b"lib" for path in checks.JAR_NATIVE_LIBRARIES})
            problems = checks.maven_repository_problems(repository, "1.2.0", runner=lambda cmd, cwd, env=None: checks.subprocess.CompletedProcess(cmd, 0, ""))
        missing = [p for p in problems if "where JNA looks" in p]
        self.assertEqual(len(missing), len(checks.JAR_NATIVE_LIBRARIES))


class ContainerImageTest(unittest.TestCase):
    def test_when_the_image_gets_the_version_the_minor_and_latest_the_docker_hub_copy_finds_them(self) -> None:
        tags = ["ghcr.io/koedame/chordsketch:1.2.0", "ghcr.io/koedame/chordsketch:1.2", "ghcr.io/koedame/chordsketch:latest"]
        self.assertEqual(checks.container_tag_problems("v1.2.0", tags), [])

    def test_when_the_minor_tag_is_not_produced_the_docker_hub_copy_would_fail(self) -> None:
        tags = ["ghcr.io/koedame/chordsketch:1.2.0", "ghcr.io/koedame/chordsketch:latest"]
        problems = checks.container_tag_problems("v1.2.0", tags)
        self.assertEqual(len(problems), 1)
        self.assertIn("ghcr.io/koedame/chordsketch:1.2", problems[0])


class ChannelCoverageTest(unittest.TestCase):
    WORKFLOW = (checks.REPO_ROOT / ".github/workflows/publishable.yml").read_text()

    def test_when_the_manifest_lists_a_channel_the_required_check_covers_it(self) -> None:
        # A plain substring test would let "check-publishable.py npm" match
        # inside the unrelated "check-publishable.py npm-matrix" invocation,
        # so a dropped `npm` job would go unnoticed. Require the match not
        # be immediately followed by a word character or hyphen.
        uncovered = []
        for channel in load_channels():
            check = checks.channel_check(channel.id, channel.kind, channel.package)
            if check is None or not re.search(re.escape(check) + r"(?![\w-])", self.WORKFLOW):
                uncovered.append(f"{channel.id} ({check})")
        self.assertEqual(uncovered, [])

    def test_when_a_workflow_only_has_a_look_alike_invocation_the_channel_is_still_uncovered(self) -> None:
        # `npm-matrix` is a real, unrelated subcommand that starts with the
        # `npm` channel's check string; a workflow that dropped the real
        # `npm` job but kept `npm-matrix` must not read as covered.
        look_alike = 'run: echo "packages=$(python3 scripts/check-publishable.py npm-matrix)"'
        self.assertIsNone(re.search(re.escape("check-publishable.py npm") + r"(?![\w-])", look_alike))

    def test_when_a_job_exists_in_publishable_the_aggregate_job_needs_it(self) -> None:
        jobs = re.findall(r"^  ([a-z0-9-]+):\n", self.WORKFLOW[self.WORKFLOW.index("\njobs:\n") :], flags=re.MULTILINE)
        needs = self.WORKFLOW[self.WORKFLOW.index("\n  publishable:\n") :]
        missing = [job for job in jobs if job != "publishable" and f"- {job}\n" not in needs]
        self.assertEqual(missing, [])


class ReleaseAssetTest(unittest.TestCase):
    def test_when_release_yml_builds_its_matrix_every_cli_archive_is_an_asset(self) -> None:
        targets = checks.release_targets()
        self.assertIn("x86_64-pc-windows-msvc", targets)
        assets = checks.release_assets("1.2.0")
        self.assertIn(f"{checks.RELEASE_REPOSITORY_URL}v1.2.0/chordsketch-v1.2.0-x86_64-pc-windows-msvc.zip", assets)
        self.assertIn(f"{checks.RELEASE_REPOSITORY_URL}v1.2.0/chordsketch-v1.2.0-aarch64-unknown-linux-musl.tar.gz", assets)

    def test_when_a_manifest_downloads_an_archive_the_release_does_not_build_it_is_reported(self) -> None:
        text = "url https://github.com/koedame/chordsketch/releases/download/v1.2.0/chordsketch-v1.2.0-riscv64gc-unknown-linux-gnu.tar.gz"
        self.assertEqual(len(checks.download_url_problems("m", text, "1.2.0")), 1)

    def test_when_a_manifest_uses_ruby_interpolation_the_version_is_expanded_before_matching(self) -> None:
        text = 'url "https://github.com/koedame/chordsketch/releases/download/desktop-v#{version}/ChordSketch_#{version}_x64.dmg"'
        self.assertEqual(checks.download_url_problems("cask", text, "1.2.0"), [])

    def test_when_a_manifest_pairs_each_download_with_its_own_checksum_it_passes(self) -> None:
        arm = "chordsketch-v1.2.0-aarch64-apple-darwin.tar.gz"
        text = f'url "{checks.RELEASE_REPOSITORY_URL}v1.2.0/{arm}"\nsha256 "{checks.fake_sha256(arm)}"\n'
        self.assertEqual(checks.checksum_problems("formula", text, "1.2.0"), [])

    def test_when_a_manifest_swaps_two_targets_checksums_it_is_reported(self) -> None:
        arm = "chordsketch-v1.2.0-aarch64-apple-darwin.tar.gz"
        intel = "chordsketch-v1.2.0-x86_64-apple-darwin.tar.gz"
        text = (
            f'url "{checks.RELEASE_REPOSITORY_URL}v1.2.0/{arm}"\nsha256 "{checks.fake_sha256(intel)}"\n\n\n\n\n'
            f'url "{checks.RELEASE_REPOSITORY_URL}v1.2.0/{intel}"\nsha256 "{checks.fake_sha256(arm)}"\n'
        )
        self.assertEqual(len(checks.checksum_problems("formula", text, "1.2.0")), 2)

    def test_when_a_placeholder_is_left_unfilled_it_is_reported(self) -> None:
        self.assertIn("unfilled", checks.checksum_problems("m", "sha256 '{{SHA256_X}}'", "1.2.0")[0])


class CliArchiveTest(unittest.TestCase):
    def package_with(self, entries: dict[str, bytes]):
        """A runner standing in for pwsh: writes the zip `Package (Windows)` would."""

        def runner(cmd, cwd, env=None):
            if cmd[0] == "pwsh":
                write_zip(Path(cwd) / f"chordsketch-{env['VERSION']}-{env['TARGET']}.zip", entries)
            return checks.subprocess.CompletedProcess(cmd, 0, "")

        return runner

    def check(self, entries: dict[str, bytes]) -> list[str]:
        with tempfile.TemporaryDirectory() as scratch:
            binaries = Path(scratch)
            for name in ("chordsketch.exe", "chordsketch-lsp.exe"):
                (binaries / name).write_bytes(b"MZ")
            return checks.cli_archive_problems("1.2.0", "x86_64-pc-windows-msvc", binaries, self.package_with(entries))

    def test_when_the_windows_zip_has_the_executables_at_its_root_it_passes(self) -> None:
        entries = {"chordsketch.exe": b"MZ", "chordsketch-lsp.exe": b"MZ", "LICENSE": b"MIT", "README.md": b"#"}
        self.assertEqual(self.check(entries), [])

    def test_when_the_windows_zip_wraps_the_executables_in_a_directory_scoop_cannot_find_them(self) -> None:
        top = "chordsketch-v1.2.0-x86_64-pc-windows-msvc"
        entries = {f"{top}/chordsketch.exe": b"MZ", f"{top}/chordsketch-lsp.exe": b"MZ", f"{top}/LICENSE": b"MIT", f"{top}/README.md": b"#"}
        problems = self.check(entries)
        self.assertEqual(problems, ["chordsketch-v1.2.0-x86_64-pc-windows-msvc.zip lacks LICENSE, README.md, chordsketch-lsp.exe, chordsketch.exe"])


class ShippedManifestTest(unittest.TestCase):
    """The hand-maintained manifests in `packaging/`, as they are committed."""

    VERSION = checks.cargo_package_version(checks.REPO_ROOT / "crates/cli/Cargo.toml")

    def test_when_the_winget_manifests_are_submitted_they_point_at_this_versions_release(self) -> None:
        self.assertEqual(checks.winget_problems(self.VERSION), [])

    def test_when_the_nixpkgs_template_is_submitted_its_metadata_is_complete(self) -> None:
        self.assertEqual(checks.nixpkgs_problems(self.VERSION), [])

    @unittest.skipUnless(shutil.which("bash"), "bash is not on PATH")
    def test_when_the_release_generates_the_scoop_manifest_it_is_complete(self) -> None:
        quiet = lambda cmd, cwd, env=None: checks.subprocess.run(  # noqa: E731
            cmd, cwd=cwd, env={**checks.os.environ, **(env or {})}, text=True, stdout=checks.subprocess.PIPE, stderr=checks.subprocess.STDOUT
        )
        self.assertEqual(checks.scoop_problems(self.VERSION, quiet), [])


def overlay_repo_root(scratch: Path, override_subpath: str) -> Path:
    """A `REPO_ROOT` look-alike: every top-level entry symlinked from the
    real repository except the one holding `override_subpath`, so a test
    can feed `winget_problems` / `nixpkgs_problems` a broken manifest
    without losing the real `.github/workflows/release.yml` those
    functions also read (for `release_assets`)."""
    top = override_subpath.split("/", 1)[0]
    for entry in checks.REPO_ROOT.iterdir():
        if entry.name != top:
            (scratch / entry.name).symlink_to(entry)
    real_top = checks.REPO_ROOT / top
    fake_top = scratch / top
    if real_top.is_dir():
        fake_top.mkdir()
        rest = override_subpath[len(top) + 1 :]
        second = rest.split("/", 1)[0]
        for entry in real_top.iterdir():
            if entry.name != second:
                (fake_top / entry.name).symlink_to(entry)
    return scratch


class WingetAndNixpkgsAdversarialTest(unittest.TestCase):
    """`winget_problems` / `nixpkgs_problems` are only exercised by
    `ShippedManifestTest` against the real, currently-correct manifests
    above; these feed each a broken one to prove the field checks fire."""

    WINGET_FILES = {
        "koedame.chordsketch.yaml": "PackageIdentifier: koedame.chordsketch\nPackageVersion: 1.2.0\nDefaultLocale: en-US\nManifestType: version\nManifestVersion: 1.6.0\n",
        "koedame.chordsketch.locale.en-US.yaml": "PackageIdentifier: koedame.chordsketch\nPackageVersion: 1.2.0\nPackageLocale: en-US\nPublisher: koedame\nPackageName: ChordSketch\nLicense: MIT\nShortDescription: s\nManifestType: defaultLocale\nManifestVersion: 1.6.0\n",
        "koedame.chordsketch.installer.yaml": "PackageIdentifier: koedame.chordsketch\nPackageVersion: 1.2.0\nInstallerType: zip\nManifestType: installer\nManifestVersion: 1.6.0\n",
    }

    def write_winget(self, scratch: Path, files: dict[str, str]) -> None:
        directory = scratch / "packaging/winget"
        directory.mkdir(parents=True)
        for name, text in files.items():
            (directory / name).write_text(text)

    def test_when_a_winget_manifest_is_at_a_different_version_it_is_reported(self) -> None:
        with tempfile.TemporaryDirectory() as scratch:
            root = overlay_repo_root(Path(scratch), "packaging/winget")
            self.write_winget(root, self.WINGET_FILES)
            with mock.patch.object(checks, "REPO_ROOT", root):
                problems = checks.winget_problems("1.3.0")
        self.assertTrue(any("PackageVersion" in p for p in problems), problems)

    def test_when_a_winget_locale_manifest_has_no_publisher_it_is_reported(self) -> None:
        files = dict(self.WINGET_FILES)
        files["koedame.chordsketch.locale.en-US.yaml"] = "\n".join(line for line in files["koedame.chordsketch.locale.en-US.yaml"].splitlines() if not line.startswith("Publisher:")) + "\n"
        with tempfile.TemporaryDirectory() as scratch:
            root = overlay_repo_root(Path(scratch), "packaging/winget")
            self.write_winget(root, files)
            with mock.patch.object(checks, "REPO_ROOT", root):
                problems = checks.winget_problems("1.2.0")
        self.assertTrue(any("Publisher" in p for p in problems), problems)

    def write_nix(self, scratch: Path, text: str) -> None:
        (scratch / "packaging/nix").mkdir(parents=True)
        (scratch / checks.NIX_PACKAGE).write_text(text)

    def test_when_the_nixpkgs_template_version_does_not_match_it_is_reported(self) -> None:
        text = 'version = "1.2.0";\nmeta = {\n  description = "d";\n  homepage = "h";\n  license = "l";\n  mainProgram = "m";\n  platforms = "p";\n  maintainers = [ ];\n  hash = "x";\n  cargoHash = "y";\n};\n'
        with tempfile.TemporaryDirectory() as scratch:
            root = overlay_repo_root(Path(scratch), "packaging/nix")
            self.write_nix(root, text)
            with mock.patch.object(checks, "REPO_ROOT", root):
                problems = checks.nixpkgs_problems("9.9.9")
        self.assertTrue(any("version" in p for p in problems), problems)

    def test_when_the_nixpkgs_template_has_no_meta_block_it_is_reported(self) -> None:
        with tempfile.TemporaryDirectory() as scratch:
            root = overlay_repo_root(Path(scratch), "packaging/nix")
            self.write_nix(root, 'version = "1.2.0";\n')
            with mock.patch.object(checks, "REPO_ROOT", root):
                problems = checks.nixpkgs_problems("1.2.0")
        self.assertIn(f"{checks.NIX_PACKAGE} has no `meta = {{` block", problems)


class PackageRuleTest(unittest.TestCase):
    def test_when_a_snap_name_has_a_double_hyphen_or_is_too_long_it_is_refused(self) -> None:
        self.assertTrue(checks.SNAP_NAME.match("chordsketch"))
        self.assertFalse(checks.SNAP_NAME.match("chord--sketch"))
        self.assertFalse(checks.SNAP_NAME.match("a" * 41))
        self.assertFalse(checks.SNAP_NAME.match("1234"))

    def test_when_an_aur_pkgver_has_a_hyphen_it_is_refused(self) -> None:
        self.assertTrue(checks.AUR_PKGVER.match("1.2.0"))
        self.assertFalse(checks.AUR_PKGVER.match("1.2.0-rc1"))

    def test_when_an_aur_package_without_build_is_not_named_bin_it_is_reported(self) -> None:
        pkgbuild = "pkgname=chordsketch\npackage() {\n    install -Dm755 chordsketch x\n}\n"
        self.assertEqual(checks.aur_naming_problems("chordsketch", pkgbuild), ["chordsketch/PKGBUILD repackages a prebuilt binary, which the AUR wants under a -bin name"])
        self.assertEqual(checks.aur_naming_problems("chordsketch-bin", pkgbuild), [])

    def test_when_an_aur_package_that_builds_from_source_is_named_bin_it_is_reported(self) -> None:
        pkgbuild = "pkgname=chordsketch-bin\nbuild() {\n    cargo build\n}\npackage() {\n    true\n}\n"
        self.assertEqual(checks.aur_naming_problems("chordsketch-bin", pkgbuild), ["chordsketch-bin/PKGBUILD builds from source, but its name ends in -bin"])
        self.assertEqual(checks.aur_naming_problems("chordsketch", pkgbuild), [])

    def test_when_a_pkgbuild_uses_shell_variables_they_are_expanded_for_the_url_check(self) -> None:
        text = 'source=("https://example/v${pkgver}/x-${CARCH}.tar.gz")'
        self.assertEqual(checks.expand_shell_variables(text, {"pkgver": "1.2.0", "CARCH": "x86_64"}), 'source=("https://example/v1.2.0/x-x86_64.tar.gz")')


class FlathubTest(unittest.TestCase):
    def test_when_flatpak_builder_lint_prints_no_report_there_is_no_problem(self) -> None:
        self.assertEqual(checks.flatpak_lint_problems("manifest", "", 0), [])

    def test_when_flatpak_builder_lint_reports_errors_and_warnings_each_is_a_problem(self) -> None:
        report = 'fatal: not a git repository\n{\n  "errors": ["finish-args-home-filesystem-access"],\n  "warnings": ["runtime-is-eol-org.gnome.Platform-48"]\n}\n'
        self.assertEqual(
            checks.flatpak_lint_problems("repo", report, 1),
            [
                "flatpak-builder-lint repo error: finish-args-home-filesystem-access",
                "flatpak-builder-lint repo warning: runtime-is-eol-org.gnome.Platform-48",
            ],
        )

    def test_when_a_newer_runtime_lacks_an_sdk_extension_the_manifest_needs_its_update_warning_is_not_a_problem(self) -> None:
        report = '{"warnings": ["runtime-update-available-to-org.gnome.Platform-51"]}'
        blockers = {"51": ["org.freedesktop.Sdk.Extension.node24//26.08"]}
        with contextlib.redirect_stdout(io.StringIO()) as out:
            self.assertEqual(checks.flatpak_lint_problems("repo", report, 0, blockers), [])
        self.assertIn("org.freedesktop.Sdk.Extension.node24//26.08", out.getvalue())

    def test_when_a_newer_runtime_has_every_sdk_extension_its_update_warning_is_a_problem(self) -> None:
        report = '{"warnings": ["runtime-update-available-to-org.gnome.Platform-51"]}'
        self.assertEqual(
            checks.flatpak_lint_problems("repo", report, 0, {}),
            ["flatpak-builder-lint repo warning: runtime-update-available-to-org.gnome.Platform-51"],
        )

    def test_when_the_blocked_runtime_is_not_the_one_the_warning_names_the_warning_is_a_problem(self) -> None:
        report = '{"warnings": ["runtime-update-available-to-org.gnome.Platform-52"]}'
        blockers = {"51": ["org.freedesktop.Sdk.Extension.node24//26.08"]}
        self.assertEqual(
            checks.flatpak_lint_problems("repo", report, 0, blockers),
            ["flatpak-builder-lint repo warning: runtime-update-available-to-org.gnome.Platform-52"],
        )

    def test_when_the_probe_reports_missing_extensions_they_are_grouped_by_runtime_version(self) -> None:
        output = "51 org.freedesktop.Sdk.Extension.node24//26.08\n51 org.freedesktop.Sdk.Extension.llvm22//26.08\n\n"
        self.assertEqual(
            checks.flatpak_runtime_update_blockers(output),
            {"51": ["org.freedesktop.Sdk.Extension.node24//26.08", "org.freedesktop.Sdk.Extension.llvm22//26.08"]},
        )

    def test_when_the_manifest_lists_sdk_extensions_they_are_read_in_order(self) -> None:
        manifest = "runtime: org.gnome.Platform\nsdk-extensions:\n  - org.freedesktop.Sdk.Extension.node24\n  - org.freedesktop.Sdk.Extension.llvm22\ncommand: x\n"
        self.assertEqual(checks.flatpak_sdk_extensions(manifest), ["org.freedesktop.Sdk.Extension.node24", "org.freedesktop.Sdk.Extension.llvm22"])

    def test_when_the_shipped_manifest_is_read_its_sdk_extensions_are_found(self) -> None:
        manifest = (checks.REPO_ROOT / "packaging/flatpak" / f"{checks.FLATPAK_APP_ID}.yml").read_text()
        self.assertIn("org.freedesktop.Sdk.Extension.node24", checks.flatpak_sdk_extensions(manifest))

    def test_when_flatpak_builder_lint_explains_a_finding_the_explanation_is_in_the_problem(self) -> None:
        report = '{"errors": ["appid-url-not-reachable"], "info": ["appid-url-not-reachable: Tried https://example.org | Status: 403"]}'
        self.assertEqual(
            checks.flatpak_lint_problems("manifest", report, 1),
            ["flatpak-builder-lint manifest error: appid-url-not-reachable — Tried https://example.org | Status: 403"],
        )

    def test_when_flatpak_builder_lint_explanation_is_long_it_is_cut_at_200_characters(self) -> None:
        body = "x" * 500
        report = json.dumps({"errors": ["appid-url-not-reachable"], "info": [f"appid-url-not-reachable: Status: 403 | {body}"]})
        problems = checks.flatpak_lint_problems("manifest", report, 1)
        self.assertEqual(len(problems), 1)
        detail = problems[0].split(" — ", 1)[1]
        self.assertEqual(len(detail), 201)  # 200 chars + the trailing ellipsis
        self.assertTrue(detail.endswith("…"))
        self.assertNotIn("x" * 500, detail)

    def test_when_flatpak_builder_lint_fails_without_a_report_its_output_is_the_problem(self) -> None:
        problems = checks.flatpak_lint_problems("manifest", "Traceback (most recent call last):\nOSError", 1)
        self.assertEqual(len(problems), 1)
        self.assertIn("OSError", problems[0])

    def test_when_the_app_sets_its_title_after_startup_the_launch_has_no_problem(self) -> None:
        self.assertEqual(checks.flatpak_launch_problems(["chordsketch-desktop", "Untitled — ChordSketch"]), [])

    def test_when_the_app_shows_the_startup_failure_dialog_the_launch_fails(self) -> None:
        problems = checks.flatpak_launch_problems(["ChordSketch", "ChordSketch failed to start"])
        self.assertEqual(problems, ['the Flatpak shows "ChordSketch failed to start" on launch'])

    def test_when_the_app_never_finishes_startup_the_launch_fails_naming_its_windows(self) -> None:
        problems = checks.flatpak_launch_problems(["chordsketch-desktop", "ChordSketch"])
        self.assertEqual(len(problems), 1)
        self.assertIn("'ChordSketch'", problems[0])


@unittest.skipUnless(shutil.which("npm"), "npm is not on PATH")
class NpmDryRunTest(unittest.TestCase):
    """Runs the real `npm publish --dry-run`; publishable.yml guarantees npm."""

    def pack(self, scratch: Path, url: str) -> Path:
        manifest = {
            "name": "@chordsketch/publish-check-fixture",
            "version": "0.0.0",
            "description": "fixture",
            "license": "MIT",
            "main": "index.js",
            "repository": {"type": "git", "url": url},
        }
        tarball = scratch / "chordsketch-publish-check-fixture-0.0.0.tgz"
        write_tarball(
            tarball,
            "package",
            {"package.json": json.dumps(manifest).encode(), "index.js": b"module.exports = 1;\n", "README.md": b"# fixture\n"},
        )
        return tarball

    def problems(self, url: str) -> list[str]:
        package = checks.NpmPackage("@chordsketch/publish-check-fixture", ".")
        quiet = lambda cmd, cwd, env=None: checks.subprocess.run(  # noqa: E731
            cmd, cwd=cwd, env={**checks.os.environ, **(env or {})}, text=True, stdout=checks.subprocess.PIPE, stderr=checks.subprocess.STDOUT
        )
        with tempfile.TemporaryDirectory() as scratch:
            return checks.npm_tarball_problems(package, self.pack(Path(scratch), url), {}, quiet, lambda n, s: True)

    def test_when_repository_url_is_not_in_npms_canonical_form_the_dry_run_warning_fails_the_check(self) -> None:
        problems = self.problems("https://github.com/koedame/chordsketch.git")
        self.assertTrue(any("repository.url" in p or "auto-corrected" in p for p in problems), problems)

    def test_when_repository_url_is_canonical_the_dry_run_passes(self) -> None:
        self.assertEqual(self.problems("git+https://github.com/koedame/chordsketch.git"), [])


if __name__ == "__main__":
    unittest.main()
