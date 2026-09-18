#!/usr/bin/env python3
"""Tests for `check-version-consistency.py`.

Rather than read the real repo (which would make the test self-referential
and brittle to every future version bump), each test assembles a synthetic
repo root in a tempdir with exactly the files the script looks for. This
isolates the check logic from the real state of the repository.

Tests cover:
  1. Happy path — all versions consistent, no allowlist needed
  2. Unallowlisted drift fails
  3. Allowlisted drift passes
  4. Wrong current_value in an allowlist entry fails
  5. Stale allowlist entry (no matching source) fails
  6. Allowlist with empty tracking_issue fails hard validation
  7. Allowlist with empty reason fails hard validation
  8. Crates disagreeing among themselves fails
  9. readme-smoke pins are detected correctly (regex integration smoke test)
 10. Claude Code plugin / marketplace version drift is detected, and a
     marketplace entry whose `source` no longer names the plugin
     directory fails hard
 11. A framework package's own version drifting from the workspace fails
 12. Path dependency versions, Cargo.lock, the winget InstallerUrl and the
     React README's requirement table drifting fail
 13. `--set` bumps every source, keeps allowlisted ones, dates the release,
     keeps the lockfiles in step, and changes nothing when run again
"""

from __future__ import annotations

import argparse
import importlib.util
import io
import json
import sys
import textwrap
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from tempfile import TemporaryDirectory

SCRIPTS_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS_DIR))

_spec = importlib.util.spec_from_file_location(
    "check_version_consistency", SCRIPTS_DIR / "check-version-consistency.py"
)
assert _spec is not None and _spec.loader is not None
check_version_consistency = importlib.util.module_from_spec(_spec)
sys.modules["check_version_consistency"] = check_version_consistency
_spec.loader.exec_module(check_version_consistency)


# ---------------------------------------------------------------- fixture builder


def _build_repo(
    root: Path,
    *,
    crate_versions: dict[str, str] | None = None,
    npm_version: str = "0.2.0",
    npm_export_version: str = "0.2.0",
    vscode_version: str = "0.2.0",
    napi_version: str = "0.2.0",
    tree_sitter_version: str = "0.2.0",
    framework_versions: dict[str, str] | None = None,
    plugin_version: str = "0.2.0",
    marketplace_version: str = "0.2.0",
    plugin_source: str = "packages/claude-code-plugin",
    smoke_npm_pin: str = "0.2.0",
    smoke_caret: str = "0.2",
    macports_version: str = "0.2.0",
    nix_version: str = "0.2.0",
    winget_version: str = "0.2.0",
    winget_url_version: str = "0.2.0",
    flatpak_release_version: str = "0.2.0",
    path_dependency_version: str = "0.2.0",
    cargo_lock_version: str = "0.2.0",
    readme_pin: str | None = None,
) -> None:
    """Build a minimal repo layout under `root` that satisfies every extractor.

    Defaults produce an all-consistent repo at version 0.2.0. Override any
    kwarg to inject drift.
    """
    crate_versions = crate_versions or {
        "core": "0.2.0",
        "cli": "0.2.0",
    }
    framework_versions = {
        name: "0.2.0" for name in check_version_consistency.FRAMEWORK_PACKAGE_DIRS
    } | (framework_versions or {})

    # crates/*/Cargo.toml. Every crate but `core` depends on `core` by path.
    for name, version in crate_versions.items():
        d = root / "crates" / name
        d.mkdir(parents=True, exist_ok=True)
        dependency = (
            ""
            if name == "core"
            else f'\n[dependencies]\nchordsketch-core = {{ version = "{path_dependency_version}", path = "../core" }}\n'
        )
        (d / "Cargo.toml").write_text(
            f'[package]\nname = "chordsketch-{name}"\nversion = "{version}"\nedition = "2021"\n{dependency}',
            encoding="utf-8",
        )

    # Cargo.lock: the workspace crates, and one registry crate, which carries
    # a `source` line and a checksum.
    (root / "Cargo.lock").write_text(
        "version = 4\n\n"
        + "".join(
            f'[[package]]\nname = "chordsketch-{name}"\nversion = "{cargo_lock_version}"\n\n'
            for name in sorted(set(crate_versions) | {"napi"})
        )
        + '[[package]]\nname = "chordsketch-legacy"\nversion = "0.0.1"\n'
        + 'source = "registry+https://github.com/rust-lang/crates.io-index"\n'
        + f'checksum = "{"b" * 64}"\n\n'
        + '[[package]]\nname = "memchr"\nversion = "2.7.4"\n'
        + 'source = "registry+https://github.com/rust-lang/crates.io-index"\n'
        + f'checksum = "{"a" * 64}"\n',
        encoding="utf-8",
    )

    # CHANGELOG.md
    (root / "CHANGELOG.md").write_text(
        "# Changelog\n\n## [Unreleased]\n\n### Added\n\n- Something new.\n\n"
        "## [0.1.0] - 2026-01-01\n\n- The first release.\n",
        encoding="utf-8",
    )

    # packaging/flatpak metainfo — the newest release is checked
    flatpak_dir = root / "packaging" / "flatpak"
    flatpak_dir.mkdir(parents=True, exist_ok=True)
    (flatpak_dir / "io.github.koedame.chordsketch.metainfo.xml").write_text(
        "<component>\n  <releases>\n"
        f'    <release version="{flatpak_release_version}" date="2026-02-01">\n'
        f'      <url type="details">https://github.com/koedame/chordsketch/releases/tag/desktop-v{flatpak_release_version}</url>\n'
        "    </release>\n"
        '    <release version="0.1.0" date="2026-01-01"/>\n'
        "  </releases>\n</component>\n",
        encoding="utf-8",
    )

    # crates/napi/package.json — the check script explicitly looks at this
    napi_dir = root / "crates" / "napi"
    napi_dir.mkdir(parents=True, exist_ok=True)
    (napi_dir / "Cargo.toml").write_text(
        textwrap.dedent(
            f"""
            [package]
            name = "chordsketch-napi"
            version = "{crate_versions.get('napi', '0.2.0')}"
            """
        ).strip()
        + "\n",
        encoding="utf-8",
    )
    (napi_dir / "package.json").write_text(
        f'{{\n  "name": "@chordsketch/node",\n  "version": "{napi_version}"\n}}\n',
        encoding="utf-8",
    )

    # packages/npm/package.json
    npm_dir = root / "packages" / "npm"
    npm_dir.mkdir(parents=True, exist_ok=True)
    (npm_dir / "package.json").write_text(
        f'{{\n  "name": "@chordsketch/wasm",\n  "version": "{npm_version}"\n}}\n',
        encoding="utf-8",
    )

    # packages/tree-sitter-chordpro/package.json
    ts_dir = root / "packages" / "tree-sitter-chordpro"
    ts_dir.mkdir(parents=True, exist_ok=True)
    (ts_dir / "package.json").write_text(
        f'{{\n  "name": "tree-sitter-chordpro",\n  "version": "{tree_sitter_version}"\n}}\n',
        encoding="utf-8",
    )

    # The Claude Code plugin's two manifests (ADR-0059). Both declare the
    # same version: the plugin's own, and the root marketplace entry that
    # points at it.
    plugin_dir = root / "packages" / "claude-code-plugin" / ".claude-plugin"
    plugin_dir.mkdir(parents=True, exist_ok=True)
    (plugin_dir / "plugin.json").write_text(
        f'{{\n  "name": "chordsketch",\n  "version": "{plugin_version}"\n}}\n',
        encoding="utf-8",
    )
    marketplace_dir = root / ".claude-plugin"
    marketplace_dir.mkdir(parents=True, exist_ok=True)
    (marketplace_dir / "marketplace.json").write_text(
        f'{{\n  "name": "chordsketch",\n  "plugins": [\n'
        f'    {{ "name": "chordsketch", "source": "./{plugin_source}",\n'
        f'      "version": "{marketplace_version}" }}\n'
        f"  ]\n}}\n",
        encoding="utf-8",
    )

    # packages/npm-export/package.json — wasm-export's heavy bundle, lockstep with wasm
    npm_export_dir = root / "packages" / "npm-export"
    npm_export_dir.mkdir(parents=True, exist_ok=True)
    (npm_export_dir / "package.json").write_text(
        f'{{\n  "name": "@chordsketch/wasm-export",\n  "version": "{npm_export_version}"\n}}\n',
        encoding="utf-8",
    )

    # packages/vscode-extension/package.json — also pins @chordsketch/wasm
    # in its dependencies block, which load_consumer_pin_constraints checks.
    consumer_pin = f"^{smoke_caret}.0"
    vscode_dir = root / "packages" / "vscode-extension"
    vscode_dir.mkdir(parents=True, exist_ok=True)
    (vscode_dir / "package.json").write_text(
        textwrap.dedent(
            f"""
            {{
              "name": "chordsketch",
              "version": "{vscode_version}",
              "dependencies": {{
                "@chordsketch/wasm": "{consumer_pin}"
              }}
            }}
            """
        ).strip()
        + "\n",
        encoding="utf-8",
    )

    # packages/react/package.json — pins @chordsketch/wasm (dep) and
    # @chordsketch/wasm-export (peerDep), and versions with the workspace.
    react_dir = root / "packages" / "react"
    react_dir.mkdir(parents=True, exist_ok=True)
    (react_dir / "package.json").write_text(
        textwrap.dedent(
            f"""
            {{
              "name": "@chordsketch/react",
              "version": "{framework_versions['react']}",
              "dependencies": {{
                "@chordsketch/wasm": "{consumer_pin}"
              }},
              "peerDependencies": {{
                "@chordsketch/wasm-export": "{consumer_pin}"
              }}
            }}
            """
        ).strip()
        + "\n",
        encoding="utf-8",
    )

    # packages/vue/package.json and packages/svelte/package.json — the
    # same dep + peerDep pin shape as react.
    for framework in ("vue", "svelte"):
        framework_dir = root / "packages" / framework
        framework_dir.mkdir(parents=True, exist_ok=True)
        (framework_dir / "package.json").write_text(
            textwrap.dedent(
                f"""
                {{
                  "name": "@chordsketch/{framework}",
                  "version": "{framework_versions[framework]}",
                  "dependencies": {{
                    "@chordsketch/wasm": "{consumer_pin}"
                  }},
                  "peerDependencies": {{
                    "@chordsketch/wasm-export": "{consumer_pin}"
                  }}
                }}
                """
            ).strip()
            + "\n",
            encoding="utf-8",
        )

    # packages/react-ui and packages/chordpro-lite — no @chordsketch/wasm pin.
    for name in ("react-ui", "chordpro-lite"):
        package_dir = root / "packages" / name
        package_dir.mkdir(parents=True, exist_ok=True)
        (package_dir / "package.json").write_text(
            f'{{\n  "name": "@chordsketch/{name}",\n  "version": "{framework_versions[name]}"\n}}\n',
            encoding="utf-8",
        )

    # packages/ui-irealb-editor/package.json — private workspace package
    # that peer-depends on @chordsketch/wasm.
    irealb_dir = root / "packages" / "ui-irealb-editor"
    irealb_dir.mkdir(parents=True, exist_ok=True)
    (irealb_dir / "package.json").write_text(
        textwrap.dedent(
            f"""
            {{
              "name": "@chordsketch/ui-irealb-editor",
              "private": true,
              "version": "0.0.0",
              "peerDependencies": {{
                "@chordsketch/wasm": "{consumer_pin}"
              }}
            }}
            """
        ).strip()
        + "\n",
        encoding="utf-8",
    )

    # The lockfile of every consumer that installs @chordsketch/wasm links the
    # in-tree packages/npm (ADR-0073).
    for name in ("vscode-extension", "react", "vue", "svelte", "ui-irealb-editor"):
        (root / "packages" / name / "package-lock.json").write_text(
            json.dumps({"packages": {"node_modules/@chordsketch/wasm": {"resolved": "../npm", "link": True}}}),
            encoding="utf-8",
        )
    # React's lockfile is written the way npm writes it, with the copies of
    # its own manifest and of the linked packages/npm.
    react_manifest = json.loads((react_dir / "package.json").read_text(encoding="utf-8"))
    (react_dir / "package-lock.json").write_text(
        json.dumps(
            {
                "name": "@chordsketch/react",
                "version": react_manifest["version"],
                "lockfileVersion": 3,
                "packages": {
                    "": {
                        "name": "@chordsketch/react",
                        "version": react_manifest["version"],
                        "dependencies": {**react_manifest["dependencies"], "react": "^18.0.0"},
                        "peerDependencies": react_manifest["peerDependencies"],
                    },
                    "../npm": {"name": "@chordsketch/wasm", "version": npm_version},
                    "node_modules/@chordsketch/wasm": {"resolved": "../npm", "link": True},
                    "node_modules/react": {"version": "18.3.1"},
                },
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    readme_pin = readme_pin or consumer_pin
    (react_dir / "README.md").write_text(
        "| Peer | Version range | Notes |\n|------|----------------|-------|\n"
        f"| `@chordsketch/wasm` | `{readme_pin}` (runtime dep) | Bundled. |\n"
        f"| `@chordsketch/wasm-export` | `{readme_pin}` (optional peer) | Lazy-loaded. |\n",
        encoding="utf-8",
    )

    # .github/workflows/readme-smoke.yml
    workflows_dir = root / ".github" / "workflows"
    workflows_dir.mkdir(parents=True, exist_ok=True)
    (workflows_dir / "readme-smoke.yml").write_text(
        textwrap.dedent(
            f"""
            # synthetic fixture
            jobs:
              npm-wasm:
                env:
                  WASM_VERSION: "{smoke_npm_pin}"
                steps:
                  - run: |
                      npm install "@chordsketch/wasm@${{WASM_VERSION}}"
              npm-wasm-export:
                env:
                  WASM_EXPORT_VERSION: "{smoke_npm_pin}"
                steps:
                  - run: |
                      npm install "@chordsketch/wasm-export@${{WASM_EXPORT_VERSION}}"
              library-smoke:
                steps:
                  - run: |
                      CORE_DEP='chordsketch-chordpro = "^{smoke_caret}"'
                      RENDER_DEP='chordsketch-render-text = "^{smoke_caret}"'
            """
        ).strip()
        + "\n",
        encoding="utf-8",
    )

    # packaging/macports/Portfile
    macports_dir = root / "packaging" / "macports"
    macports_dir.mkdir(parents=True, exist_ok=True)
    (macports_dir / "Portfile").write_text(
        textwrap.dedent(
            f"""
            # Reference Portfile for MacPorts submission.
            PortSystem          1.0
            PortGroup           github 1.0
            github.setup        koedame chordsketch {macports_version} v

            cargo.crates \\
                chordsketch-legacy                0.0.1  {"b" * 64} \\
                memchr                            2.7.4  {"a" * 64}

            destroot {{}}
            """
        ).strip()
        + "\n",
        encoding="utf-8",
    )

    # packaging/nix/package.nix
    nix_dir = root / "packaging" / "nix"
    nix_dir.mkdir(parents=True, exist_ok=True)
    (nix_dir / "package.nix").write_text(
        textwrap.dedent(
            f"""
            {{ lib, rustPlatform, fetchFromGitHub }}:
            rustPlatform.buildRustPackage rec {{
              pname = "chordsketch";
              version = "{nix_version}";
            }}
            """
        ).strip()
        + "\n",
        encoding="utf-8",
    )

    # packaging/winget/*.yaml
    winget_dir = root / "packaging" / "winget"
    winget_dir.mkdir(parents=True, exist_ok=True)
    for manifest in (
        "koedame.chordsketch.yaml",
        "koedame.chordsketch.installer.yaml",
        "koedame.chordsketch.locale.en-US.yaml",
    ):
        installer = (
            "Installers:\n  - Architecture: x64\n"
            f"    InstallerUrl: https://github.com/koedame/chordsketch/releases/download/v{winget_url_version}/"
            f"chordsketch-v{winget_url_version}-x86_64-pc-windows-msvc.zip\n"
            if manifest.endswith(".installer.yaml")
            else ""
        )
        (winget_dir / manifest).write_text(
            f"PackageIdentifier: koedame.chordsketch\nPackageVersion: {winget_version}\n{installer}",
            encoding="utf-8",
        )


def _write_allowlist(path: Path, entries: list[dict]) -> None:
    lines = []
    for e in entries:
        lines.append("[[allowed_skews]]")
        for k, v in e.items():
            if isinstance(v, str) and "\n" in v:
                lines.append(f'{k} = """\n{v}\n"""')
            else:
                lines.append(f'{k} = "{v}"')
        lines.append("")
    path.write_text("\n".join(lines), encoding="utf-8")


# ---------------------------------------------------------------- tests


class CheckRunTests(unittest.TestCase):
    def test_happy_path(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td)
            _build_repo(root)
            rc = check_version_consistency.run(root, root / "nonexistent.toml")
            self.assertEqual(rc, 0)

    def test_unallowlisted_drift_fails(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td)
            _build_repo(root, npm_version="0.1.5")
            rc = check_version_consistency.run(root, root / "nonexistent.toml")
            self.assertEqual(rc, 1)

    def test_tree_sitter_drift_detected(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td)
            _build_repo(root, tree_sitter_version="0.1.0")
            rc = check_version_consistency.run(root, root / "nonexistent.toml")
            self.assertEqual(rc, 1)

    def test_claude_code_plugin_drift_detected(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td)
            _build_repo(root, plugin_version="0.1.0")
            rc = check_version_consistency.run(root, root / "nonexistent.toml")
            self.assertEqual(rc, 1)

    def test_marketplace_entry_drift_detected(self) -> None:
        # The marketplace entry is a second copy of the same number; a bump
        # that updates only plugin.json leaves installs pointing at the old
        # version, so it has to fail on its own.
        with TemporaryDirectory() as td:
            root = Path(td)
            _build_repo(root, marketplace_version="0.1.0")
            rc = check_version_consistency.run(root, root / "nonexistent.toml")
            self.assertEqual(rc, 1)

    def test_marketplace_source_pointing_elsewhere_fails_hard(self) -> None:
        # Every version can agree while the entry names a directory that does
        # not exist — the install then fails for everyone and no version check
        # notices.
        with TemporaryDirectory() as td:
            root = Path(td)
            _build_repo(root, plugin_source="packages/renamed-plugin")
            with self.assertRaises(SystemExit):
                check_version_consistency.run(root, root / "nonexistent.toml")

    def test_allowlisted_drift_passes(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td)
            _build_repo(root, npm_version="0.1.5")
            allowlist_path = root / "version-skew-allowlist.toml"
            _write_allowlist(
                allowlist_path,
                [
                    {
                        "file": "packages/npm/package.json",
                        "field": "version",
                        "current_value": "0.1.5",
                        "reason": "test fixture",
                        "expires_at": "never",
                        "tracking_issue": "9999",
                    }
                ],
            )
            rc = check_version_consistency.run(root, allowlist_path)
            self.assertEqual(rc, 0)

    def test_wrong_current_value_in_allowlist_fails(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td)
            _build_repo(root, npm_version="0.1.5")
            allowlist_path = root / "version-skew-allowlist.toml"
            _write_allowlist(
                allowlist_path,
                [
                    {
                        "file": "packages/npm/package.json",
                        "field": "version",
                        "current_value": "0.1.4",  # wrong!
                        "reason": "stale",
                        "expires_at": "never",
                        "tracking_issue": "9999",
                    }
                ],
            )
            rc = check_version_consistency.run(root, allowlist_path)
            self.assertEqual(rc, 1)

    def test_wrong_current_value_is_not_reported_as_stale(self) -> None:
        """Regression test for #1513.

        When an allowlist entry has a wrong `current_value` but the source
        is still drifting, the entry is load-bearing (just inaccurate) —
        it must be reported as a drift but NOT also as a stale entry. The
        misleading "no matching source found — the drift has been
        resolved" message would have told maintainers to remove the
        entry (wrong action) when they should update `current_value`
        (right action).
        """
        from io import StringIO
        from contextlib import redirect_stdout

        with TemporaryDirectory() as td:
            root = Path(td)
            _build_repo(root, npm_version="0.1.5")
            allowlist_path = root / "version-skew-allowlist.toml"
            _write_allowlist(
                allowlist_path,
                [
                    {
                        "file": "packages/npm/package.json",
                        "field": "version",
                        "current_value": "0.1.4",  # wrong — source is 0.1.5
                        "reason": "test fixture",
                        "expires_at": "never",
                        "tracking_issue": "9999",
                    }
                ],
            )
            buf = StringIO()
            with redirect_stdout(buf):
                rc = check_version_consistency.run(root, allowlist_path)
            output = buf.getvalue()
            self.assertEqual(rc, 1)
            # The drift message must fire.
            self.assertIn("says current_value='0.1.4' but actual value is '0.1.5'", output)
            # The stale-entry message must NOT fire — the entry is still
            # load-bearing.
            self.assertNotIn("stale allowlist entry", output)
            self.assertNotIn("drift has been resolved", output)

    def test_stale_allowlist_entry_fails(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td)
            _build_repo(root)  # all 0.2.0, no drift
            allowlist_path = root / "version-skew-allowlist.toml"
            _write_allowlist(
                allowlist_path,
                [
                    {
                        "file": "packages/npm/package.json",
                        "field": "version",
                        "current_value": "0.1.5",
                        "reason": "test",
                        "expires_at": "never",
                        "tracking_issue": "9999",
                    }
                ],
            )
            rc = check_version_consistency.run(root, allowlist_path)
            self.assertEqual(rc, 1)

    def test_missing_tracking_issue_fails_hard(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td)
            _build_repo(root, npm_version="0.1.5")
            allowlist_path = root / "version-skew-allowlist.toml"
            _write_allowlist(
                allowlist_path,
                [
                    {
                        "file": "packages/npm/package.json",
                        "field": "version",
                        "current_value": "0.1.5",
                        "reason": "test",
                        "expires_at": "never",
                        "tracking_issue": "",  # empty!
                    }
                ],
            )
            with self.assertRaises(SystemExit) as ctx:
                check_version_consistency.run(root, allowlist_path)
            self.assertIn("tracking_issue", str(ctx.exception))

    def test_missing_reason_fails_hard(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td)
            _build_repo(root, npm_version="0.1.5")
            allowlist_path = root / "version-skew-allowlist.toml"
            _write_allowlist(
                allowlist_path,
                [
                    {
                        "file": "packages/npm/package.json",
                        "field": "version",
                        "current_value": "0.1.5",
                        "reason": "",
                        "expires_at": "never",
                        "tracking_issue": "9999",
                    }
                ],
            )
            with self.assertRaises(SystemExit) as ctx:
                check_version_consistency.run(root, allowlist_path)
            self.assertIn("empty reason", str(ctx.exception))

    def test_crates_disagree_fails_hard(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td)
            _build_repo(
                root,
                crate_versions={"core": "0.2.0", "cli": "0.1.9"},
            )
            with self.assertRaises(SystemExit) as ctx:
                check_version_consistency.run(root, root / "nonexistent.toml")
            self.assertIn("disagree", str(ctx.exception))

    def test_readme_smoke_pin_drift_detected(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td)
            _build_repo(root, smoke_npm_pin="0.1.1", smoke_caret="0.1")
            rc = check_version_consistency.run(root, root / "nonexistent.toml")
            self.assertEqual(rc, 1)

    def test_framework_binding_pin_drift_detected(self) -> None:
        # Regression guard: the vue and svelte bindings pin
        # @chordsketch/wasm / @chordsketch/wasm-export the same way react
        # does, but were missing from _CONSUMER_PINS, so a release cut
        # left their caret on the previous minor without tripping CI.
        for framework in ("vue", "svelte"):
            for block, dep in (
                ("dependencies", "@chordsketch/wasm"),
                ("peerDependencies", "@chordsketch/wasm-export"),
            ):
                with self.subTest(framework=framework, block=block), TemporaryDirectory() as td:
                    root = Path(td)
                    _build_repo(root)
                    manifest = root / "packages" / framework / "package.json"
                    data = json.loads(manifest.read_text(encoding="utf-8"))
                    data[block][dep] = "^0.0.1"
                    manifest.write_text(json.dumps(data), encoding="utf-8")
                    rc = check_version_consistency.run(root, root / "nonexistent.toml")
                    self.assertEqual(rc, 1)

    def test_when_a_consumer_lockfile_installs_wasm_from_npm_the_check_fails(self) -> None:
        # The release commit raises the pins to a version npm does not serve
        # yet (ADR-0073); a lockfile that resolves it from npm cannot install
        # at that commit.
        for name in ("vscode-extension", "react", "vue", "svelte", "ui-irealb-editor"):
            with self.subTest(package=name), TemporaryDirectory() as td:
                root = Path(td)
                _build_repo(root)
                lockfile = root / "packages" / name / "package-lock.json"
                lockfile.write_text(
                    json.dumps(
                        {
                            "packages": {
                                "node_modules/@chordsketch/wasm": {
                                    "version": "0.2.0",
                                    "resolved": "https://registry.npmjs.org/@chordsketch/wasm/-/wasm-0.2.0.tgz",
                                }
                            }
                        }
                    ),
                    encoding="utf-8",
                )
                problems = check_version_consistency.lockfile_link_problems(root)
                self.assertEqual(len(problems), 1)
                self.assertIn(f"packages/{name}/package-lock.json", problems[0])
                self.assertIn("registry.npmjs.org", problems[0])
                self.assertEqual(check_version_consistency.run(root, root / "nonexistent.toml"), 1)

    def test_when_a_consumer_lockfile_is_missing_the_check_fails(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td)
            _build_repo(root)
            (root / "packages" / "vue" / "package-lock.json").unlink()
            self.assertEqual(
                check_version_consistency.lockfile_link_problems(root),
                ["packages/vue/package-lock.json: file not found"],
            )

    def test_framework_package_version_drift_detected(self) -> None:
        # These packages publish with the workspace release (ADR-0073), so
        # one left at its previous version would be skipped by the publish
        # as already served, or published at a version the tag never named.
        for name in check_version_consistency.FRAMEWORK_PACKAGE_DIRS:
            with self.subTest(package=name), TemporaryDirectory() as td:
                root = Path(td)
                _build_repo(root, framework_versions={name: "0.1.0"})
                rc = check_version_consistency.run(root, root / "nonexistent.toml")
                self.assertEqual(rc, 1)

    # -- packaging/<channel>/ drift detection (#1864) --------------------

    def test_macports_portfile_drift_detected(self) -> None:
        # Regression guard: #1864 observed that packaging/macports/Portfile
        # silently stayed at 0.2.0 across two releases. The extractor must
        # detect the drift instead of the human-audit-at-release path.
        with TemporaryDirectory() as td:
            root = Path(td)
            _build_repo(root, macports_version="0.1.0")
            rc = check_version_consistency.run(root, root / "nonexistent.toml")
            self.assertEqual(rc, 1)

    def test_nix_package_drift_detected(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td)
            _build_repo(root, nix_version="0.1.0")
            rc = check_version_consistency.run(root, root / "nonexistent.toml")
            self.assertEqual(rc, 1)

    def test_winget_manifest_drift_detected(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td)
            _build_repo(root, winget_version="0.1.0")
            rc = check_version_consistency.run(root, root / "nonexistent.toml")
            self.assertEqual(rc, 1)

    def test_when_the_flatpak_metainfo_has_no_release_for_the_version_the_check_fails(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td)
            _build_repo(root, flatpak_release_version="0.1.1")
            rc = check_version_consistency.run(root, root / "nonexistent.toml")
            self.assertEqual(rc, 1)

    def test_when_a_path_dependency_on_a_workspace_crate_lags_the_check_fails(self) -> None:
        # crates.io resolves the dependency by this version once the crates are
        # published, so a stale one names a release that is not the one built.
        with TemporaryDirectory() as td:
            root = Path(td)
            _build_repo(root, path_dependency_version="0.1.0")
            self.assertEqual(check_version_consistency.run(root, root / "nonexistent.toml"), 1)

    def test_when_cargo_lock_records_another_version_of_a_workspace_crate_the_check_fails(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td)
            _build_repo(root, cargo_lock_version="0.1.0")
            self.assertEqual(check_version_consistency.run(root, root / "nonexistent.toml"), 1)

    def test_when_the_winget_installer_url_names_another_release_the_check_fails(self) -> None:
        # winget installs whatever the URL points at, under PackageVersion.
        with TemporaryDirectory() as td:
            root = Path(td)
            _build_repo(root, winget_url_version="0.1.0")
            self.assertEqual(check_version_consistency.run(root, root / "nonexistent.toml"), 1)

    def test_when_only_the_winget_asset_name_names_another_release_the_check_fails(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td)
            _build_repo(root)
            installer = root / "packaging/winget/koedame.chordsketch.installer.yaml"
            installer.write_text(
                installer.read_text(encoding="utf-8").replace("chordsketch-v0.2.0-", "chordsketch-v0.1.0-"), encoding="utf-8"
            )
            self.assertEqual(check_version_consistency.run(root, root / "nonexistent.toml"), 1)

    def test_when_a_winget_installer_url_does_not_name_a_release_the_check_fails_hard(self) -> None:
        # Unreadable, it would be neither checked nor bumped.
        with TemporaryDirectory() as td:
            root = Path(td)
            _build_repo(root)
            installer = root / "packaging/winget/koedame.chordsketch.installer.yaml"
            installer.write_text(
                installer.read_text(encoding="utf-8").replace("chordsketch-v0.2.0-", "chordsketch-0.2.0-"), encoding="utf-8"
            )
            with self.assertRaises(SystemExit) as ctx:
                check_version_consistency.run(root, root / "nonexistent.toml")
            self.assertIn("InstallerUrl", str(ctx.exception))

    def test_when_a_registry_crate_shares_the_workspace_prefix_cargo_lock_does_not_hold_it_to_the_workspace(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td)
            _build_repo(root)
            fields = {s.field for s in check_version_consistency.load_cargo_lock_versions(root)}
            self.assertIn("package chordsketch-core version", fields)
            self.assertNotIn("package chordsketch-legacy version", fields)

    def test_when_the_react_readme_requirement_lags_the_manifest_the_check_fails(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td)
            _build_repo(root, readme_pin="^0.1.0")
            self.assertEqual(check_version_consistency.run(root, root / "nonexistent.toml"), 1)

    def test_winget_manifest_without_package_version_fails_hard(self) -> None:
        # A winget yaml that omits `PackageVersion:` is a structural
        # defect (every manifest type requires it per the schema). The
        # check must fail hard so the author registers it, rather than
        # silently skipping the file and letting CI pass.
        with TemporaryDirectory() as td:
            root = Path(td)
            _build_repo(root)
            # Replace one manifest with one that lacks PackageVersion.
            (root / "packaging" / "winget" / "koedame.chordsketch.yaml").write_text(
                "PackageIdentifier: koedame.chordsketch\n",
                encoding="utf-8",
            )
            with self.assertRaises(SystemExit) as ctx:
                check_version_consistency.run(root, root / "nonexistent.toml")
            self.assertIn("PackageVersion", str(ctx.exception))


class SetVersionTests(unittest.TestCase):
    """`--set X.Y.Z`: the release bump."""

    def _set(self, root: Path, version: str, *, allowlist: Path | None = None, released: str = "2026-03-01") -> list[str]:
        return check_version_consistency.set_version(root, allowlist or root / "nonexistent.toml", version, released)

    def _values(self, root: Path) -> dict[tuple[str, str], str]:
        return {(s.file, s.field): s.value for s in check_version_consistency.load_all_sources(root)}

    def test_when_a_repo_is_bumped_to_a_minor_release_every_source_is_at_it_and_the_check_passes(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td)
            _build_repo(root)
            self._set(root, "0.3.0")
            buf = io.StringIO()
            with redirect_stdout(buf):
                rc = check_version_consistency.run(root, root / "nonexistent.toml")
            self.assertEqual(rc, 0, buf.getvalue())
            self.assertIn("canonical version (from crates/*/Cargo.toml): 0.3.0", buf.getvalue())
            for (file, field), value in self._values(root).items():
                with self.subTest(file=file, field=field):
                    self.assertEqual(value, "0.3" if field.endswith("(^major.minor)") else "0.3.0")

    def test_when_a_repo_is_bumped_to_a_minor_release_the_wasm_pins_become_caret_major_minor_zero(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td)
            _build_repo(root)
            self._set(root, "0.3.0")
            react = json.loads((root / "packages/react/package.json").read_text(encoding="utf-8"))
            self.assertEqual(react["dependencies"]["@chordsketch/wasm"], "^0.3.0")
            self.assertEqual(react["peerDependencies"]["@chordsketch/wasm-export"], "^0.3.0")
            self.assertIn("| `@chordsketch/wasm` | `^0.3.0` (runtime dep) |", (root / "packages/react/README.md").read_text(encoding="utf-8"))
            smoke = (root / ".github/workflows/readme-smoke.yml").read_text(encoding="utf-8")
            self.assertIn("""CORE_DEP='chordsketch-chordpro = "^0.3"'""", smoke)
            self.assertIn("""RENDER_DEP='chordsketch-render-text = "^0.3"'""", smoke)

    def test_when_a_repo_is_bumped_to_a_patch_release_the_wasm_pins_name_the_patch(self) -> None:
        # The packages built on the wasm are tested against the one released
        # with them, so they require it (ADR-0073).
        with TemporaryDirectory() as td:
            root = Path(td)
            _build_repo(root)
            self._set(root, "0.2.1")
            react = json.loads((root / "packages/react/package.json").read_text(encoding="utf-8"))
            self.assertEqual(react["version"], "0.2.1")
            self.assertEqual(react["dependencies"]["@chordsketch/wasm"], "^0.2.1")
            self.assertEqual(react["peerDependencies"]["@chordsketch/wasm-export"], "^0.2.1")
            self.assertEqual(check_version_consistency.run(root, root / "nonexistent.toml"), 0)

    def test_when_a_source_is_allowlisted_the_bump_leaves_it_at_its_declared_value(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td)
            _build_repo(root, npm_version="0.1.5")
            allowlist = root / "version-skew-allowlist.toml"
            _write_allowlist(
                allowlist,
                [
                    {
                        "file": "packages/npm/package.json",
                        "field": "version",
                        "current_value": "0.1.5",
                        "reason": "test fixture",
                        "expires_at": "never",
                        "tracking_issue": "9999",
                    }
                ],
            )
            self._set(root, "0.3.0", allowlist=allowlist)
            self.assertEqual(self._values(root)[("packages/npm/package.json", "version")], "0.1.5")
            self.assertEqual(self._values(root)[("packages/npm-export/package.json", "version")], "0.3.0")
            self.assertEqual(check_version_consistency.run(root, allowlist), 0)

    def test_when_a_repo_is_bumped_the_changelog_dates_the_unreleased_entries_under_the_version(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td)
            _build_repo(root)
            self._set(root, "0.3.0", released="2026-03-01")
            self.assertEqual(
                (root / "CHANGELOG.md").read_text(encoding="utf-8"),
                "# Changelog\n\n## [Unreleased]\n\n## [0.3.0] - 2026-03-01\n\n### Added\n\n- Something new.\n\n"
                "## [0.1.0] - 2026-01-01\n\n- The first release.\n",
            )

    def _assert_refused_without_writing(self, root: Path, version: str, message: str) -> None:
        before = {p: p.read_bytes() for p in root.rglob("*") if p.is_file()}
        with self.assertRaises(SystemExit) as ctx:
            self._set(root, version)
        self.assertIn(message, str(ctx.exception))
        self.assertEqual({p: p.read_bytes() for p in root.rglob("*") if p.is_file()}, before)

    def test_when_the_changelog_has_no_unreleased_heading_the_bump_is_refused_before_writing(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td)
            _build_repo(root)
            (root / "CHANGELOG.md").write_text("# Changelog\n\n## [0.1.0] - 2026-01-01\n", encoding="utf-8")
            self._assert_refused_without_writing(root, "0.3.0", "no `## [Unreleased]`")

    def test_when_the_unreleased_section_is_empty_the_bump_is_refused_before_writing(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td)
            _build_repo(root)
            (root / "CHANGELOG.md").write_text(
                "# Changelog\n\n## [Unreleased]\n\n## [0.1.0] - 2026-01-01\n", encoding="utf-8"
            )
            self._assert_refused_without_writing(root, "0.3.0", "is empty")

    def test_when_the_changelog_already_has_an_undated_heading_for_the_version_the_bump_is_refused(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td)
            _build_repo(root)
            (root / "CHANGELOG.md").write_text(
                "# Changelog\n\n## [Unreleased]\n\n## [0.3.0] - Unreleased\n\n- Something new.\n", encoding="utf-8"
            )
            self._assert_refused_without_writing(root, "0.3.0", "is not dated")

    def test_when_the_version_is_older_than_the_workspace_the_bump_is_refused_before_writing(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td)
            _build_repo(root)
            self._assert_refused_without_writing(root, "0.1.9", "older than the workspace's 0.2.0")

    def test_when_a_repo_is_bumped_the_flatpak_metainfo_gains_a_dated_release_in_front_of_the_history(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td)
            _build_repo(root)
            self._set(root, "0.3.0", released="2026-03-01")
            text = (root / "packaging/flatpak/io.github.koedame.chordsketch.metainfo.xml").read_text(encoding="utf-8")
            self.assertIn(
                "  <releases>\n"
                '    <release version="0.3.0" date="2026-03-01">\n'
                '      <url type="details">https://github.com/koedame/chordsketch/releases/tag/desktop-v0.3.0</url>\n'
                "    </release>\n"
                '    <release version="0.2.0" date="2026-02-01">\n',
                text,
            )
            self.assertIn('<release version="0.1.0" date="2026-01-01"/>', text)

    def test_when_a_repo_is_bumped_the_lockfile_follows_its_manifests_and_nothing_else(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td)
            _build_repo(root)
            self._set(root, "0.3.0")
            lock = json.loads((root / "packages/react/package-lock.json").read_text(encoding="utf-8"))
            self.assertEqual(lock["version"], "0.3.0")
            self.assertEqual(lock["packages"][""]["version"], "0.3.0")
            self.assertEqual(
                lock["packages"][""]["dependencies"], {"@chordsketch/wasm": "^0.3.0", "react": "^18.0.0"}
            )
            self.assertEqual(lock["packages"][""]["peerDependencies"], {"@chordsketch/wasm-export": "^0.3.0"})
            self.assertEqual(lock["packages"]["../npm"]["version"], "0.3.0")
            self.assertEqual(lock["packages"]["node_modules/react"], {"version": "18.3.1"})
            self.assertEqual(check_version_consistency.lockfile_link_problems(root), [])

    def test_when_the_macports_crates_lag_cargo_lock_the_bump_regenerates_them(self) -> None:
        # The Portfile now names a tag that does not exist yet, so its
        # cargo.crates block is checked against the working tree's Cargo.lock.
        with TemporaryDirectory() as td:
            root = Path(td)
            _build_repo(root)
            lock = root / "Cargo.lock"
            lock.write_text(lock.read_text(encoding="utf-8").replace("2.7.4", "2.7.5"), encoding="utf-8")
            self._set(root, "0.3.0")
            portfile = (root / "packaging/macports/Portfile").read_text(encoding="utf-8")
            self.assertIn("memchr", portfile)
            self.assertIn("2.7.5", portfile)
            self.assertNotIn("2.7.4", portfile)

    def test_when_the_bump_is_run_again_with_the_same_version_nothing_changes(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td)
            _build_repo(root)
            self.assertIn("CHANGELOG.md", self._set(root, "0.3.0", released="2026-03-01"))
            before = {p: p.read_bytes() for p in root.rglob("*") if p.is_file()}
            self.assertEqual(self._set(root, "0.3.0", released="2026-03-02"), [])
            self.assertEqual({p: p.read_bytes() for p in root.rglob("*") if p.is_file()}, before)

    def test_when_the_version_is_not_x_y_z_it_is_refused(self) -> None:
        for value in ("v0.3.0", "0.3", "0.3.0-rc.1"):
            with self.subTest(value=value), self.assertRaises(argparse.ArgumentTypeError):
                check_version_consistency._release_version(value)

    def test_when_the_date_is_not_yyyy_mm_dd_it_is_refused(self) -> None:
        for value in ("2026/03/01", "2026-02-30", "March 1"):
            with self.subTest(value=value), self.assertRaises(argparse.ArgumentTypeError):
                check_version_consistency._release_date(value)

    def test_every_location_the_bump_writes_is_a_checked_source(self) -> None:
        # A loader that stops finding its location would drop it from the
        # check and from the bump at once; the fixture has one of each.
        with TemporaryDirectory() as td:
            root = Path(td)
            _build_repo(root)
            fields = {(file, field.split(" (")[0]) for file, field in self._values(root)}
            for expected in (
                ("crates/cli/Cargo.toml", "dependency chordsketch-core version"),
                ("Cargo.lock", "package chordsketch-cli version"),
                ("packaging/winget/koedame.chordsketch.installer.yaml", "InstallerUrl tag"),
                ("packaging/winget/koedame.chordsketch.installer.yaml", "InstallerUrl asset version"),
                (".github/workflows/readme-smoke.yml", "library-smoke chordsketch-chordpro caret constraint"),
                (".github/workflows/readme-smoke.yml", "library-smoke chordsketch-render-text caret constraint"),
                ("packages/react/README.md", "requirement on @chordsketch/wasm"),
                ("packages/react/README.md", "requirement on @chordsketch/wasm-export"),
            ):
                with self.subTest(source=expected):
                    self.assertIn(expected, fields)


if __name__ == "__main__":
    unittest.main()
