#!/usr/bin/env python3
"""Tests for `scripts/swift_package.py`.

The rewrite is what puts a release's XCFramework checksum into the
`Package.swift` a consumer resolves, so what these pin down is that the
rewrite touches the binary target and nothing else, and that it fails
loudly when the manifest is not shaped as it expects.

Stdlib `unittest` only.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS_DIR))

import swift_package  # noqa: E402

OLD_SHA = "a" * 64
NEW_SHA = "b" * 64

MANIFEST = f"""// swift-tools-version: 5.9

import PackageDescription

let package = Package(
    name: "ChordSketch",
    targets: [
        .binaryTarget(
            name: "chordsketchFFI",
            url: "https://github.com/koedame/chordsketch/releases/download/v0.7.0/chordsketch-xcframework.zip",
            checksum: "{OLD_SHA}"
        ),
        .target(
            name: "ChordSketch",
            dependencies: ["chordsketchFFI"],
            linkerSettings: [.linkedLibrary("z")]
        ),
    ]
)
"""


class ReadPinTest(unittest.TestCase):
    def test_a_remote_binary_target_yields_its_url_and_checksum(self) -> None:
        self.assertEqual(
            swift_package.read_pin(MANIFEST),
            ("https://github.com/koedame/chordsketch/releases/download/v0.7.0/chordsketch-xcframework.zip", OLD_SHA),
        )

    def test_a_local_binary_target_is_refused(self) -> None:
        local = swift_package.use_local(MANIFEST, "chordsketchFFI.xcframework")
        with self.assertRaises(swift_package.SwiftPackageError):
            swift_package.read_pin(local)

    def test_a_manifest_without_the_binary_target_is_refused(self) -> None:
        with self.assertRaises(swift_package.SwiftPackageError):
            swift_package.read_pin("let package = Package(name: \"x\")\n")


class PinTest(unittest.TestCase):
    def test_pinning_points_the_target_at_the_tags_asset_with_the_new_checksum(self) -> None:
        pinned = swift_package.pin(MANIFEST, "v0.8.0", NEW_SHA)
        self.assertEqual(
            swift_package.read_pin(pinned),
            ("https://github.com/koedame/chordsketch/releases/download/v0.8.0/chordsketch-xcframework.zip", NEW_SHA),
        )

    def test_pinning_leaves_everything_outside_the_binary_target_as_it_was(self) -> None:
        pinned = swift_package.pin(MANIFEST, "v0.8.0", NEW_SHA)
        start, end = swift_package.binary_target_span(MANIFEST)
        pinned_start, pinned_end = swift_package.binary_target_span(pinned)
        self.assertEqual(pinned[:pinned_start], MANIFEST[:start])
        self.assertEqual(pinned[pinned_end:], MANIFEST[end:])

    def test_pinning_twice_gives_the_same_manifest_as_pinning_once(self) -> None:
        once = swift_package.pin(MANIFEST, "v0.8.0", NEW_SHA)
        self.assertEqual(swift_package.pin(once, "v0.8.0", NEW_SHA), once)

    def test_a_prerelease_tag_is_accepted(self) -> None:
        pinned = swift_package.pin(MANIFEST, "v0.8.0-rc.1", NEW_SHA)
        self.assertIn("/download/v0.8.0-rc.1/", swift_package.read_pin(pinned)[0])

    def test_a_tag_without_the_v_prefix_is_refused(self) -> None:
        with self.assertRaises(swift_package.SwiftPackageError):
            swift_package.pin(MANIFEST, "0.8.0", NEW_SHA)

    def test_a_checksum_that_is_not_lowercase_sha256_is_refused(self) -> None:
        for bad in ("", "b" * 63, "B" * 64, "g" * 64):
            with self.subTest(checksum=bad), self.assertRaises(swift_package.SwiftPackageError):
                swift_package.pin(MANIFEST, "v0.8.0", bad)

    def test_a_parenthesis_inside_the_old_url_does_not_end_the_target_early(self) -> None:
        tricky = MANIFEST.replace("v0.7.0/chordsketch-xcframework.zip", "v0.7.0/odd).zip")
        pinned = swift_package.pin(tricky, "v0.8.0", NEW_SHA)
        self.assertEqual(swift_package.read_pin(pinned)[1], NEW_SHA)
        self.assertIn('linkerSettings: [.linkedLibrary("z")]', pinned)

    def test_two_binary_targets_for_the_framework_are_refused(self) -> None:
        start, end = swift_package.binary_target_span(MANIFEST)
        doubled = MANIFEST[:end] + ",\n        " + MANIFEST[start:end] + MANIFEST[end:]
        with self.assertRaises(swift_package.SwiftPackageError):
            swift_package.pin(doubled, "v0.8.0", NEW_SHA)


class UseLocalTest(unittest.TestCase):
    def test_the_remote_binary_becomes_a_path_and_the_rest_is_kept(self) -> None:
        local = swift_package.use_local(MANIFEST, "chordsketchFFI.xcframework")
        self.assertIn('path: "chordsketchFFI.xcframework"', local)
        self.assertNotIn("checksum", local)
        self.assertIn('linkerSettings: [.linkedLibrary("z")]', local)


class CommandLineTest(unittest.TestCase):
    def test_pin_rewrites_the_manifest_in_place_and_show_reads_it_back(self) -> None:
        import contextlib
        import io
        import tempfile

        with tempfile.TemporaryDirectory() as directory:
            manifest = Path(directory) / "Package.swift"
            manifest.write_text(MANIFEST)
            self.assertEqual(swift_package.main(["--manifest", str(manifest), "pin", "--tag", "v0.8.0", "--sha256", NEW_SHA]), 0)
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                self.assertEqual(swift_package.main(["--manifest", str(manifest), "show"]), 0)
            self.assertEqual(
                out.getvalue().strip(),
                f"https://github.com/koedame/chordsketch/releases/download/v0.8.0/chordsketch-xcframework.zip {NEW_SHA}",
            )

    def test_a_rejected_pin_leaves_the_manifest_untouched_and_exits_nonzero(self) -> None:
        import contextlib
        import io
        import tempfile

        with tempfile.TemporaryDirectory() as directory:
            manifest = Path(directory) / "Package.swift"
            manifest.write_text(MANIFEST)
            with contextlib.redirect_stderr(io.StringIO()):
                code = swift_package.main(["--manifest", str(manifest), "pin", "--tag", "0.8.0", "--sha256", NEW_SHA])
            self.assertEqual(code, 1)
            self.assertEqual(manifest.read_text(), MANIFEST)


if __name__ == "__main__":
    unittest.main()
