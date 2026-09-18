#!/usr/bin/env python3
"""Version consistency CI check.

Enforces that every versioned manifest across the repo stays in lockstep with
the workspace crate version, unless the drift is explicitly declared in
`ci/version-skew-allowlist.toml`. Runs on every PR via `.github/workflows/ci.yml`
and fails loud on any unallowed drift.

The canonical version is the mode (most common value) across
`crates/*/Cargo.toml` — if even the crates disagree among themselves, that is
a structural bug and the script fails with a dedicated error.

Sources checked:

  1. Every crate's `package.version` in `crates/*/Cargo.toml`
  2. `packages/npm/package.json` `version`
  3. `packages/npm-export/package.json` `version`
     (`@chordsketch/wasm-export` — the heavy-bundle sister of
     `@chordsketch/wasm`; ships in lockstep per #2466)
  4. `packages/vscode-extension/package.json` `version`
  5. `crates/napi/package.json` `version`
  6. `crates/napi/package.json` `optionalDependencies[<platform>]`
     (every platform pin in the napi meta package — all must equal
     canonical or the resolver loads a mismatched native binary; see
     #2517's release-time review for the regression that motivated this)
  7. Every `crates/napi/npm/<target-triple>/package.json` `version`
     (the per-platform prebuilt-binary packages published alongside
     `@chordsketch/node`)
  8. `packages/tree-sitter-chordpro/package.json` `version`
  9. `packages/claude-code-plugin/.claude-plugin/plugin.json` `version` and
     the matching `.claude-plugin/marketplace.json` plugin entry
 10. Consumer caret-pin constraints — `^<major>.<minor>.<patch>` for
     `@chordsketch/wasm` / `@chordsketch/wasm-export` referenced by
     `packages/vscode-extension`, `packages/react`, `packages/vue`,
     `packages/svelte`, and `packages/ui-irealb-editor`. The constraint MUST cover the
     canonical workspace version; comparison runs at major.minor
     granularity (`_expected_for` strips the patch when the field
     label ends with `(^major.minor)`). `--set` writes the released
     version itself, `^X.Y.Z` (ADR-0073).
 11. `.github/workflows/readme-smoke.yml` — three hardcoded pins:
       a. `npm-wasm` job's `env: WASM_VERSION: "<version>"`
       b. `npm-wasm-export` job's `env: WASM_EXPORT_VERSION: "<version>"`
       c. `library-smoke`'s `chordsketch-chordpro = "<caret>"` (and
          paired chordpro / render-text / ireal / render-ireal pins,
          all caught by the same caret regex)
 12. `packaging/macports/Portfile` — `github.setup … <version> v`
 13. `packaging/nix/package.nix` — `version = "X.Y.Z";`
 14. `packaging/winget/*.yaml` — `PackageVersion: X.Y.Z`
 15. `apps/desktop/src-tauri/Cargo.toml` — `package.version`
 16. `apps/desktop/src-tauri/tauri.conf.json` — top-level `"version"`
 17. `apps/desktop/package.json` — `version`
 18. `apps/desktop/preview-handler/Cargo.toml` — `package.version`
     (CLI and GUI are always in lockstep; the four desktop manifests
     must all agree with the workspace canonical. The preview handler
     DLL ships inside the desktop installer, so it moves with it.)
 19. `packages/{react-ui,react,vue,svelte,chordpro-lite}/package.json`
     `version` — the npm packages that used to version on their own
     cadence and now publish with every workspace release (ADR-0073)
 20. `packaging/flatpak/io.github.koedame.chordsketch.metainfo.xml` — the newest
     `<release version>` (the Flathub listing's release history, ADR-0074)
 21. The `version` of every path dependency on a workspace crate
     (`chordsketch-chordpro = { version = "X.Y.Z", path = "../chordpro" }`)
 22. `Cargo.lock` — the `version` of every workspace crate
 23. `packaging/winget/*.installer.yaml` — the tag and the asset name in
     `InstallerUrl`
 24. `packages/react/README.md` — the `^X.Y.Z` requirements its table gives
     for `@chordsketch/wasm` and `@chordsketch/wasm-export`

Beyond versions, the lockfile of every consumer in (10) that installs
`@chordsketch/wasm` must install it from the in-tree `packages/npm` rather
than from npm (ADR-0073). The release commit raises those caret pins to a
version npm does not serve until the release publishes it; only a lockfile
that links the in-tree package still installs at that commit.

Each source is a (file, field, current_value) triple. The allowlist file has
the same (file, field, current_value) shape plus a mandatory `tracking_issue`
field — an entry without `tracking_issue` fails validation, because skips
must never be forgotten (see #1506 and the user's explicit requirement).

`--set X.Y.Z` is the release bump (docs/releasing.md, Step 1). Every loader
records where its value is written, so the same list of sources that is
checked is the list that is rewritten; nothing else names a location.
It writes X.Y.Z to every source the allowlist does not cover (the covered
ones keep their declared value), adds a dated `<release>` to the Flatpak
metainfo, brings the npm lockfiles' copies of the rewritten fields along,
regenerates the MacPorts `cargo.crates` block from the working tree's
`Cargo.lock` (the Portfile now names a tag that does not exist yet), dates
the release in CHANGELOG.md, and then runs the check. Running it again with
the same version changes nothing.

Exit codes:
  0 — every source matches canonical (after allowlist suppression)
  1 — one or more unallowed drifts detected, OR the allowlist is structurally
      invalid, OR a stale allowlist entry does not correspond to any source

stdlib only — no external deps.
"""

from __future__ import annotations

import argparse
import dataclasses
import importlib.util
import json
import posixpath
import re
import sys
import tomllib
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Callable

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_ALLOWLIST_PATH = REPO_ROOT / "ci" / "version-skew-allowlist.toml"


def _as_is(version: str, released: str) -> str:
    return version


def _major_minor(version: str) -> str:
    major, minor, _patch = version.split(".")
    return f"{major}.{minor}"


@dataclass(frozen=True)
class Source:
    """One version-bearing location in the repo."""

    file: str  # repo-relative path
    field: str  # human-readable label within the file
    value: str  # literal string extracted from the file
    # Where `--set` writes: the character offsets of the text carrying the
    # value, and that text for a version released on a date (YYYY-MM-DD).
    span: tuple[int, int] = dataclasses.field(compare=False, repr=False)
    render: Callable[[str, str], str] = dataclasses.field(default=_as_is, compare=False, repr=False)


def _found(file: str, field: str, match: re.Match[str], render: Callable[[str, str], str] = _as_is) -> Source:
    """The source whose value is `match`'s first group."""
    return Source(file=file, field=field, value=match.group(1), span=match.span(1), render=render)


@dataclass(frozen=True)
class AllowlistEntry:
    file: str
    field: str
    current_value: str
    reason: str
    expires_at: str
    tracking_issue: str  # non-empty; stored as string for forward compat


@dataclass(frozen=True)
class Drift:
    source: Source
    canonical: str
    detail: str


# ---------------------------------------------------------------- extract sources


# The `version = "..."` line of the `[package]` table: the first one after
# the header and before the next table.
_CARGO_PACKAGE_VERSION_RE = re.compile(
    r'^\[package\][ \t]*$(?:(?!^\[).)*?^version\s*=\s*"([^"]+)"',
    re.MULTILINE | re.DOTALL,
)

# `chordsketch-chordpro = { version = "X.Y.Z", path = "../chordpro" }`: a
# dependency on a workspace crate. The path builds it in-tree; the version is
# what crates.io resolves once it is published.
_CARGO_PATH_DEPENDENCY_RE = re.compile(
    r'^(chordsketch[\w-]*)\s*=\s*\{[^}\n]*\bpath\s*=[^}\n]*\}',
    re.MULTILINE,
)
_INLINE_VERSION_RE = re.compile(r'\bversion\s*=\s*"([^"]+)"')


def load_cargo_toml_versions(repo_root: Path, relative: str) -> list[Source]:
    """The `package.version` of a Cargo.toml and its workspace path dependencies."""
    path = repo_root / relative
    text = path.read_text(encoding="utf-8")
    try:
        data = tomllib.loads(text)
    except tomllib.TOMLDecodeError as exc:
        raise SystemExit(f"{path}: invalid TOML: {exc}")
    if not isinstance(data.get("package", {}).get("version"), str):
        raise SystemExit(f"{path}: package.version is missing or not a string")
    match = _CARGO_PACKAGE_VERSION_RE.search(text)
    if match is None:
        raise SystemExit(
            f"{relative}: package.version is not a `version = \"...\"` line in the "
            f"[package] table. If the manifest was restructured, update "
            f"_CARGO_PACKAGE_VERSION_RE."
        )
    sources = [_found(relative, "package.version", match)]
    for dependency in _CARGO_PATH_DEPENDENCY_RE.finditer(text):
        version = _INLINE_VERSION_RE.search(text, dependency.start(), dependency.end())
        if version is not None:
            sources.append(_found(relative, f"dependency {dependency.group(1)} version", version))
    return sources


def load_crate_versions(repo_root: Path) -> list[Source]:
    """Collect `package.version` and the path dependency versions from every `crates/*/Cargo.toml`."""
    sources: list[Source] = []
    for cargo_toml in sorted((repo_root / "crates").glob("*/Cargo.toml")):
        sources.extend(load_cargo_toml_versions(repo_root, cargo_toml.relative_to(repo_root).as_posix()))
    if not sources:
        raise SystemExit("no crates/*/Cargo.toml found — run from the repo root")
    return sources


# A workspace crate in Cargo.lock. Registry packages carry a `source` line
# after `version`; the workspace's own do not.
_CARGO_LOCK_WORKSPACE_PACKAGE_RE = re.compile(
    r'^\[\[package\]\]\nname = "(chordsketch[^"]*)"\nversion = "([^"]+)"\n(?!source = )',
    re.MULTILINE,
)


def load_cargo_lock_versions(repo_root: Path) -> list[Source]:
    """Collect the version `Cargo.lock` records for every workspace crate."""
    path = repo_root / "Cargo.lock"
    if not path.is_file():
        return []
    return [
        Source(
            file="Cargo.lock",
            field=f"package {match.group(1)} version",
            value=match.group(2),
            span=match.span(2),
        )
        for match in _CARGO_LOCK_WORKSPACE_PACKAGE_RE.finditer(path.read_text(encoding="utf-8"))
    ]


def load_package_json_version(repo_root: Path, relative: str) -> Source:
    """Naive but deterministic JSON `version` extractor.

    Uses a literal regex rather than `json.load` so the check survives a
    temporarily-malformed package.json (e.g. during a merge conflict) and
    reports the actual field, not a parse error. The regex matches the first
    top-level `"version": "<value>"` line, which is the convention used by
    every package.json in this repo.
    """
    path = repo_root / relative
    if not path.is_file():
        raise SystemExit(f"{relative}: file not found")
    text = path.read_text(encoding="utf-8")
    match = re.search(r'"version"\s*:\s*"([^"]+)"', text)
    if match is None:
        raise SystemExit(f"{relative}: no version field found")
    return _found(relative, "version", match)


def _json_object_entry(text: str, block: str, key: str) -> re.Match[str] | None:
    """The `"key": "<value>"` entry of the flat JSON object `"block": {...}`.

    The match's first group is the value, at its offsets in `text`.
    """
    object_match = re.search(rf'"{re.escape(block)}"\s*:\s*\{{([^{{}}]*)\}}', text)
    if object_match is None:
        return None
    entry = re.compile(rf'"{re.escape(key)}"\s*:\s*"([^"]*)"')
    return entry.search(text, object_match.start(1), object_match.end(1))


# npm smoke pins: each smoke job exposes its pinned version via a
# job-level `env: <VAR>: "<version>"` (the install step and the
# release-cut registry-probe step both reference the same constant).
# Each tuple is (job-name-marker, env-var-name, source-field-label).
# Adding a new wasm/npm smoke means adding a tuple here so the
# consistency check picks it up automatically. Each anchor is the
# `<job-name>:.*?\n\s+env:\s*\n\s+<VAR>:` shape so an unrelated env
# block elsewhere in the file can't accidentally satisfy the regex.
_SMOKE_NPM_PINS: list[tuple[str, str, str]] = [
    ("npm-wasm:", "WASM_VERSION", "npm install @chordsketch/wasm pin"),
    (
        "npm-wasm-export:",
        "WASM_EXPORT_VERSION",
        "npm install @chordsketch/wasm-export pin",
    ),
]
# The library-smoke job's crates.io constraints, one per crate
# (`chordsketch-chordpro = "^X.Y"` and its paired render / iReal pins).
_SMOKE_CARET_RE = re.compile(
    r"""(chordsketch-[\w-]+)\s*=\s*['"]\^([0-9]+\.[0-9]+)['"]"""
)


def load_readme_smoke_pins(repo_root: Path) -> list[Source]:
    """Extract the hardcoded pins from `.github/workflows/readme-smoke.yml`.

    These pins cannot be in `allowlist` form because they live inside shell
    script bodies inside YAML; regex is the pragmatic extractor. If the YAML
    is restructured and any regex stops matching, this function raises
    `SystemExit` with a clear message so the maintainer knows to update it.

    Each entry in `_SMOKE_NPM_PINS` is checked. The npm-wasm-export job
    was added in the v0.5.0 release post-publish follow-up (#2523) so
    the lean and heavy bundles get equivalent smoke coverage and
    equivalent drift detection at the next release.
    """
    relative = ".github/workflows/readme-smoke.yml"
    path = repo_root / relative
    if not path.is_file():
        raise SystemExit(f"{relative}: file not found")
    text = path.read_text(encoding="utf-8")

    sources: list[Source] = []

    for job_marker, env_var, field_label in _SMOKE_NPM_PINS:
        pattern = (
            re.escape(job_marker)
            + r".*?\n\s+env:\s*\n\s+"
            + re.escape(env_var)
            + r":\s*['\"]([0-9][^'\"]*)['\"]"
        )
        match = re.search(pattern, text, re.DOTALL)
        if match is None:
            raise SystemExit(
                f"{relative}: could not find `{job_marker} env: {env_var}: \"<version>\"`. "
                f"If the smoke job was restructured, update _SMOKE_NPM_PINS in this script."
            )
        sources.append(_found(relative, field_label, match))

    caret_matches = list(_SMOKE_CARET_RE.finditer(text))
    if not caret_matches:
        raise SystemExit(
            f"{relative}: could not find `chordsketch-chordpro = \"^X.Y\"`. "
            f"If the library-smoke job was restructured, update _SMOKE_CARET_RE."
        )
    sources.extend(
        Source(
            file=relative,
            field=f"library-smoke {match.group(1)} caret constraint {_CARET_FIELD_SUFFIX}",
            value=match.group(2),
            span=match.span(2),
            render=lambda version, released: _major_minor(version),
        )
        for match in caret_matches
    )

    return sources


# ---------------------------------------------------------------- packaging/*
#
# Pinned (non-`.template`) files under packaging/<channel>/ that quote a
# specific version. These were the class of source that silently went
# stale between v0.2.0 and v0.2.2 (see #1864 evidence); the three
# loaders below add them to the consistency check so the drift is
# caught in CI before the next release instead of during a post-hoc
# manual audit.
#
# Templates (`*.template` files) are rendered at release time with the
# correct version and therefore do NOT need to be listed here.


# packaging/macports/Portfile: `github.setup koedame chordsketch X.Y.Z v`
_MACPORTS_VERSION_RE = re.compile(
    r"""^\s*github\.setup\s+\S+\s+\S+\s+([0-9]+\.[0-9]+\.[0-9]+)\b""",
    re.MULTILINE,
)

# packaging/nix/package.nix: `version = "X.Y.Z";`
_NIX_VERSION_RE = re.compile(
    r"""^\s*version\s*=\s*"([0-9]+\.[0-9]+\.[0-9]+)"\s*;""",
    re.MULTILINE,
)

# packaging/winget/*.yaml: `PackageVersion: X.Y.Z`
_WINGET_VERSION_RE = re.compile(
    r"""^\s*PackageVersion:\s*([0-9]+\.[0-9]+\.[0-9]+)\s*$""",
    re.MULTILINE,
)

# packaging/winget/*.installer.yaml:
# `InstallerUrl: .../releases/download/vX.Y.Z/chordsketch-vX.Y.Z-<target>.zip`
_WINGET_URL_TAG_RE = re.compile(r"""^\s*InstallerUrl:\s*\S*/download/v([0-9]+\.[0-9]+\.[0-9]+)/""", re.MULTILINE)
_WINGET_URL_ASSET_RE = re.compile(r"""^\s*InstallerUrl:\s*\S*/[^/\s]*-v([0-9]+\.[0-9]+\.[0-9]+)-[^/\s]*$""", re.MULTILINE)


def load_macports_version(repo_root: Path) -> list[Source]:
    relative = "packaging/macports/Portfile"
    path = repo_root / relative
    if not path.is_file():
        return []
    text = path.read_text(encoding="utf-8")
    match = _MACPORTS_VERSION_RE.search(text)
    if match is None:
        raise SystemExit(
            f"{relative}: could not find `github.setup ... <version> v`. "
            f"If the Portfile was restructured, update _MACPORTS_VERSION_RE."
        )
    return [_found(relative, "github.setup version", match)]


def load_nix_version(repo_root: Path) -> list[Source]:
    relative = "packaging/nix/package.nix"
    path = repo_root / relative
    if not path.is_file():
        return []
    text = path.read_text(encoding="utf-8")
    match = _NIX_VERSION_RE.search(text)
    if match is None:
        raise SystemExit(
            f"{relative}: could not find `version = \"X.Y.Z\";`. "
            f"If the derivation was restructured, update _NIX_VERSION_RE."
        )
    return [_found(relative, "version", match)]


def load_winget_versions(repo_root: Path) -> list[Source]:
    """Collect `PackageVersion:` from every `packaging/winget/*.yaml`.

    Every winget manifest type that we ship (top-level,
    `.installer.yaml`, `.locale.*.yaml`) is required by the winget
    schema to carry `PackageVersion:`. A file in this directory that
    lacks the line is a structural defect — raise so the author is
    forced to either register the file's version or remove it, rather
    than having the check silently pass on a mis-cased key or a
    missing field.
    """
    sources: list[Source] = []
    base = repo_root / "packaging" / "winget"
    if not base.is_dir():
        return sources
    for yaml_path in sorted(base.glob("*.yaml")):
        text = yaml_path.read_text(encoding="utf-8")
        match = _WINGET_VERSION_RE.search(text)
        rel = yaml_path.relative_to(repo_root).as_posix()
        if match is None:
            raise SystemExit(
                f"{rel}: no `PackageVersion:` line found. Every winget "
                f"manifest must declare PackageVersion per the schema. "
                f"If this file is not a manifest, move it outside "
                f"`packaging/winget/`; otherwise add the field."
            )
        sources.append(_found(rel, "PackageVersion", match))
        # The URL has to name the release too: winget installs whatever it
        # points at, under the PackageVersion above.
        urls = re.findall(r"^\s*InstallerUrl:.*$", text, re.MULTILINE)
        tags = list(_WINGET_URL_TAG_RE.finditer(text))
        assets = list(_WINGET_URL_ASSET_RE.finditer(text))
        if not len(urls) == len(tags) == len(assets):
            raise SystemExit(
                f"{rel}: an InstallerUrl is not `.../download/vX.Y.Z/<name>-vX.Y.Z-<target>`. "
                f"If the release assets were renamed, update _WINGET_URL_TAG_RE and "
                f"_WINGET_URL_ASSET_RE."
            )
        sources.extend(_found(rel, "InstallerUrl tag", match) for match in tags)
        sources.extend(_found(rel, "InstallerUrl asset version", match) for match in assets)
    return sources


def load_napi_optional_deps(repo_root: Path) -> list[Source]:
    """Collect every entry from `crates/napi/package.json` `optionalDependencies`.

    The napi-rs prebuilt-binary layout publishes a meta package
    (`@chordsketch/node`) plus one package per platform triple. The
    meta resolves the right native addon at install time via
    `optionalDependencies`; for that resolution to land on a binary
    that matches the JS shim, every entry MUST equal the canonical
    workspace version. The platform-package `version` fields themselves
    are already enforced by `load_napi_platform_package_versions`, but
    the meta-side pins live in a separate JSON object that the bare
    `"version"` regex (`load_package_json_version`) does not see.

    Background — every `@chordsketch/node@0.3.0` and `@0.4.0` release
    to date shipped with this block stuck at `0.2.2`, so Node consumers
    have been installing a v0.2.2 native binary against a v0.3.0/v0.4.0
    JS shim (silent ABI drift). #2517 fixed the block and added this
    loader so the gap cannot reopen at the next release cut.
    """
    sources: list[Source] = []
    meta = repo_root / "crates" / "napi" / "package.json"
    if not meta.is_file():
        return sources
    import json as _json

    text = meta.read_text(encoding="utf-8")
    try:
        data = _json.loads(text)
    except _json.JSONDecodeError as exc:
        raise SystemExit(f"crates/napi/package.json: invalid JSON: {exc}")
    optional = data.get("optionalDependencies") or {}
    if not isinstance(optional, dict):
        raise SystemExit(
            "crates/napi/package.json: optionalDependencies is not an object"
        )
    for name, value in sorted(optional.items()):
        if not isinstance(value, str):
            raise SystemExit(
                f"crates/napi/package.json: optionalDependencies[{name!r}] "
                f"is not a string"
            )
        match = _json_object_entry(text, "optionalDependencies", name)
        if match is None:
            raise SystemExit(
                f"crates/napi/package.json: optionalDependencies[{name!r}] is not a "
                f"`\"{name}\": \"<version>\"` line in a flat object"
            )
        sources.append(_found("crates/napi/package.json", f"optionalDependencies[{name}]", match))
    return sources


# Consumer-pin caret constraints. Each entry is a workspace-internal
# package whose `package.json` constrains a published `@chordsketch/*`
# sister package via `^X.Y.Z`. The constraint MUST cover the current
# canonical version or the consumer will silently resolve to the prior
# major-minor when the canonical's major-minor bumps. The
# `.claude/rules/package-documentation.md` §"Version Consistency Rule"
# already names two of these (vscode-extension + npm/wasm) — this
# loader extends the check to every published workspace consumer that
# pins `@chordsketch/wasm` or `@chordsketch/wasm-export`.
_CONSUMER_PINS: list[tuple[str, str, str]] = [
    # (file, dotted-path, dep-name)
    ("packages/vscode-extension/package.json", "dependencies", "@chordsketch/wasm"),
    ("packages/react/package.json", "dependencies", "@chordsketch/wasm"),
    ("packages/react/package.json", "peerDependencies", "@chordsketch/wasm-export"),
    ("packages/vue/package.json", "dependencies", "@chordsketch/wasm"),
    ("packages/vue/package.json", "peerDependencies", "@chordsketch/wasm-export"),
    ("packages/svelte/package.json", "dependencies", "@chordsketch/wasm"),
    ("packages/svelte/package.json", "peerDependencies", "@chordsketch/wasm-export"),
    ("packages/ui-irealb-editor/package.json", "peerDependencies", "@chordsketch/wasm"),
]


def load_consumer_pin_constraints(repo_root: Path) -> list[Source]:
    """Collect `^X.Y.Z`-style consumer pins for workspace sister packages.

    Returns one Source per entry in `_CONSUMER_PINS`. The reported
    value is `X.Y` (the major.minor extracted from the leading caret
    constraint), and the field label carries the `_CARET_FIELD_SUFFIX`
    so `_expected_for` runs the major-minor comparison against the
    workspace canonical.

    The constraint pattern must be exactly `^<major>.<minor>.<patch>`;
    anything else (e.g. `*`, `workspace:`, a range expression) is a
    structural shape change worth surfacing as a SystemExit so the
    maintainer updates this loader explicitly. The current set of
    consumers all use the simple caret form per CLAUDE.md.
    """
    import json as _json

    sources: list[Source] = []
    for rel, block, dep in _CONSUMER_PINS:
        path = repo_root / rel
        if not path.is_file():
            raise SystemExit(
                f"{rel}: file not found (referenced by load_consumer_pin_constraints)"
            )
        text = path.read_text(encoding="utf-8")
        try:
            data = _json.loads(text)
        except _json.JSONDecodeError as exc:
            raise SystemExit(f"{rel}: invalid JSON: {exc}")
        block_obj = data.get(block)
        if block_obj is None:
            raise SystemExit(
                f"{rel}: missing {block!r} block — expected to find a "
                f"{dep!r} entry there"
            )
        if not isinstance(block_obj, dict):
            raise SystemExit(f"{rel}: {block!r} is not an object")
        constraint = block_obj.get(dep)
        if constraint is None:
            raise SystemExit(
                f"{rel}: {block}[{dep!r}] is missing"
            )
        if not isinstance(constraint, str):
            raise SystemExit(
                f"{rel}: {block}[{dep!r}] is not a string"
            )
        match = re.fullmatch(r"\^(\d+\.\d+)\.\d+", constraint)
        if match is None:
            raise SystemExit(
                f"{rel}: {block}[{dep!r}] = {constraint!r} — expected exact "
                f"`^<major>.<minor>.<patch>` shape; update "
                f"load_consumer_pin_constraints if the constraint shape "
                f"has changed intentionally."
            )
        entry = _json_object_entry(text, block, dep)
        if entry is None:
            raise SystemExit(f"{rel}: {block}[{dep!r}] is not a `\"{dep}\": \"^X.Y.Z\"` line in a flat object")
        sources.append(
            Source(
                file=rel,
                field=f"{block}[{dep}] {_CARET_FIELD_SUFFIX}",
                value=match.group(1),
                span=entry.span(1),
                render=_caret,
            )
        )
    return sources


def _caret(version: str, released: str) -> str:
    """The pins on the wasm packages name the version released with them (ADR-0073)."""
    return f"^{version}"


# packages/react/README.md's requirements table repeats the two pins of
# packages/react/package.json: "| `@chordsketch/wasm` | `^X.Y.Z` (runtime dep) |".
_README_PIN_RE = re.compile(r"^\| `(@chordsketch/wasm(?:-export)?)` \| `(\^([0-9]+\.[0-9]+)\.[0-9]+)`", re.MULTILINE)


def load_readme_pins(repo_root: Path) -> list[Source]:
    relative = "packages/react/README.md"
    path = repo_root / relative
    if not path.is_file():
        return []
    matches = list(_README_PIN_RE.finditer(path.read_text(encoding="utf-8")))
    if not matches:
        raise SystemExit(
            f"{relative}: no \"| `@chordsketch/wasm` | `^X.Y.Z`\" row found. If the "
            f"requirements table was restructured, update _README_PIN_RE."
        )
    return [
        Source(
            file=relative,
            field=f"requirement on {match.group(1)} {_CARET_FIELD_SUFFIX}",
            value=match.group(3),
            span=match.span(2),
            render=_caret,
        )
        for match in matches
    ]


# The in-tree directory each consumer's lockfile installs a pinned sister
# package from (ADR-0073). `@chordsketch/wasm-export` is only an optional peer
# of its consumers, so no lockfile installs it.
_IN_TREE_PACKAGES: dict[str, str] = {"@chordsketch/wasm": "packages/npm"}


def lockfile_link_problems(repo_root: Path) -> list[str]:
    """Consumer lockfiles that install an in-tree sister package from npm.

    A lockfile links a directory as `node_modules/<name>` with
    `{"resolved": "<relative path>", "link": true}`. npm keeps that link
    through `npm ci` and `npm install` for as long as the directory's version
    satisfies the pin, which the version check above guarantees.
    """
    problems: list[str] = []
    for rel, _block, dep in _CONSUMER_PINS:
        directory = _IN_TREE_PACKAGES.get(dep)
        if directory is None:
            continue
        consumer = posixpath.dirname(rel)
        lockfile = f"{consumer}/package-lock.json"
        path = repo_root / lockfile
        if not path.is_file():
            problems.append(f"{lockfile}: file not found")
            continue
        try:
            packages = json.loads(path.read_text(encoding="utf-8")).get("packages", {})
        except json.JSONDecodeError as exc:
            problems.append(f"{lockfile}: invalid JSON: {exc}")
            continue
        relative = posixpath.relpath(directory, consumer)
        entry = packages.get(f"node_modules/{dep}")
        if entry == {"resolved": relative, "link": True}:
            continue
        found = entry.get("resolved", "an entry without `resolved`") if isinstance(entry, dict) else "nowhere"
        problems.append(
            f"{lockfile}: installs {dep} from {found}, not from the in-tree {directory}.\n"
            f"      In {consumer}, set the {dep} pin in package.json to `file:{relative}`, run\n"
            f"      `npm install --package-lock-only --ignore-scripts`, set the pin back, and run it again."
        )
    return problems


def load_napi_platform_package_versions(repo_root: Path) -> list[Source]:
    """Collect versions from every `crates/napi/npm/*/package.json`.

    These are the per-platform prebuilt-binary packages published alongside
    the main `@chordsketch/node` resolver. They must all share the same
    version as the main package or `optionalDependencies` resolution breaks.
    Globbed rather than enumerated so adding a new target triple only
    requires dropping a new `npm/<triple>/package.json` — the check picks
    it up automatically.
    """
    sources: list[Source] = []
    base = repo_root / "crates" / "napi" / "npm"
    if not base.is_dir():
        return sources
    for pkg_json in sorted(base.glob("*/package.json")):
        rel = pkg_json.relative_to(repo_root).as_posix()
        sources.append(load_package_json_version(repo_root, rel))
    return sources


def load_desktop_versions(repo_root: Path) -> list[Source]:
    """Collect the four version fields the desktop Tauri app carries.

    The desktop crate lives under `apps/desktop/src-tauri/` (outside the
    `crates/` tree that `load_crate_versions` scans) and is kept in
    lockstep with the workspace per the user's release-versioning
    requirement — CLI and GUI always share the same version number. The
    Tauri bundle's user-facing version is pulled from
    `tauri.conf.json`'s `"version"`, which MUST agree with the Rust
    crate's `Cargo.toml` and with the Vite frontend's `package.json`
    (otherwise the shipped installer metadata diverges from the binary
    it packages). The Windows preview handler
    (`apps/desktop/preview-handler/`) ships inside the same installer,
    so its crate version is checked here too.
    """
    sources: list[Source] = []

    if (repo_root / "apps/desktop/src-tauri/Cargo.toml").is_file():
        sources.extend(load_cargo_toml_versions(repo_root, "apps/desktop/src-tauri/Cargo.toml"))

    tauri_conf = repo_root / "apps/desktop/src-tauri/tauri.conf.json"
    if tauri_conf.is_file():
        text = tauri_conf.read_text(encoding="utf-8")
        match = re.search(r'"version"\s*:\s*"([^"]+)"', text)
        if match is None:
            raise SystemExit(
                f"{tauri_conf}: no version field found"
            )
        sources.append(_found("apps/desktop/src-tauri/tauri.conf.json", "version", match))

    package_json = repo_root / "apps/desktop/package.json"
    if package_json.is_file():
        sources.append(
            load_package_json_version(repo_root, "apps/desktop/package.json")
        )

    if (repo_root / "apps/desktop/preview-handler/Cargo.toml").is_file():
        sources.extend(load_cargo_toml_versions(repo_root, "apps/desktop/preview-handler/Cargo.toml"))

    metainfo_rel = "packaging/flatpak/io.github.koedame.chordsketch.metainfo.xml"
    metainfo = repo_root / metainfo_rel
    if metainfo.is_file():
        # The first <release> is the newest; AppStream lists them newest first.
        text = metainfo.read_text(encoding="utf-8")
        match = re.search(r'<release\b[^>]*\bversion="([^"]+)"', text)
        if match is None:
            raise SystemExit(f"{metainfo}: no <release version=...> found")
        newest = match.group(1)
        indent = text[text.rfind("\n", 0, match.start()) + 1 : match.start()]

        def add_release(version: str, released: str) -> str:
            # A release keeps the history: the new one goes in front of the
            # newest, which stays.
            if version == newest:
                return ""
            return (
                f'<release version="{version}" date="{released}">\n'
                f'{indent}  <url type="details">https://github.com/koedame/chordsketch/releases/tag/desktop-v{version}</url>\n'
                f"{indent}</release>\n{indent}"
            )

        sources.append(
            Source(
                file=metainfo_rel,
                field="releases/release[1]/@version",
                value=newest,
                span=(match.start(), match.start()),
                render=add_release,
            )
        )

    return sources


# ------------------------------------------------- Claude Code plugin

# Repo-relative paths of the Claude Code plugin's two manifests (ADR-0059).
# The plugin directory is named once here; `load_claude_code_plugin_versions`
# checks that the marketplace entry still points at it.
_PLUGIN_DIR = "packages/claude-code-plugin"
_PLUGIN_MANIFEST = f"{_PLUGIN_DIR}/.claude-plugin/plugin.json"
_MARKETPLACE_MANIFEST = ".claude-plugin/marketplace.json"


def load_claude_code_plugin_versions(repo_root: Path) -> list[Source]:
    """Collect the two versions the Claude Code plugin declares.

    Claude Code caches plugins under `<marketplace>/<plugin>/<version>/` and
    will not re-fetch while the version is unchanged, so a plugin that misses
    a release bump silently keeps serving the previous skill. Both the
    plugin's own manifest and the root marketplace entry that points at it
    carry the number, and both have to move.

    The marketplace entry's `source` is checked here too: it is the only
    thing tying the entry to the directory, and a rename that updates the
    directory but not the entry produces a marketplace whose install fails
    for everyone while every version number still agrees.
    """
    sources = [
        load_package_json_version(repo_root, _PLUGIN_MANIFEST),
        load_package_json_version(repo_root, _MARKETPLACE_MANIFEST),
    ]
    marketplace = repo_root / _MARKETPLACE_MANIFEST
    text = marketplace.read_text(encoding="utf-8")
    if f'"./{_PLUGIN_DIR}"' not in text:
        raise SystemExit(
            f"{_MARKETPLACE_MANIFEST}: no plugin entry sources "
            f'"./{_PLUGIN_DIR}" (the directory holding {_PLUGIN_MANIFEST})'
        )
    return sources


# The npm packages built on top of the engine (the framework bindings, the
# design-system primitives and the text helpers). They publish with every
# workspace release, at its version (ADR-0073).
FRAMEWORK_PACKAGE_DIRS = ("react-ui", "react", "vue", "svelte", "chordpro-lite")


def load_all_sources(repo_root: Path) -> list[Source]:
    sources: list[Source] = []
    sources.extend(load_crate_versions(repo_root))
    sources.extend(load_cargo_lock_versions(repo_root))
    sources.append(load_package_json_version(repo_root, "packages/npm/package.json"))
    # `@chordsketch/wasm-export` ships in lockstep with `@chordsketch/wasm`
    # per CLAUDE.md (#2466 added it as the heavy-bundle sister package).
    # `npm-export` was silently exempt from this check until #2517 added
    # it here — the gap allowed at least one cross-package release window
    # (v0.4.0) to ship with the npm-export version field drifted.
    sources.append(
        load_package_json_version(repo_root, "packages/npm-export/package.json")
    )
    sources.append(
        load_package_json_version(repo_root, "packages/vscode-extension/package.json")
    )
    sources.append(load_package_json_version(repo_root, "crates/napi/package.json"))
    sources.append(
        load_package_json_version(
            repo_root, "packages/tree-sitter-chordpro/package.json"
        )
    )
    sources.extend(
        load_package_json_version(repo_root, f"packages/{name}/package.json")
        for name in FRAMEWORK_PACKAGE_DIRS
    )
    sources.extend(load_claude_code_plugin_versions(repo_root))
    sources.extend(load_napi_platform_package_versions(repo_root))
    sources.extend(load_napi_optional_deps(repo_root))
    sources.extend(load_consumer_pin_constraints(repo_root))
    sources.extend(load_readme_pins(repo_root))
    sources.extend(load_readme_smoke_pins(repo_root))
    # Pinned version strings inside packaging/<channel>/ files. See #1864:
    # these silently went stale across v0.2.0 → v0.2.2 and were only
    # caught by manual audit. Adding them here catches the drift in CI.
    sources.extend(load_macports_version(repo_root))
    sources.extend(load_nix_version(repo_root))
    sources.extend(load_winget_versions(repo_root))
    # Desktop Tauri app — CLI and GUI are always in lockstep per the
    # user's release-versioning requirement.
    sources.extend(load_desktop_versions(repo_root))
    return sources


# ---------------------------------------------------------------- allowlist


def load_allowlist(path: Path) -> list[AllowlistEntry]:
    if not path.is_file():
        # A missing allowlist is a valid (empty) state. The check still runs
        # and will fail on any drift.
        return []
    try:
        data = tomllib.loads(path.read_text(encoding="utf-8"))
    except tomllib.TOMLDecodeError as exc:
        raise SystemExit(f"{path}: invalid TOML: {exc}")

    raw_rows = data.get("allowed_skews", [])
    if not isinstance(raw_rows, list):
        raise SystemExit(f"{path}: `allowed_skews` must be an array")

    entries: list[AllowlistEntry] = []
    for index, row in enumerate(raw_rows):
        if not isinstance(row, dict):
            raise SystemExit(f"{path}: allowed_skews[{index}] is not a table")
        try:
            file = str(row["file"])
            field = str(row["field"])
            current_value = str(row["current_value"])
            reason = str(row["reason"]).strip()
            expires_at = str(row["expires_at"])
            tracking_issue = str(row["tracking_issue"]).strip()
        except KeyError as exc:
            raise SystemExit(
                f"{path}: allowed_skews[{index}] missing required field: {exc.args[0]}"
            )
        if not tracking_issue:
            raise SystemExit(
                f"{path}: allowed_skews[{index}] ({file} / {field}) has an empty "
                f"tracking_issue. Every skew MUST reference a GitHub issue so it "
                f"cannot be forgotten. See the rule comment at the top of the file."
            )
        if not reason:
            raise SystemExit(
                f"{path}: allowed_skews[{index}] ({file} / {field}) has an empty reason"
            )
        entries.append(
            AllowlistEntry(
                file=file,
                field=field,
                current_value=current_value,
                reason=reason,
                expires_at=expires_at,
                tracking_issue=tracking_issue,
            )
        )
    return entries


def _key(entry: AllowlistEntry) -> tuple[str, str]:
    return (entry.file, entry.field)


def _source_key(source: Source) -> tuple[str, str]:
    return (source.file, source.field)


# ---------------------------------------------------------------- core check


# The caret-constraint sources store a bare `<major>.<minor>` value (extracted
# from `^<major>.<minor>`), which cannot be compared against canonical
# `<major>.<minor>.<patch>` directly. Every source has its own "expected value
# given the canonical crate version" function. The default is identity.
# Every caret-pin field label ends in this suffix so `_expected_for` can
# switch to `major.minor` comparison without hardcoding the labels.
_CARET_FIELD_SUFFIX = "(^major.minor)"


def _expected_for(source: Source, canonical: str) -> str:
    if source.field.endswith(_CARET_FIELD_SUFFIX):
        parts = canonical.split(".")
        if len(parts) < 2:
            return canonical
        return f"{parts[0]}.{parts[1]}"
    return canonical


def crate_package_versions(sources: list[Source]) -> list[Source]:
    """The `package.version` of every `crates/*/Cargo.toml`."""
    return [s for s in sources if s.file.startswith("crates/") and s.file.endswith("/Cargo.toml") and s.field == "package.version"]


def compute_canonical(crate_sources: list[Source]) -> str:
    """The canonical version is the unanimous crate version.

    If crates disagree, there is no single canonical — this is itself a drift
    that the caller must surface as an error. We could pick a mode, but
    silently accepting crate-level drift would defeat the purpose of the check.
    """
    values = {source.value for source in crate_sources}
    if len(values) == 1:
        return next(iter(values))
    raise SystemExit(
        "crates/*/Cargo.toml versions disagree — cannot derive canonical version.\n"
        + "\n".join(f"  {s.file}: {s.value}" for s in crate_sources)
    )


def check(
    sources: list[Source],
    allowlist: list[AllowlistEntry],
    canonical: str,
) -> tuple[list[Drift], list[AllowlistEntry]]:
    """Return (drifts, stale_entries).

    A source is OK if:
      - value matches canonical, OR
      - an allowlist entry matches its (file, field) AND the entry's
        `current_value` matches the source's `value`.

    An allowlist entry is "load-bearing" if the source it covers is
    currently drifting (whether or not `current_value` is up to date —
    a wrong `current_value` is still a drift, and the entry still has a
    role to play). "Stale" means not load-bearing:

      - the (file, field) no longer exists in the repo (file renamed
        or removed), OR
      - the source exists but no longer drifts (the underlying problem
        was resolved without also retiring the entry).

    Crucially, the case where an entry exists AND the source still drifts
    but `current_value` is wrong is NOT stale — the entry is load-bearing,
    just needs updating. That case is surfaced as a drift with a message
    that tells the maintainer exactly what to do, and must not also fire
    the stale-entry message (which would tell them to remove the entry
    instead — the wrong action). See #1513.
    """
    drifts: list[Drift] = []

    by_key: dict[tuple[str, str], AllowlistEntry] = {_key(e): e for e in allowlist}

    # Keys whose source is currently drifting. An allowlist entry is
    # load-bearing iff its key is in this set — a clean, non-drifting
    # source makes any entry pointing at it stale.
    load_bearing_keys: set[tuple[str, str]] = set()

    for source in sources:
        expected = _expected_for(source, canonical)

        # Most sources should equal the canonical (or the caret-derived form).
        if source.value == expected:
            continue

        # Drifted: allowlist may suppress.
        key = _source_key(source)
        entry = by_key.get(key)
        if entry is None:
            drifts.append(
                Drift(
                    source=source,
                    canonical=canonical,
                    detail=(
                        f"{source.value!r} drifted from expected {expected!r} "
                        f"(canonical={canonical!r}) and has no allowlist entry. "
                        f"Either re-align the value or add an `[[allowed_skews]]` "
                        f"row for ({source.file!r}, {source.field!r}) with a "
                        f"reason, expires_at, and tracking_issue."
                    ),
                )
            )
            continue

        # An entry exists for a drifting source — it IS load-bearing, even
        # if `current_value` is stale. Whether the entry is accurate is a
        # separate check below.
        load_bearing_keys.add(key)

        if entry.current_value != source.value:
            drifts.append(
                Drift(
                    source=source,
                    canonical=canonical,
                    detail=(
                        f"allowlist entry for ({source.file!r}, {source.field!r}) "
                        f"says current_value={entry.current_value!r} but actual "
                        f"value is {source.value!r}. Either update the allowlist "
                        f"or re-align the source."
                    ),
                )
            )
            continue

    stale_entries = [entry for entry in allowlist if _key(entry) not in load_bearing_keys]
    return drifts, stale_entries


def run(
    repo_root: Path,
    allowlist_path: Path,
) -> int:
    sources = load_all_sources(repo_root)
    canonical = compute_canonical(crate_package_versions(sources))
    allowlist = load_allowlist(allowlist_path)

    drifts, stale_entries = check(sources, allowlist, canonical)
    link_problems = lockfile_link_problems(repo_root)

    # Report.
    print(f"canonical version (from crates/*/Cargo.toml): {canonical}")
    print(f"sources checked: {len(sources)}")
    print(f"allowlist entries: {len(allowlist)}")

    if drifts:
        print()
        print(f"ERROR: {len(drifts)} unallowlisted drift(s) detected:")
        for drift in drifts:
            print(f"  - {drift.source.file} / {drift.source.field}")
            print(f"      value={drift.source.value!r} canonical={drift.canonical!r}")
            print(f"      {drift.detail}")

    if stale_entries:
        print()
        print(f"ERROR: {len(stale_entries)} stale allowlist entry/entries:")
        for entry in stale_entries:
            print(f"  - {entry.file} / {entry.field}")
            print(f"      no matching source found — the drift has been resolved.")
            print(f"      remove this entry AND close tracking issue {entry.tracking_issue}.")

    if link_problems:
        print()
        print(f"ERROR: {len(link_problems)} lockfile(s) do not install the in-tree package:")
        for problem in link_problems:
            print(f"  - {problem}")

    if drifts or stale_entries or link_problems:
        return 1

    print()
    print("OK: all sources are in sync (or covered by the allowlist)")
    return 0


# ---------------------------------------------------------------- set


def _load_macports_regen():
    spec = importlib.util.spec_from_file_location(
        "macports_regen_cargo_crates", Path(__file__).resolve().parent / "macports-regen-cargo-crates.py"
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# The fields of a package.json that a lockfile copies into its entry for
# that package, and that `--set` rewrites.
_LOCKFILE_DEPENDENCY_BLOCKS = ("dependencies", "peerDependencies")


def sync_npm_lockfiles(repo_root: Path) -> list[str]:
    """Bring each npm lockfile's copies of the rewritten package.json fields along.

    A lockfile repeats, for its own package (`""`) and for every in-tree
    package it links (`"../npm"`), the `version` and dependency ranges of that
    package's package.json. `--set` rewrites the versions and the pins on the
    wasm packages, so those copies, and nothing else, are updated here.
    `npm install --package-lock-only` would do the same, and also rewrite
    whatever the running npm lays out differently from the one that wrote
    the lockfile.
    """
    pinned = {dep for _file, _block, dep in _CONSUMER_PINS}
    changed: list[str] = []
    lockfiles = sorted(repo_root.glob("packages/*/package-lock.json")) + sorted(
        repo_root.glob("apps/*/package-lock.json")
    )
    for lockfile in lockfiles:
        text = lockfile.read_text(encoding="utf-8")
        data = json.loads(text)
        for key, entry in data.get("packages", {}).items():
            if key.startswith("node_modules/") or "version" not in entry:
                continue
            manifest_path = lockfile.parent / key / "package.json"
            if not manifest_path.is_file():
                continue
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            entry["version"] = manifest["version"]
            if key == "" and "version" in data:
                data["version"] = manifest["version"]
            for block in _LOCKFILE_DEPENDENCY_BLOCKS:
                for name in pinned & entry.get(block, {}).keys() & manifest.get(block, {}).keys():
                    entry[block][name] = manifest[block][name]
        # npm writes JSON.stringify(lockfile, null, 2) and a newline.
        updated = json.dumps(data, indent=2, ensure_ascii=False) + "\n"
        if updated != text:
            lockfile.write_text(updated, encoding="utf-8")
            changed.append(lockfile.relative_to(repo_root).as_posix())
    return changed


def dated_changelog(text: str, version: str, released: str) -> str:
    """CHANGELOG.md with `## [Unreleased]`'s entries under a dated `## [X.Y.Z]` heading."""
    heading = re.search(rf"^## \[{re.escape(version)}\].*$", text, re.MULTILINE)
    if heading is not None:
        if re.fullmatch(rf"## \[{re.escape(version)}\] - [0-9]{{4}}-[0-9]{{2}}-[0-9]{{2}}", heading.group(0)):
            return text
        raise SystemExit(f"CHANGELOG.md: `{heading.group(0)}` is not dated; its entries belong under `## [Unreleased]`")
    unreleased = re.search(r"^## \[Unreleased\]\n(.*?)(?=^## \[|\Z)", text, re.MULTILINE | re.DOTALL)
    if unreleased is None:
        raise SystemExit("CHANGELOG.md: no `## [Unreleased]` heading to release")
    if not unreleased.group(1).strip():
        raise SystemExit("CHANGELOG.md: `## [Unreleased]` is empty, so the release would have no entries")
    return text[: unreleased.start(1)] + f"\n## [{version}] - {released}\n" + text[unreleased.start(1) :]


def set_version(repo_root: Path, allowlist_path: Path, version: str, released: str) -> list[str]:
    """Rewrite every source to `version`; return the files that changed.

    Everything that can refuse the bump is checked before anything is written.
    """
    allowlisted = {_key(entry) for entry in load_allowlist(allowlist_path)}
    sources = load_all_sources(repo_root)
    current = compute_canonical(crate_package_versions(sources))
    if tuple(map(int, version.split("."))) < tuple(map(int, current.split("."))):
        raise SystemExit(f"--set {version} is older than the workspace's {current}")
    changelog = repo_root / "CHANGELOG.md"
    changelog_text = changelog.read_text(encoding="utf-8")
    dated = dated_changelog(changelog_text, version, released)

    edits: dict[str, list[tuple[int, int, str]]] = {}
    for source in sources:
        if _source_key(source) not in allowlisted:
            edits.setdefault(source.file, []).append((*source.span, source.render(version, released)))

    changed: list[str] = []
    for relative, file_edits in edits.items():
        path = repo_root / relative
        text = path.read_text(encoding="utf-8")
        updated = text
        # From the end, so an edit does not move the offsets of the ones before it.
        for start, end, replacement in sorted(file_edits, reverse=True):
            updated = updated[:start] + replacement + updated[end:]
        if updated != text:
            path.write_text(updated, encoding="utf-8")
            changed.append(relative)

    changed += sync_npm_lockfiles(repo_root)

    portfile = repo_root / "packaging/macports/Portfile"
    cargo_lock = repo_root / "Cargo.lock"
    if portfile.is_file() and cargo_lock.is_file():
        regen = _load_macports_regen()
        text = portfile.read_text(encoding="utf-8")
        block = regen.render_block(regen.parse_cargo_lock(cargo_lock.read_text(encoding="utf-8")))
        updated = regen.replace_block_in_portfile(text, block)
        if updated != text:
            portfile.write_text(updated, encoding="utf-8")
            changed.append("packaging/macports/Portfile")

    if dated != changelog_text:
        changelog.write_text(dated, encoding="utf-8")
        changed.append("CHANGELOG.md")
    return sorted(set(changed))


# ---------------------------------------------------------------- CLI


def _release_version(value: str) -> str:
    if re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", value) is None:
        raise argparse.ArgumentTypeError(f"{value!r} is not X.Y.Z")
    return value


def _release_date(value: str) -> str:
    try:
        return date.fromisoformat(value).isoformat()
    except ValueError:
        raise argparse.ArgumentTypeError(f"{value!r} is not YYYY-MM-DD")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    parser.add_argument(
        "--repo-root",
        type=Path,
        default=REPO_ROOT,
        help="repo root (defaults to the ancestor containing this script)",
    )
    parser.add_argument(
        "--allowlist",
        type=Path,
        default=DEFAULT_ALLOWLIST_PATH,
        help="allowlist file path (defaults to ci/version-skew-allowlist.toml)",
    )
    parser.add_argument(
        "--set",
        metavar="X.Y.Z",
        type=_release_version,
        help="bump every source to this version for a release, then run the check",
    )
    parser.add_argument(
        "--date",
        default=date.today().isoformat(),
        type=_release_date,
        help="the release date --set writes, as YYYY-MM-DD (defaults to today)",
    )
    args = parser.parse_args()
    if args.set:
        for relative in set_version(args.repo_root, args.allowlist, args.set, args.date):
            print(f"updated {relative}")
        print()
    return run(args.repo_root, args.allowlist)


if __name__ == "__main__":
    raise SystemExit(main())
