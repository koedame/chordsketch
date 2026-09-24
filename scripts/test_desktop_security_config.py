#!/usr/bin/env python3
"""Pins the desktop app's WebView permissions and Content Security Policy.

Uses only `unittest` from stdlib so CI does not need a `pip install` step.

Every case reads the real files under `apps/desktop/src-tauri/`, so a change
to `capabilities/*.json` or `tauri.conf.json` that widens what the WebView may
do fails here until this file is edited in the same change. That edit is the
review point: [ADR-0006](../docs/adr/0006-desktop-webview-trust-boundary.md)
rests on the WebView loading only the local build, so granting a filesystem or
shell permission, opening IPC to a remote URL, or loosening the CSP each
invalidates it.
"""
from __future__ import annotations

import json
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
TAURI_DIR = REPO_ROOT / "apps" / "desktop" / "src-tauri"
CAPABILITIES_DIR = TAURI_DIR / "capabilities"
TAURI_MAIN_CONF = TAURI_DIR / "tauri.conf.json"
# Discovered, not hard-coded: a new `tauri.<platform>.conf.json` override
# (e.g. for a future Linux cell) is picked up automatically, the same way
# `test_capability_files_are_only_default_json` enumerates the capabilities
# directory instead of naming files. A static list would let a new platform
# override skip every ConfigTests check silently.
PLATFORM_OVERRIDE_CONF_FILES = sorted(TAURI_DIR.glob("tauri.*.conf.json"))
CONF_FILES = [TAURI_MAIN_CONF, *PLATFORM_OVERRIDE_CONF_FILES]

# Every permission the main window holds. A plain string is granted without a
# scope; a dict is a scoped grant and must match exactly.
EXPECTED_PERMISSIONS: list[object] = [
    "core:app:default",
    "core:window:default",
    "core:window:allow-set-title",
    "core:window:allow-destroy",
    "core:event:allow-listen",
    "core:event:allow-unlisten",
    "core:menu:default",
    "dialog:allow-save",
    "dialog:allow-open",
    "dialog:allow-message",
    "dialog:allow-ask",
    "updater:allow-check",
    "updater:allow-download-and-install",
    "process:allow-restart",
    {
        "identifier": "opener:allow-open-url",
        "allow": [{"url": "https://github.com/koedame/chordsketch"}],
    },
]

# Plugin namespaces that let WebView script reach the filesystem, run
# programs, or talk to arbitrary hosts. ADR-0006 lists `fs:*` and `shell:*`
# as the triggers for real capability gating; the rest are the same class.
FORBIDDEN_PERMISSION_NAMESPACES = [
    "fs",
    "shell",
    "http",
    "websocket",
    "sql",
    "store",
    "os",
    "clipboard-manager",
    "global-shortcut",
    "notification",
    "log",
    "upload",
    "stronghold",
    "autostart",
    "deep-link",
]

EXPECTED_CSP = {
    "default-src": ["'self'"],
    "script-src": ["'self'", "'wasm-unsafe-eval'", "'unsafe-eval'"],
    "style-src": ["'self'", "'unsafe-inline'"],
    "img-src": ["'self'", "data:"],
    "connect-src": ["'self'", "ipc:", "http://ipc.localhost"],
    "frame-src": ["'self'"],
}


def load(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def parse_csp(csp: str) -> dict[str, list[str]]:
    directives: dict[str, list[str]] = {}
    for part in csp.split(";"):
        tokens = part.split()
        if tokens:
            directives[tokens[0]] = tokens[1:]
    return directives


def permission_key(permission: object) -> str:
    return json.dumps(permission, sort_keys=True)


class CapabilityTests(unittest.TestCase):
    def test_capability_files_are_only_default_json(self):
        names = sorted(p.name for p in CAPABILITIES_DIR.iterdir())
        self.assertEqual(
            names,
            ["default.json"],
            "a new capability file grants permissions this suite does not "
            "pin; extend the tests to cover it in the same change",
        )

    def test_default_capability_targets_only_the_main_window(self):
        capability = load(CAPABILITIES_DIR / "default.json")
        self.assertEqual(capability["windows"], ["main"])

    def test_default_capability_does_not_open_ipc_to_remote_urls(self):
        capability = load(CAPABILITIES_DIR / "default.json")
        self.assertNotIn(
            "remote",
            capability,
            "`remote.urls` would hand IPC to a web page (ADR-0006)",
        )

    def test_default_capability_grants_exactly_the_reviewed_permissions(self):
        capability = load(CAPABILITIES_DIR / "default.json")
        granted = sorted(permission_key(p) for p in capability["permissions"])
        expected = sorted(permission_key(p) for p in EXPECTED_PERMISSIONS)
        self.assertEqual(
            granted,
            expected,
            "the WebView's permissions changed; if intended, update "
            "EXPECTED_PERMISSIONS and re-check ADR-0006's revisit triggers",
        )

    def test_default_capability_grants_no_filesystem_shell_or_network_plugin(self):
        capability = load(CAPABILITIES_DIR / "default.json")
        for permission in capability["permissions"]:
            identifier = (
                permission["identifier"]
                if isinstance(permission, dict)
                else permission
            )
            namespace = identifier.split(":", 1)[0]
            self.assertNotIn(
                namespace,
                FORBIDDEN_PERMISSION_NAMESPACES,
                f"{identifier} lets WebView script bypass the custom-command "
                "boundary (ADR-0006 revisit trigger)",
            )

    def test_opener_is_scoped_to_the_project_homepage_only(self):
        capability = load(CAPABILITIES_DIR / "default.json")
        openers = [
            p
            for p in capability["permissions"]
            if isinstance(p, dict) and p["identifier"].startswith("opener:")
        ]
        self.assertEqual(len(openers), 1)
        self.assertEqual(
            openers[0]["allow"], [{"url": "https://github.com/koedame/chordsketch"}]
        )
        self.assertNotIn("deny", openers[0])

    def test_no_bare_opener_permission_is_granted(self):
        capability = load(CAPABILITIES_DIR / "default.json")
        bare = [
            p
            for p in capability["permissions"]
            if isinstance(p, str) and p.startswith("opener:")
        ]
        self.assertEqual(bare, [], "an unscoped opener grant opens any URL")


class ContentSecurityPolicyTests(unittest.TestCase):
    def setUp(self):
        self.conf = load(TAURI_DIR / "tauri.conf.json")
        self.csp = parse_csp(self.conf["app"]["security"]["csp"])

    def test_csp_is_exactly_the_reviewed_policy(self):
        self.assertEqual(
            self.csp,
            EXPECTED_CSP,
            "the desktop CSP changed; if intended, update EXPECTED_CSP and "
            "re-check ADR-0006",
        )

    def test_csp_allows_no_remote_origin_anywhere(self):
        # Local, non-URL scheme tokens the reviewed policy uses on purpose:
        # `data:` for inline image sources, `ipc:` for the Tauri IPC bridge.
        local_scheme_tokens = {"data:", "ipc:"}
        for directive, sources in self.csp.items():
            for source in sources:
                self.assertNotIn(source, ("*", "https:", "http:", "ws:", "wss:"), directive)
                if source.startswith("'") or source in local_scheme_tokens:
                    continue
                if "://" in source:
                    self.assertEqual(
                        source,
                        "http://ipc.localhost",
                        f"{directive} names a remote origin: {source}",
                    )
                    continue
                # CSP treats a bare host (`evil.example`) or host+path
                # (`evil.example/x`) as a source matching that host under
                # any scheme — the same hazard as a full URL, just without
                # the `://` this loop otherwise keys on.
                self.fail(f"{directive} names a bare host source: {source!r}")

    def test_csp_script_src_has_no_inline_scripts(self):
        self.assertNotIn("'unsafe-inline'", self.csp["script-src"])

    def test_csp_falls_back_to_self_for_every_unlisted_fetch_directive(self):
        self.assertEqual(self.csp["default-src"], ["'self'"])


class ConfigTests(unittest.TestCase):
    def test_platform_override_set_is_the_reviewed_set(self):
        self.assertEqual(
            sorted(p.name for p in PLATFORM_OVERRIDE_CONF_FILES),
            ["tauri.macos.conf.json", "tauri.windows.conf.json"],
            "a new tauri.<platform>.conf.json override exists; the rest of "
            "ConfigTests now covers its contents automatically, but its "
            "name still needs adding to the expected set checked here so "
            "the addition gets a review point instead of passing silently",
        )

    def test_no_config_file_loads_a_remote_page_into_a_window(self):
        for path in CONF_FILES:
            for window in load(path).get("app", {}).get("windows", []):
                self.assertNotIn(
                    "url",
                    window,
                    f"{path.name}: a window `url` can point the WebView away "
                    "from the local build (ADR-0006)",
                )

    def test_no_config_file_weakens_the_security_section(self):
        weakening = {
            "dangerousRemoteDomainIpcAccess",
            "dangerousDisableAssetCspModification",
            "assetProtocol",
            "capabilities",
        }
        for path in CONF_FILES:
            security = load(path).get("app", {}).get("security", {})
            present = weakening & security.keys()
            self.assertFalse(
                present,
                f"{path.name}: {sorted(present)} in app.security changes what "
                "the WebView may do; extend the tests to pin it",
            )

    def test_platform_overrides_do_not_replace_the_csp(self):
        for path in PLATFORM_OVERRIDE_CONF_FILES:
            security = load(path).get("app", {}).get("security", {})
            self.assertNotIn("csp", security, path.name)

    def test_global_tauri_object_is_not_exposed_to_page_script(self):
        for path in CONF_FILES:
            self.assertFalse(
                load(path).get("app", {}).get("withGlobalTauri", False), path.name
            )


if __name__ == "__main__":
    unittest.main()
