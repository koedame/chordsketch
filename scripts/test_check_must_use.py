#!/usr/bin/env python3
"""Tests for `check-must-use.py`.

Each test writes a synthetic Rust source into a tempdir, plus one smoke test
that asserts the live `crates/*/src` tree stays clean.
"""
from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

SCRIPTS_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS_DIR))

_spec = importlib.util.spec_from_file_location(
    "check_must_use", SCRIPTS_DIR / "check-must-use.py"
)
assert _spec is not None and _spec.loader is not None
check_must_use = importlib.util.module_from_spec(_spec)
sys.modules["check_must_use"] = check_must_use
_spec.loader.exec_module(check_must_use)


def _missing(source: str) -> list[tuple[int, str]]:
    with TemporaryDirectory() as tmp:
        path = Path(tmp) / "lib.rs"
        path.write_text(source, encoding="utf-8")
        return check_must_use.find_missing(path)


class FindMissingTests(unittest.TestCase):
    def test_pub_fn_returning_result_without_must_use_is_reported(self) -> None:
        self.assertEqual(
            _missing("pub fn parse(s: &str) -> Result<Song, Error> {\n}\n"),
            [(1, "parse")],
        )

    def test_pub_fn_returning_option_without_must_use_is_reported(self) -> None:
        self.assertEqual(
            _missing("impl E {\n    pub fn child(&self) -> Option<&E> {\n    }\n}\n"),
            [(2, "child")],
        )

    def test_multiline_signature_without_must_use_is_reported(self) -> None:
        source = "pub fn f(\n    a: &str,\n) -> Result<(), String> {\n}\n"
        self.assertEqual(_missing(source), [(1, "f")])

    def test_must_use_with_message_above_doc_comment_is_accepted(self) -> None:
        source = (
            "/// Parse.\n"
            '#[must_use = "callers must handle parse errors"]\n'
            "pub fn parse(s: &str) -> Result<Song, Error> {\n}\n"
        )
        self.assertEqual(_missing(source), [])

    def test_must_use_between_other_attributes_is_accepted(self) -> None:
        source = (
            '#[must_use = "x"]\n'
            "#[wasm_bindgen]\n"
            "pub fn f() -> Result<String, JsValue> {\n}\n"
        )
        self.assertEqual(_missing(source), [])

    def test_must_use_of_the_previous_function_is_not_inherited(self) -> None:
        source = (
            '#[must_use = "x"]\n'
            "pub fn a() -> Result<(), E> {\n}\n"
            "\n"
            "pub fn b() -> Result<(), E> {\n}\n"
        )
        self.assertEqual(_missing(source), [(5, "b")])

    def test_pub_fn_returning_plain_value_is_ignored(self) -> None:
        self.assertEqual(_missing("pub fn n() -> usize {\n}\n"), [])

    def test_private_fn_returning_result_is_ignored(self) -> None:
        self.assertEqual(_missing("fn n() -> Result<(), E> {\n}\n"), [])

    def test_fn_in_test_module_is_ignored(self) -> None:
        source = "#[cfg(test)]\nmod tests {\n    pub fn h() -> Result<(), E> {\n    }\n}\n"
        self.assertEqual(_missing(source), [])


class LiveTreeTests(unittest.TestCase):
    def test_every_public_result_or_option_fn_in_the_workspace_has_must_use(self) -> None:
        self.assertEqual(check_must_use.main(), 0)


if __name__ == "__main__":
    unittest.main()
