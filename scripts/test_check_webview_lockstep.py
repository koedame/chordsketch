#!/usr/bin/env python3
"""Tests for `check-webview-lockstep.py`.

Uses only `unittest` from stdlib so CI does not need a `pip install` step.

The synthetic cases build a `Cargo.lock` the way Cargo writes one — a bare
crate name when the lock holds a single version, `name version` once it
holds several — and cover the two ways the WebView2 stack splits: Tauri
moving to a newer `wry` while the handler's `^0.55` requirement stays put,
and the handler's requirement being bumped on its own. A duplicate pulled
in by an unrelated crate must not be reported.

The last case runs against the repository's real `Cargo.lock`.
"""
from __future__ import annotations

import importlib.util
import io
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from tempfile import TemporaryDirectory

SCRIPTS_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPTS_DIR.parent

_spec = importlib.util.spec_from_file_location(
    "check_webview_lockstep", SCRIPTS_DIR / "check-webview-lockstep.py"
)
assert _spec is not None and _spec.loader is not None
checker = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(checker)

REGISTRY = "registry+https://github.com/rust-lang/crates.io-index"


def render_lock(packages: list[tuple[str, str, list[tuple[str, str]]]]) -> str:
    """Render `(name, version, [(dep name, dep version)])` as a Cargo.lock."""
    versions: dict[str, set[str]] = {}
    for name, version, _ in packages:
        versions.setdefault(name, set()).add(version)

    def reference(name: str, version: str) -> str:
        return name if len(versions[name]) == 1 else f"{name} {version}"

    blocks = ["version = 4"]
    for name, version, deps in packages:
        lines = ["[[package]]", f'name = "{name}"', f'version = "{version}"']
        if not name.startswith("chordsketch-"):
            lines.append(f'source = "{REGISTRY}"')
        if deps:
            lines.append("dependencies = [")
            lines += [f' "{reference(n, v)}",' for n, v in deps]
            lines.append("]")
        blocks.append("\n".join(lines))
    return "\n\n".join(blocks) + "\n"


def webview_lock(
    *,
    handler_wry: str = "0.55.0",
    tauri_wry: str = "0.55.0",
    wry_windows: dict[str, str] | None = None,
    handler_windows: str = "0.61.3",
    handler_windows_core: str = "0.61.2",
    extra: list[tuple[str, str, list[tuple[str, str]]]] | None = None,
) -> str:
    """A lock shaped like the desktop workspace's WebView2 corner of the graph.

    `wry_windows` maps each `wry` version to the `windows` version it pulls;
    each `windows` version pulls the `windows-core` of the same minor line.
    """
    wry_windows = wry_windows or {"0.55.0": "0.61.3"}
    core_for = {"0.61.3": "0.61.2", "0.62.2": "0.62.2"}
    tauri_windows = wry_windows[tauri_wry]

    packages = [
        (
            "chordsketch-preview-handler",
            "0.5.0",
            [
                ("windows", handler_windows),
                ("windows-core", handler_windows_core),
                ("wry", handler_wry),
            ],
        ),
        (
            "tauri-runtime-wry",
            "2.11.4",
            [("windows", tauri_windows), ("wry", tauri_wry)],
        ),
    ]
    for wry_version, windows_version in sorted(wry_windows.items()):
        packages.append(
            (
                "wry",
                wry_version,
                [
                    ("windows", windows_version),
                    ("windows-core", core_for[windows_version]),
                ],
            )
        )
    for windows_version in sorted(set(wry_windows.values()) | {handler_windows}):
        packages.append(
            ("windows", windows_version, [("windows-core", core_for[windows_version])])
        )
    for core_version in sorted(
        {core_for[v] for v in wry_windows.values()} | {handler_windows_core}
    ):
        packages.append(("windows-core", core_version, []))
    packages += extra or []
    return render_lock(packages)


class CompareTests(unittest.TestCase):
    def test_both_sides_on_one_stack_report_nothing(self):
        self.assertEqual(checker.compare(webview_lock()), [])

    def test_tauri_moving_to_a_newer_wry_reports_all_three_crates(self):
        # The handler's `wry = "0.55"` keeps resolving 0.55 while Tauri's
        # runtime has moved on, and the newer wry drags a newer windows.
        lock = webview_lock(
            tauri_wry="0.57.0",
            wry_windows={"0.55.0": "0.61.3", "0.57.0": "0.62.2"},
        )
        self.assertEqual(
            checker.compare(lock),
            [
                ("wry", "0.55.0", "0.57.0"),
                ("windows", "0.61.3", "0.62.2"),
                ("windows-core", "0.61.2", "0.62.2"),
            ],
        )

    def test_bumping_only_the_handler_wry_is_reported(self):
        # The shape of a dependency-update PR that raises the handler's
        # requirement ahead of Tauri: same windows line, two wry entries.
        lock = webview_lock(
            handler_wry="0.57.0",
            wry_windows={"0.55.0": "0.61.3", "0.57.0": "0.61.3"},
        )
        self.assertEqual(checker.compare(lock), [("wry", "0.57.0", "0.55.0")])

    def test_handler_windows_behind_tauri_is_reported(self):
        lock = webview_lock(
            wry_windows={"0.55.0": "0.62.2"},
            handler_windows="0.61.3",
            handler_windows_core="0.61.2",
        )
        self.assertEqual(
            checker.compare(lock),
            [
                ("windows", "0.61.3", "0.62.2"),
                ("windows-core", "0.61.2", "0.62.2"),
            ],
        )

    def test_a_duplicate_pulled_by_an_unrelated_crate_is_not_reported(self):
        # `iana-time-zone` resolving its own windows-core puts a second
        # version in the lock without touching either WebView2 consumer.
        lock = webview_lock(
            extra=[
                ("iana-time-zone", "0.1.65", [("windows-core", "0.62.2")]),
                ("windows-core", "0.62.2", []),
            ]
        )
        self.assertIn('"windows-core 0.61.2"', lock)
        self.assertEqual(checker.compare(lock), [])


class LockShapeTests(unittest.TestCase):
    def test_a_missing_handler_entry_fails_instead_of_passing(self):
        lock = webview_lock().replace(
            'name = "chordsketch-preview-handler"', 'name = "renamed-handler"'
        )
        with self.assertRaisesRegex(
            checker.LockError, "chordsketch-preview-handler"
        ):
            checker.compare(lock)

    def test_a_handler_that_stops_depending_on_wry_fails_instead_of_passing(self):
        lock = render_lock(
            [
                ("chordsketch-preview-handler", "0.5.0", [("windows", "0.61.3")]),
                ("tauri-runtime-wry", "2.11.4", [("wry", "0.55.0")]),
                ("wry", "0.55.0", []),
                ("windows", "0.61.3", []),
            ]
        )
        with self.assertRaisesRegex(checker.LockError, "0 dependencies named `wry`"):
            checker.compare(lock)


class MainTests(unittest.TestCase):
    def run_main(self, lock: str) -> int:
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "Cargo.lock"
            path.write_text(lock, encoding="utf-8")
            with redirect_stdout(io.StringIO()):
                return checker.main(["--lockfile", str(path)])

    def test_a_split_stack_exits_nonzero(self):
        lock = webview_lock(
            tauri_wry="0.57.0",
            wry_windows={"0.55.0": "0.61.3", "0.57.0": "0.62.2"},
        )
        self.assertEqual(self.run_main(lock), 1)

    def test_a_malformed_lock_exits_nonzero(self):
        self.assertEqual(self.run_main("version = 4\n"), 1)

    def test_an_aligned_stack_exits_zero(self):
        self.assertEqual(self.run_main(webview_lock()), 0)


class RepositoryTests(unittest.TestCase):
    def test_the_repository_lock_keeps_one_webview2_stack(self):
        text = (REPO_ROOT / "Cargo.lock").read_text(encoding="utf-8")
        self.assertEqual(checker.compare(text), [])


if __name__ == "__main__":
    unittest.main()
