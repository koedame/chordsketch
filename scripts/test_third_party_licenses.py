#!/usr/bin/env python3
"""Tests for `third-party-licenses.py`.

The cases build lock-file fragments and crate metadata by hand, so they need
neither cargo-about nor `npm ci`. One smoke test asserts that the real
`about.toml` and `deny.toml` still accept the same licenses.
"""
from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
import tomllib
import unittest
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS_DIR))

_spec = importlib.util.spec_from_file_location(
    "third_party_licenses", SCRIPTS_DIR / "third-party-licenses.py"
)
assert _spec is not None and _spec.loader is not None
tpl = importlib.util.module_from_spec(_spec)
sys.modules["third_party_licenses"] = tpl
_spec.loader.exec_module(tpl)

MIT_TEMPLATE = "MIT License\n\nCopyright (c) <year> <copyright holders>\n\nPermission is hereby granted"


class FillPlaceholderTest(unittest.TestCase):
    def test_license_template_without_a_holder_takes_the_manifest_authors(self):
        crate = {"name": "phf", "version": "0.8.0", "authors": ["Steven Fackler <sfackler@gmail.com>"]}
        text = tpl.fill_placeholder(MIT_TEMPLATE, crate)
        self.assertIn("Copyright (c) Steven Fackler\n", text)
        self.assertNotIn("<", text)

    def test_every_author_is_named_and_no_email_address_is_copied(self):
        crate = {
            "name": "dlopen2",
            "version": "0.8.2",
            "authors": ["A One <a@example.com>", "B Two <b@example.com>"],
        }
        text = tpl.fill_placeholder(MIT_TEMPLATE, crate)
        self.assertIn("Copyright (c) A One, B Two\n", text)
        self.assertNotIn("example.com", text)

    def test_crate_without_authors_is_credited_to_its_repository(self):
        crate = {"name": "dpi", "version": "0.1.2", "authors": [], "repository": "https://github.com/rust-windowing/winit"}
        text = tpl.fill_placeholder(MIT_TEMPLATE, crate)
        self.assertIn("Copyright (c) The dpi authors (https://github.com/rust-windowing/winit)", text)

    def test_bsd_template_keeps_its_closing_full_stop(self):
        crate = {"name": "brotli", "version": "8.0.2", "authors": ["The Brotli Authors"]}
        text = tpl.fill_placeholder("Copyright (c) <year> <owner>.\n\nRedistribution", crate)
        self.assertTrue(text.startswith("Copyright (c) The Brotli Authors.\n"))

    def test_text_that_already_names_its_holder_is_left_alone(self):
        text = "Copyright (c) 2014 Alex Crichton\n\nPermission is hereby granted"
        self.assertEqual(tpl.fill_placeholder(text, {"name": "cc", "version": "1"}), text)


APACHE = (
    "Apache License\n Version 2.0\n\nAPPENDIX: How to apply the Apache License to your work.\n\n"
    "   Copyright {line}\n\n   Licensed under the Apache License, Version 2.0\n"
)


class SplitApacheNoticeTest(unittest.TestCase):
    def test_a_crates_own_appendix_line_is_replaced_by_the_standard_one_and_returned(self):
        text, own = tpl.split_apache_notice(APACHE.format(line="2023 Jacob Pratt et al."))
        self.assertEqual(own, "Copyright 2023 Jacob Pratt et al.")
        self.assertEqual(text, APACHE.format(line="[yyyy] [name of copyright owner]"))

    def test_two_crates_that_differ_only_in_that_line_end_up_with_the_same_text(self):
        a, _ = tpl.split_apache_notice(APACHE.format(line="2023 A"))
        b, _ = tpl.split_apache_notice(APACHE.format(line="2024 B"))
        self.assertEqual(a, b)

    def test_the_standard_line_is_left_alone_and_names_no_one(self):
        standard = APACHE.format(line="[yyyy] [name of copyright owner]")
        self.assertEqual(tpl.split_apache_notice(standard), (standard, ""))

    def test_a_text_that_is_not_apache_is_left_alone(self):
        mit = "MIT License\n\nCopyright (c) 2014 Alex Crichton\n"
        self.assertEqual(tpl.split_apache_notice(mit), (mit, ""))

    def test_copyright_lines_after_the_appendix_stay_in_the_text(self):
        text = APACHE.format(line="2023 A") + "\n\nLicenses for support code\n\nCopyright (c) 2015 Google Inc.\n"
        split, own = tpl.split_apache_notice(text)
        self.assertEqual(own, "Copyright 2023 A")
        self.assertIn("Copyright (c) 2015 Google Inc.", split)


class CargoLockPackagesTest(unittest.TestCase):
    LOCK = """
[[package]]
name = "chordsketch"
version = "0.7.0"

[[package]]
name = "serde"
version = "1.0.0"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "abc"
"""

    def test_workspace_crates_are_not_third_party_packages(self):
        self.assertEqual(tpl.cargo_lock_packages(self.LOCK), [("serde", "1.0.0", "abc")])

    def test_bumping_only_the_workspace_version_does_not_change_the_list(self):
        bumped = self.LOCK.replace('version = "0.7.0"', 'version = "0.8.0"')
        self.assertEqual(tpl.cargo_lock_packages(bumped), tpl.cargo_lock_packages(self.LOCK))


class ResolveTest(unittest.TestCase):
    PACKAGES = {
        "": {},
        "node_modules/a": {},
        "node_modules/b": {},
        "node_modules/a/node_modules/b": {},
        "../react/node_modules/c": {},
    }

    def test_nested_copy_wins_over_the_hoisted_one(self):
        self.assertEqual(tpl.resolve(self.PACKAGES, "node_modules/a", "b"), "node_modules/a/node_modules/b")

    def test_lookup_walks_up_to_the_hoisted_copy(self):
        self.assertEqual(tpl.resolve(self.PACKAGES, "node_modules/b", "a"), "node_modules/a")

    def test_missing_package_is_none(self):
        self.assertIsNone(tpl.resolve(self.PACKAGES, "node_modules/a", "zzz"))


class NpmSelectionTest(unittest.TestCase):
    LOCK = {
        "packages": {
            "": {},
            "node_modules/react": {"version": "18", "dependencies": {"loose-envify": "^1"}},
            "node_modules/loose-envify": {"version": "1"},
            "node_modules/codemirror": {"version": "6"},
            "node_modules/vite": {"version": "6", "dependencies": {"rollup": "^4"}},
            "node_modules/rollup": {"version": "4", "optionalDependencies": {"@rollup/rollup-linux": "^4"}},
            "node_modules/@rollup/rollup-linux": {"version": "4", "os": ["linux"], "cpu": ["x64"]},
            "node_modules/@chordsketch/react": {"link": True, "resolved": "../react"},
            "../react": {"version": "0.7.0", "dependencies": {"codemirror": "^6"}},
        }
    }

    def names(self, selection):
        return sorted(tpl.package_name(k) for k in selection)

    def test_dev_surface_bundles_dev_dependencies_but_not_the_tooling(self):
        package = {"dependencies": {"react": "^18"}, "devDependencies": {"codemirror": "^6", "vite": "^6"}}
        selection = tpl.npm_selection("app", True, package, self.LOCK)
        self.assertEqual(self.names(selection), ["codemirror", "loose-envify", "react"])

    def test_runtime_only_surface_leaves_dev_dependencies_out(self):
        package = {"dependencies": {"react": "^18"}, "devDependencies": {"codemirror": "^6"}}
        selection = tpl.npm_selection("ext", False, package, self.LOCK)
        self.assertEqual(self.names(selection), ["loose-envify", "react"])

    def test_workspace_link_contributes_its_dependencies_but_is_not_listed(self):
        package = {"dependencies": {"@chordsketch/react": "file:../react"}}
        selection = tpl.npm_selection("ext", False, package, self.LOCK)
        self.assertEqual(self.names(selection), ["codemirror"])

    def test_platform_specific_optional_binaries_are_not_followed(self):
        package = {"dependencies": {"rollup": "^4"}}
        selection = tpl.npm_selection("app", False, package, self.LOCK)
        self.assertEqual(self.names(selection), ["rollup"])

    def test_dependency_missing_from_the_lock_file_stops_the_run(self):
        with self.assertRaises(SystemExit):
            tpl.npm_selection("app", False, {"dependencies": {"nope": "^1"}}, self.LOCK)


class ToolingTest(unittest.TestCase):
    def test_type_definitions_and_test_runners_are_tooling(self):
        for name in ("typescript", "vitest", "@types/react", "@playwright/test", "@vitejs/plugin-react"):
            self.assertTrue(tpl.is_tooling(name), name)

    def test_a_package_that_may_be_bundled_is_not_tooling(self):
        for name in ("react", "codemirror", "@codemirror/view", "web-tree-sitter", "@lezer/highlight"):
            self.assertFalse(tpl.is_tooling(name), name)


class HeaderTest(unittest.TestCase):
    def test_header_round_trips_both_hashes_and_the_body(self):
        content = tpl.with_header("body\n", "a" * 64)
        inputs, body_hash, body = tpl.parse_header(content)
        self.assertEqual(inputs, "a" * 64)
        self.assertEqual(body, "body\n")
        self.assertEqual(body_hash, tpl.sha256(b"body\n"))

    def test_file_without_a_header_has_no_hashes(self):
        self.assertEqual(tpl.parse_header("# Third-Party Licenses\n")[:2], (None, None))


class NpmAuthorTest(unittest.TestCase):
    def test_author_string_loses_its_email_and_url(self):
        self.assertEqual(tpl.npm_author({"author": "Rich Harris <r@example.com> (https://x.example)"}), "Rich Harris")

    def test_author_object_uses_its_name(self):
        self.assertEqual(tpl.npm_author({"author": {"name": "Rich Harris"}}), "Rich Harris")


REPO = SCRIPTS_DIR.parent
# The reference pages of the design system serve their own copies of the web
# fonts. They ship in no binary, so the generated notice does not list them;
# NOTICE does, and each family's OFL sits beside its files.
DESIGN_SYSTEM_FONTS = "design-system/fonts/"
# Everything that ships a compiled build of the renderers, and so the Noto
# Sans CJK subset (PDF) and the Bravura outlines (HTML, iReal), with the OFL
# those fonts are under named beside the MIT of the source.
OFL_JSON_MANIFESTS = [
    "packages/npm/package.json",
    "packages/npm-export/package.json",
    "packages/vscode-extension/package.json",
    "crates/napi/package.json",
    *(f"crates/napi/npm/{target}/package.json" for target in (
        "darwin-arm64", "darwin-x64", "linux-arm64-gnu", "linux-x64-gnu", "win32-x64-msvc")),
]


class FontNoticeTest(unittest.TestCase):
    def test_the_only_font_file_in_the_tree_is_the_one_the_notice_generator_reproduces_the_license_of(self):
        listed = subprocess.run(
            ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
            cwd=REPO, check=True, stdout=subprocess.PIPE, text=True,
        ).stdout.split("\0")
        fonts = {
            p for p in listed
            if p.lower().endswith((".otf", ".ttf", ".woff", ".woff2"))
            and not p.startswith(DESIGN_SYSTEM_FONTS)
        }
        self.assertEqual(
            fonts, {"crates/render-pdf/assets/NotoSansCJK-subset.otf"},
            "a font file was added or removed: update BUNDLED in third-party-licenses.py (with its OFL) and NOTICE",
        )

    def test_every_font_file_in_the_design_system_sits_next_to_the_license_of_its_family(self):
        fonts_dir = REPO / DESIGN_SYSTEM_FONTS
        families = sorted(p.stem.removeprefix("LICENSE-") for p in fonts_dir.glob("LICENSE-*.txt"))
        self.assertTrue(families)
        for font in fonts_dir.glob("*.woff2"):
            self.assertTrue(
                any(font.name.startswith(family + "-") for family in families),
                f"{font.name} has no LICENSE-<family>.txt next to it in {DESIGN_SYSTEM_FONTS}",
            )
        notice = (REPO / "NOTICE").read_text()
        self.assertIn("design-system/fonts/LICENSE-*.txt", notice)

    def test_the_committed_notice_reproduces_the_license_text_of_every_bundled_font(self):
        notice = (REPO / "THIRD_PARTY_LICENSES.md").read_text()
        for name, _, _, licence in tpl.BUNDLED:
            text = (REPO / licence).read_text().strip()
            self.assertIn(text, notice, name)

    def test_the_notice_names_the_license_file_of_every_bundled_entry(self):
        notice = (REPO / "NOTICE").read_text()
        for name, _, _, licence in tpl.BUNDLED:
            self.assertIn(licence, notice, name)

    def test_the_noto_subset_does_not_claim_a_reserved_font_name_the_upstream_font_does_not_declare(self):
        text = (REPO / "crates/render-pdf/assets/OFL.txt").read_text()
        first = text.split("\n", 1)[0]
        self.assertTrue(first.startswith("Copyright 2014-2021 Adobe"), first)
        self.assertNotIn("Reserved Font Name", first)

    def test_the_crate_that_embeds_the_font_declares_the_ofl_beside_the_mit(self):
        manifest = tomllib.loads((REPO / "crates/render-pdf/Cargo.toml").read_text())
        self.assertEqual(manifest["package"]["license"], "MIT AND OFL-1.1")

    def test_a_package_that_ships_the_compiled_renderers_declares_the_ofl_beside_the_mit(self):
        for path in OFL_JSON_MANIFESTS:
            self.assertEqual(json.loads((REPO / path).read_text())["license"], "MIT AND OFL-1.1", path)
        pyproject = tomllib.loads((REPO / "crates/ffi/pyproject.toml").read_text())
        self.assertEqual(pyproject["project"]["license"], {"text": "MIT AND OFL-1.1"})
        self.assertIn('["MIT", "OFL-1.1"]', (REPO / "packages/ruby/chordsketch.gemspec").read_text())

    def test_a_package_definition_that_installs_a_binary_installs_the_notices_with_it(self):
        for path in ("packaging/aur/chordsketch-bin/PKGBUILD.template", "packaging/aur/chordsketch/PKGBUILD.template",
                     "packaging/homebrew/chordsketch.rb.template", "packaging/homebrew/chordsketch-desktop-formula.rb.template",
                     "packaging/snap/snapcraft.yaml.template", "packaging/macports/Portfile"):
            text = (REPO / path).read_text()
            self.assertIn("NOTICE", text, path)
            self.assertIn("THIRD_PARTY_LICENSES.md", text, path)

    def test_the_macports_portfile_declares_the_ofl_beside_the_mit(self):
        self.assertRegex((REPO / "packaging/macports/Portfile").read_text(), r"(?m)^license\s+MIT OFL-1\.1$")

    def test_the_chocolatey_nuspec_names_a_license_url_because_choco_pack_rejects_the_license_element(self):
        nuspec = (REPO / "packaging/chocolatey/chordsketch.nuspec.template").read_text()
        self.assertIn("<licenseUrl>", nuspec)
        self.assertNotIn("<license ", nuspec)


class PolicyTest(unittest.TestCase):
    def test_about_toml_accepts_exactly_what_deny_toml_allows(self):
        self.assertIsNone(tpl.policy_mismatch())


if __name__ == "__main__":
    unittest.main()
