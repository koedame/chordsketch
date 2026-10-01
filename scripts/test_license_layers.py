#!/usr/bin/env python3
"""Tests that the repository's licence files, manifests and notices agree.

ChordSketch has two licence layers, split by directory (CLAUDE.md "License
Policy", README "License"): AGPL-3.0-only for `apps/desktop/`,
`packages/playground/` and `packages/ui-irealb-editor/`, MIT for everything
else. These tests pin the places the split can silently drift:

  1. Every `LICENSE` file is a verbatim copy of one of the two texts.
  2. Every application-layer directory has the AGPL text and says
     AGPL-3.0-only in its manifest; every `crates/*` and `packages/*`
     directory outside it has the MIT text and says MIT in its manifest.
  3. `NOTICE` names only licence files that exist, and names the same
     copyright holder as `LICENSE`.
  4. The README's License section lists every application-layer directory.

Stdlib `unittest` only.
"""

from __future__ import annotations

import json
import re
import subprocess
import tomllib
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
AGPL_DIRS = ("apps/desktop", "packages/playground", "packages/ui-irealb-editor")
MIT_TEXT = (ROOT / "LICENSE").read_bytes()
AGPL_TEXT = (ROOT / "apps/desktop/LICENSE").read_bytes()
# A third-party skill vendored for development under its own licence.
VENDORED = (".claude/skills/",)


def tracked(name: str) -> list[Path]:
    listed = subprocess.run(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], cwd=ROOT, check=True, stdout=subprocess.PIPE, text=True).stdout
    return [ROOT / p for p in listed.split("\0") if p and p.rsplit("/", 1)[-1] == name and not p.startswith(VENDORED)]


def layer_dirs() -> list[Path]:
    return sorted(
        directory
        for parent in ("crates", "packages")
        for directory in (ROOT / parent).iterdir()
        if directory.is_dir() and directory.relative_to(ROOT).as_posix() not in AGPL_DIRS
    )


def declared_license(directory: Path) -> str | None:
    package_json = directory / "package.json"
    if package_json.is_file():
        return json.loads(package_json.read_text()).get("license")
    cargo = directory / "Cargo.toml"
    if cargo.is_file():
        package = tomllib.loads(cargo.read_text()).get("package", {})
        value = package.get("license")
        if isinstance(value, dict) and value.get("workspace"):
            return tomllib.loads((ROOT / "Cargo.toml").read_text())["workspace"]["package"]["license"]
        return value
    return None


class LicenseFileTest(unittest.TestCase):
    def test_when_a_license_file_is_checked_in_it_is_a_verbatim_copy_of_the_mit_or_the_agpl_text(self) -> None:
        files = tracked("LICENSE")
        self.assertGreater(len(files), 30)
        for path in files:
            self.assertIn(path.read_bytes(), (MIT_TEXT, AGPL_TEXT), path.relative_to(ROOT).as_posix())

    def test_when_a_directory_is_in_the_application_layer_it_has_the_agpl_text_and_says_so(self) -> None:
        for name in AGPL_DIRS:
            directory = ROOT / name
            self.assertEqual((directory / "LICENSE").read_bytes(), AGPL_TEXT, name)
            self.assertEqual(declared_license(directory), "AGPL-3.0-only", name)
            if (directory / "src-tauri").is_dir():
                self.assertEqual(declared_license(directory / "src-tauri"), "AGPL-3.0-only", name)

    def test_when_a_crate_or_package_is_not_in_the_application_layer_it_has_the_mit_text_and_says_so(self) -> None:
        directories = layer_dirs()
        self.assertGreater(len(directories), 25)
        for directory in directories:
            name = directory.relative_to(ROOT).as_posix()
            self.assertEqual((directory / "LICENSE").read_bytes(), MIT_TEXT, name)
            declared = declared_license(directory)
            if declared is not None:
                self.assertTrue(declared.startswith("MIT"), f"{name} declares {declared}")

    def test_when_syntaxes_are_copied_into_the_mit_plugins_they_are_mit_too(self) -> None:
        self.assertEqual((ROOT / "syntaxes/LICENSE").read_bytes(), MIT_TEXT)
        self.assertEqual(declared_license(ROOT / "syntaxes"), "MIT")


class NoticeTest(unittest.TestCase):
    NOTICE = (ROOT / "NOTICE").read_text()

    def test_when_the_notice_names_a_license_file_the_file_exists(self) -> None:
        names = {n for n in re.findall(r"`([\w./-]*LICENSE[\w.-]*)`", self.NOTICE)}
        self.assertTrue(names)
        for name in names:
            self.assertTrue((ROOT / name).is_file(), f"NOTICE names `{name}`, which does not exist")

    def test_when_the_notice_and_the_license_name_a_copyright_holder_it_is_the_same_one(self) -> None:
        pattern = re.compile(r"^Copyright \(c\) (.+)$", re.MULTILINE)
        self.assertEqual(pattern.search(self.NOTICE).group(1), pattern.search(MIT_TEXT.decode()).group(1))


class ReadmeTest(unittest.TestCase):
    def test_when_a_directory_is_in_the_application_layer_the_readme_license_section_lists_it(self) -> None:
        section = (ROOT / "README.md").read_text().split("\n## License\n", 1)[1].split("\n## ", 1)[0]
        for name in AGPL_DIRS:
            self.assertIn(f"`{name}/`", section)
            self.assertIn(f"({name}/LICENSE)", section)


if __name__ == "__main__":
    unittest.main()
