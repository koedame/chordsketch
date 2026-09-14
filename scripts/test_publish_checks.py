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
  6. With npm on PATH, `npm publish --dry-run` really does warn about the
     `repository.url` form that npm rewrote on four packages in 0.6.0, and
     the check turns that warning into a failure.

Stdlib `unittest` only. Only the last group runs a tool (npm, offline).
"""

from __future__ import annotations

import io
import json
import shutil
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path

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
