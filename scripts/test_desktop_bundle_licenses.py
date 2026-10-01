#!/usr/bin/env python3
"""Pins the license texts every desktop bundle carries.

Uses only `unittest` from stdlib. The desktop app is AGPL-3.0-only, links the
MIT-licensed SDK crates, and draws Bravura glyph outlines (SIL OFL 1.1). Each
license asks for its text to travel with the copies, so `bundle.resources`
puts them beside the executable in the `.app`, the Windows installers, the
`.deb`, the `.rpm` and the AppImage.
"""
from __future__ import annotations

import json
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
TAURI_DIR = REPO_ROOT / "apps" / "desktop" / "src-tauri"

# What each bundle must hold, by the name it has inside the bundle.
EXPECTED = {
    "LICENSE": REPO_ROOT / "apps" / "desktop" / "LICENSE",
    "LICENSE-MIT": REPO_ROOT / "LICENSE",
    "LICENSE-OFL.txt": REPO_ROOT / "crates" / "render-ireal" / "LICENSE-OFL.txt",
    "NOTICE": REPO_ROOT / "NOTICE",
}


class DesktopBundleLicensesTest(unittest.TestCase):
    def setUp(self) -> None:
        conf = json.loads((TAURI_DIR / "tauri.conf.json").read_text(encoding="utf-8"))
        self.resources = conf["bundle"]["resources"]

    def test_when_the_bundle_is_built_the_license_texts_are_among_its_resources(self) -> None:
        by_name = {name: (TAURI_DIR / source).resolve() for source, name in self.resources.items()}
        for name, source in EXPECTED.items():
            self.assertEqual(by_name.get(name), source.resolve(), f"{name} is not bundled from {source}")

    def test_when_a_resource_is_listed_its_source_file_exists(self) -> None:
        for source in self.resources:
            self.assertTrue((TAURI_DIR / source).is_file(), f"bundle.resources names a missing file: {source}")


if __name__ == "__main__":
    unittest.main()
