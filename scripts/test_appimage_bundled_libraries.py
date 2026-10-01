#!/usr/bin/env python3
"""Tests for `appimage-bundled-libraries.py`.

Uses only the standard library. `dpkg-query` is replaced by a small script
that answers from a table, and `/usr/share` by a scratch directory, so the
tests need neither dpkg nor a real AppImage: the AppImage is a directory tree
with a few ELF-looking files in it.
"""

from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import os
import stat
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SCRIPTS_DIR = Path(__file__).resolve().parent

_spec = importlib.util.spec_from_file_location(
    "appimage_bundled_libraries", SCRIPTS_DIR / "appimage-bundled-libraries.py"
)
tool = importlib.util.module_from_spec(_spec)
assert _spec.loader is not None
_spec.loader.exec_module(tool)

ELF = b"\x7fELF" + b"\0" * 12

# What the stub `dpkg-query` knows: file name -> owning package, package -> (version, source, source version).
OWNERS = {
    "libglib-2.0.so.0": "libglib2.0-0",
    "libgio-2.0.so.0": "libglib2.0-0",
    "libwebkit2gtk-4.1.so.0": "libwebkit2gtk-4.1-0",
    "WebKitWebProcess": "libwebkit2gtk-4.1-0",
}
PACKAGES = {
    "libglib2.0-0": ("2.72.4-0ubuntu2.10", "glib2.0", "2.72.4-0ubuntu2.10"),
    "libwebkit2gtk-4.1-0": ("2.50.4-0ubuntu0.22.04.1", "webkit2gtk", "2.50.4-0ubuntu0.22.04.1"),
}

STUB = """#!{python}
import json, sys
table = json.load(open({table!r}))
args = sys.argv[1:]
if args[0] == "-S":
    name = args[1].removeprefix("*/")
    pkg = table["owners"].get(name)
    if pkg:
        print(f"{{pkg}}:amd64: /usr/lib/x86_64-linux-gnu/{{name}}")
        print(f"{{pkg}}:amd64: /usr/share/doc/{{name}}.txt")
    else:
        sys.exit(1)
else:
    version, source, source_version = table["packages"][args[-1]]
    print(f"{{version}}\\t{{source}}\\t{{source_version}}", end="")
"""


class Fixture:
    def __init__(self, test: unittest.TestCase) -> None:
        tmp = tempfile.TemporaryDirectory()
        test.addCleanup(tmp.cleanup)
        scratch = Path(tmp.name)
        self.appdir = scratch / "AppDir"
        self.share = scratch / "share"
        self.out = scratch / "out.txt"
        table = scratch / "table.json"
        table.write_text(json.dumps({"owners": OWNERS, "packages": PACKAGES}))
        stub = scratch / "dpkg-query"
        stub.write_text(STUB.format(python=sys.executable, table=str(table)))
        stub.chmod(stub.stat().st_mode | stat.S_IXUSR)
        (self.appdir / "usr/lib/x86_64-linux-gnu/webkit2gtk-4.1").mkdir(parents=True)
        (self.appdir / "usr/bin").mkdir(parents=True)
        (self.share / "common-licenses").mkdir(parents=True)
        (self.share / "doc").mkdir(parents=True)
        for name in ("libglib-2.0.so.0", "libgio-2.0.so.0", "libwebkit2gtk-4.1.so.0"):
            self.put(f"usr/lib/{name}", ELF)
        self.put("usr/lib/x86_64-linux-gnu/webkit2gtk-4.1/WebKitWebProcess", ELF)
        self.put("usr/bin/chordsketch-desktop", ELF)
        self.put("usr/share/applications/ChordSketch.desktop", b"[Desktop Entry]\n")
        for pkg in PACKAGES:
            self.copyright(pkg, "License: LGPL-2.1+\n See /usr/share/common-licenses/LGPL-2.1\n")
        (self.share / "common-licenses/LGPL-2.1").write_text("GNU LESSER GENERAL PUBLIC LICENSE 2.1\n")
        self.patches = [
            patch.object(tool, "DPKG_QUERY", str(stub)),
            patch.object(tool, "SHARE_DIR", self.share),
        ]
        for p in self.patches:
            p.start()
            test.addCleanup(p.stop)

    def put(self, relative: str, data: bytes) -> None:
        path = self.appdir / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)

    def copyright(self, pkg: str, text: str) -> None:
        (self.share / "doc" / pkg).mkdir(parents=True, exist_ok=True)
        (self.share / "doc" / pkg / "copyright").write_text(text)

    def run(self) -> tuple[int, str, str]:
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = tool.main([str(self.appdir), str(self.out)])
        return code, out.getvalue(), err.getvalue()


class BundledLibrariesTest(unittest.TestCase):
    def test_when_the_appdir_holds_libraries_helpers_and_other_files_only_the_elf_files_under_usr_lib_are_listed(self) -> None:
        fx = Fixture(self)
        os.symlink("libglib-2.0.so.0", fx.appdir / "usr/lib/libglib-2.0.so")
        self.assertEqual(
            tool.bundled_libraries(fx.appdir),
            ["WebKitWebProcess", "libgio-2.0.so.0", "libglib-2.0.so.0", "libwebkit2gtk-4.1.so.0"],
        )

    def test_when_every_library_belongs_to_a_package_the_notice_lists_each_package_with_version_and_source(self) -> None:
        fx = Fixture(self)
        code, _, _ = fx.run()
        text = fx.out.read_text()
        self.assertEqual(code, 0)
        self.assertIn("libglib2.0-0 2.72.4-0ubuntu2.10", text)
        self.assertIn("https://launchpad.net/ubuntu/+source/glib2.0/2.72.4-0ubuntu2.10", text)
        self.assertIn("Files:  libgio-2.0.so.0, libglib-2.0.so.0", text)
        self.assertIn("libwebkit2gtk-4.1-0 2.50.4-0ubuntu0.22.04.1", text)
        self.assertIn("WebKitWebProcess", text)
        self.assertNotIn("not matched", text.lower())

    def test_when_a_package_has_a_copyright_file_the_notice_reproduces_it_and_the_license_texts_it_refers_to(self) -> None:
        fx = Fixture(self)
        fx.run()
        text = fx.out.read_text()
        self.assertIn("--- libglib2.0-0 ---", text)
        self.assertIn("License: LGPL-2.1+", text)
        self.assertIn("GNU LESSER GENERAL PUBLIC LICENSE 2.1", text)
        self.assertEqual(text.count("GNU LESSER GENERAL PUBLIC LICENSE 2.1"), 1)

    def test_when_a_package_has_no_copyright_file_the_notice_says_so(self) -> None:
        fx = Fixture(self)
        (fx.share / "doc/libglib2.0-0/copyright").unlink()
        fx.run()
        self.assertIn("the package has no copyright file", fx.out.read_text())

    def test_when_a_library_belongs_to_no_package_the_run_fails_and_names_the_library(self) -> None:
        fx = Fixture(self)
        fx.put("usr/lib/libmystery.so.1", ELF)
        code, _, err = fx.run()
        self.assertEqual(code, 1)
        self.assertIn("libmystery.so.1", err)
        self.assertIn("Not matched to any package", fx.out.read_text())

    def test_when_the_target_does_not_exist_the_run_fails_instead_of_writing_an_empty_notice(self) -> None:
        fx = Fixture(self)
        missing = fx.appdir.parent / "no-such-appimage-or-dir"
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = tool.main([str(missing), str(fx.out)])
        self.assertEqual(code, 1)
        self.assertIn("does not exist", err.getvalue())
        self.assertFalse(fx.out.exists())

    def test_when_dpkg_query_w_fails_for_an_owning_package_the_run_fails_with_the_command_error(self) -> None:
        # A package name `dpkg-query -S` can find but `-W` then rejects
        # (e.g. purged from the dpkg database between the two calls). The
        # stub table is captured when the Fixture is built, so the owning
        # entry must exist before that.
        OWNERS["libbroken.so.1"] = "package-missing-from-status-db"
        self.addCleanup(OWNERS.pop, "libbroken.so.1", None)
        fx = Fixture(self)
        fx.put("usr/lib/libbroken.so.1", ELF)
        code, _, err = fx.run()
        self.assertEqual(code, 1)
        self.assertIn("-W", err)

    def test_when_two_license_names_are_the_same_file_the_text_is_printed_once(self) -> None:
        fx = Fixture(self)
        fx.copyright("libglib2.0-0", "See /usr/share/common-licenses/GPL and /usr/share/common-licenses/GPL-3\n")
        (fx.share / "common-licenses/GPL").write_text("GNU GENERAL PUBLIC LICENSE 3\n")
        (fx.share / "common-licenses/GPL-3").write_text("GNU GENERAL PUBLIC LICENSE 3\n")
        fx.run()
        text = fx.out.read_text()
        self.assertEqual(text.count("GNU GENERAL PUBLIC LICENSE 3"), 1)
        self.assertIn("--- GPL, GPL-3 ---", text)


if __name__ == "__main__":
    unittest.main()
