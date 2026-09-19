"""What each registry must accept before a release is attempted, as code.

`docs/publishing-requirements.md` is the table of conditions each
distribution channel imposes on an upload. This module is the one
executable definition of the conditions that can be checked without
publishing, and it is imported by both places that check them:

  - `scripts/check-publishable.py`, which `.github/workflows/publishable.yml`
    runs in the merge queue, on every push to `main`, nightly, and on the
    pull requests `packaging_reasons` picks out (ADR-0079);
  - `scripts/publish-registries.py`, which `publish-registries.yml` runs
    before it publishes crates.io and npm — for the release commit in the
    release preflight, and again for the upload itself (ADR-0069).

Keeping one definition is the point. The v0.6.0 release was refused by
crates.io for a crate over its upload limit that no pull request had ever
packaged, and a publish job failed on a build path no pull request ran.
A check that lives in two places drifts the same way.

Every `*_problems` function returns a list of human-readable problems and
never raises for a condition the package violates; an empty list means the
package is publishable as far as that check can tell. Warnings printed by a
publish tool count as problems — a warning today is how a registry says
what it will refuse or silently rewrite tomorrow.

Stdlib only, so it runs on a fresh CI runner and on the maintainer's
machine without installing anything.
"""

from __future__ import annotations

import fnmatch
import hashlib
import io
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import tomllib
import urllib.request
import xml.etree.ElementTree as ElementTree
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterable

import swift_package
from _action_yml import extract_job_step_run, extract_step_run

REPO_ROOT = Path(__file__).resolve().parents[1]

MIB = 1024 * 1024

# crates.io answers HTTP 413 for a larger `.crate`
# (https://doc.rust-lang.org/cargo/reference/publishing.html, "10MB";
# the registry enforces 10 MiB). `cargo publish --dry-run` never uploads,
# so it passes a crate of any size; the check measures the packaged file.
CRATES_IO_MAX_UPLOAD = 10 * MIB

# Any single packaged file above this size must be declared on the package
# below. crates.io refused `chordsketch-render-pdf` 0.6.0 at 15.6 MiB because
# test PDFs had been packaged with it; declaring the large files a package is
# meant to carry turns the next accidental one into a failure on the pull
# request that adds it, long before it reaches a registry's hard limit.
LARGE_FILE_BYTES = 1 * MIB

# Files that must never be in a published package, matched against each
# path inside the package (after the registry's top-level directory).
FORBIDDEN_PATHS = (
    ".env",
    ".env.*",
    "*.pem",
    "*.key",
    "*.p12",
    "*.pfx",
    "*.jks",
    "*.keystore",
    "id_rsa*",
    "id_ed25519*",
    ".npmrc",
    ".pypirc",
    ".git/*",
    "node_modules/*",
    "target/*",
)

# Credential formats with a fixed, distinctive shape. A match in any packaged
# text file is a leaked secret, not a false positive worth tolerating.
SECRET_PATTERNS = (
    ("private key", re.compile(rb"-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----")),
    ("GitHub token", re.compile(rb"\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b")),
    ("GitHub token", re.compile(rb"\bgithub_pat_[A-Za-z0-9_]{82}\b")),
    ("npm token", re.compile(rb"\bnpm_[A-Za-z0-9]{36}\b")),
    ("crates.io token", re.compile(rb"\bcio[A-Za-z0-9]{32}\b")),
    ("PyPI token", re.compile(rb"\bpypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{50,}")),
    ("RubyGems key", re.compile(rb"\brubygems_[0-9a-f]{48}\b")),
    ("AWS access key", re.compile(rb"\bAKIA[0-9A-Z]{16}\b")),
    ("Slack token", re.compile(rb"\bxox[abprs]-[A-Za-z0-9-]{10,}")),
)

# cargo prints these on a dry run of a version that is already on crates.io
# (every pull request between releases) and on every dry run. Neither says
# anything about whether the package can be published; every other
# `warning:` line does.
EXPECTED_CARGO_WARNINGS = (
    re.compile(r"^warning: crate \S+ already exists on crates\.io index$"),
    re.compile(r"^warning: aborting upload due to dry run$"),
)

# npm needs a token in its config to run `npm publish --dry-run` without
# warning that it is not logged in; the dry run never sends it. Using the
# same placeholder config on CI and on the maintainer's machine makes the two
# runs print the same thing, so a warning means the same thing in both.
NPM_DRY_RUN_CONFIG = "//registry.npmjs.org/:_authToken=publish-dry-run-placeholder\n"

# Dependency specs that point outside the npm registry. A published package
# carrying one installs differently on a user's machine than in this
# repository, or not at all.
NON_REGISTRY_SPEC = re.compile(r"^(?:file:|link:|workspace:|portal:|git\+|git:|github:|https?:)|^[^@/\s]+/[^@/\s]+$")


@dataclass(frozen=True)
class PackedFile:
    """One file inside a packaged artifact.

    `path` is relative to the artifact's top-level directory (`package/` for
    npm, `<crate>-<version>/` for crates.io).
    """

    path: str
    size: int
    data: bytes


# ---------------------------------------------------------------- shared rules


def content_problems(label: str, files: list[PackedFile], large_files: tuple[str, ...]) -> list[str]:
    """Forbidden files, leaked secrets and undeclared large files in a package."""
    problems = []
    for packed in files:
        if any(_matches(packed.path, pattern) for pattern in FORBIDDEN_PATHS):
            problems.append(f"{label} would publish `{packed.path}`, which must never be in a published package")
        for kind, pattern in SECRET_PATTERNS:
            if pattern.search(packed.data):
                problems.append(f"{label} would publish what looks like a {kind} in `{packed.path}`")
                break
        if packed.size > LARGE_FILE_BYTES and not any(fnmatch.fnmatch(packed.path, glob) for glob in large_files):
            problems.append(
                f"{label} would publish `{packed.path}` ({packed.size / MIB:.1f} MiB), a file over "
                f"{LARGE_FILE_BYTES // MIB} MiB that is not declared as one of the package's large files in "
                f"scripts/_publish_checks.py; exclude it from the package or declare it"
            )
    # A declaration only has to match a packed file, not stay over the
    # threshold: a source map hovering around 1 MiB must not flip the check.
    for glob in large_files:
        if not any(fnmatch.fnmatch(packed.path, glob) for packed in files):
            problems.append(
                f"{label} declares `{glob}` as a large file in scripts/_publish_checks.py, but the package has no "
                f"file matching it; remove the stale declaration"
            )
    return problems


def _matches(path: str, pattern: str) -> bool:
    """A forbidden pattern matches the path or any of its trailing segments."""
    parts = path.split("/")
    return any(fnmatch.fnmatch("/".join(parts[i:]), pattern) for i in range(len(parts)))


# Terminal colour codes. CI sets `CARGO_TERM_COLOR=always`, which wraps
# cargo's `warning` in them; left in, no warning line would match.
ANSI_ESCAPE = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")


def tool_warnings(label: str, output: str, *, prefix: re.Pattern[str], expected: tuple[re.Pattern[str], ...] = ()) -> list[str]:
    """Every warning line a publish tool printed, except the expected ones."""
    lines = [ANSI_ESCAPE.sub("", line).rstrip() for line in output.splitlines()]
    unexpected = [line for line in lines if prefix.match(line) and not any(p.match(line) for p in expected)]
    return [f"{label} warned: {line}" for line in unexpected]


CARGO_WARNING = re.compile(r"^warning:")
NPM_WARNING = re.compile(r"^npm warn", re.IGNORECASE)


def read_tarball(path: Path, *, strip_top_level: bool = True) -> list[PackedFile]:
    files = []
    with tarfile.open(path, "r:gz") as archive:
        for member in archive.getmembers():
            if not member.isfile():
                continue
            name = member.name.split("/", 1)[1] if strip_top_level and "/" in member.name else member.name
            extracted = archive.extractfile(member)
            files.append(PackedFile(name, member.size, extracted.read() if extracted else b""))
    return files


# ---------------------------------------------------------------- process


Runner = Callable[..., subprocess.CompletedProcess]


def run(cmd: list[str], cwd: Path, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    """Run a command, echoing it and its combined output, and return it."""
    print(f"$ {' '.join(cmd)}   (in {cwd})", flush=True)
    try:
        result = subprocess.run(
            cmd,
            cwd=cwd,
            env={**os.environ, **(env or {})},
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
        )
    except FileNotFoundError:
        # A missing tool is a failed check, reported like any other.
        return subprocess.CompletedProcess(cmd, 127, f"{cmd[0]}: command not found\n")
    print(result.stdout, end="", flush=True)
    return result


def tail(output: str, lines: int = 20) -> str:
    return "\n".join(output.rstrip().splitlines()[-lines:])


# ---------------------------------------------------------------- crates.io


@dataclass(frozen=True)
class Crate:
    """A crate published to crates.io, and the large files it carries on purpose."""

    name: str
    large_files: tuple[str, ...] = ()


CRATES: dict[str, Crate] = {
    crate.name: crate
    for crate in (
        Crate("chordsketch-chordpro"),
        Crate("chordsketch-ireal"),
        Crate("chordsketch-render-text"),
        Crate("chordsketch-render-html"),
        # The embedded CJK subset font is the renderer's fallback for
        # Japanese / Chinese / Korean lyrics and is loaded at runtime.
        Crate("chordsketch-render-pdf", large_files=("assets/NotoSansCJK-subset.otf",)),
        Crate("chordsketch-render-ireal"),
        Crate("chordsketch-convert"),
        Crate("chordsketch-convert-musicxml"),
        Crate("chordsketch-mcp"),
        Crate("chordsketch"),
    )
}

REQUIRED_CRATE_METADATA = ("description", "license", "repository", "readme")


def crate_size_problems(sizes: dict[str, int | None]) -> list[str]:
    """Crates that crates.io would refuse for their size.

    `sizes` maps each crate to the byte size of its packaged `.crate`, or
    None when that file is missing. A missing file is a problem too: an
    unmeasured crate is not known to fit.
    """
    problems = []
    for crate, size in sizes.items():
        if size is None:
            problems.append(f"`cargo package` left no .crate for {crate}, so its size against crates.io's upload limit is unknown")
        elif size > CRATES_IO_MAX_UPLOAD:
            problems.append(
                f"{crate} packages to {size / MIB:.1f} MiB, over crates.io's "
                f"{CRATES_IO_MAX_UPLOAD // MIB} MiB upload limit; `exclude` what the published crate "
                f"does not need in its Cargo.toml (check with `cargo package -p {crate} --list`)"
            )
    return problems


def crate_metadata_problems(packages: list[dict], crates: Iterable[str]) -> list[str]:
    """Metadata crates.io shows on the crate page and that every crate here must carry.

    `packages` is the `packages` array of `cargo metadata --no-deps`.
    """
    by_name = {package["name"]: package for package in packages}
    problems = []
    for crate in crates:
        package = by_name.get(crate)
        if package is None:
            problems.append(f"{crate} is not a package of this workspace")
            continue
        if package.get("publish") == []:
            problems.append(f"{crate} sets `publish = false`, so crates.io would refuse it")
        for key in REQUIRED_CRATE_METADATA:
            if not package.get(key) and not (key == "license" and package.get("license_file")):
                problems.append(f"{crate} has no `{key}` in its Cargo.toml")
    return problems


def crate_readme_problems(crate: str, readme: str | None, files: list[PackedFile]) -> list[str]:
    if readme and readme not in {packed.path for packed in files}:
        return [f"{crate} names `{readme}` as its readme but the packaged crate does not contain it"]
    return []


def crates_problems(tree: Path, crates: tuple[str, ...], target_dir: Path, runner: Runner = run) -> list[str]:
    """Everything this module can check about publishing `crates` from `tree`.

    Runs `cargo publish --dry-run` over all of them together (Cargo 1.90+
    verifies every package against a local overlay registry, so crates that
    depend on each other at an unpublished version resolve), then packages
    them to measure what the dry run cannot see.
    """
    unknown = [crate for crate in crates if crate not in CRATES]
    if unknown:
        return [f"no publish definition in scripts/_publish_checks.py for crate(s): {', '.join(unknown)}"]
    env = {"CARGO_TARGET_DIR": str(target_dir)}
    flags = [item for crate in crates for item in ("-p", crate)]

    metadata = runner(["cargo", "metadata", "--format-version", "1", "--no-deps", "--locked"], tree, env)
    if metadata.returncode != 0:
        return [f"`cargo metadata` failed:\n{tail(metadata.stdout)}"]
    # `run` merges stderr into the output; the JSON document is the one
    # line `cargo metadata` prints on stdout.
    document = next(line for line in reversed(metadata.stdout.splitlines()) if line.startswith("{"))
    packages = json.loads(document)["packages"]
    problems = crate_metadata_problems(packages, crates)

    dry = runner(["cargo", "publish", "--dry-run", "--locked", *flags], tree, env)
    problems += tool_warnings("cargo publish --dry-run", dry.stdout, prefix=CARGO_WARNING, expected=EXPECTED_CARGO_WARNINGS)
    if dry.returncode != 0:
        return problems + [f"`cargo publish --dry-run` failed:\n{tail(dry.stdout)}"]

    # `cargo publish --dry-run` keeps its .crate files in an undocumented
    # scratch directory; `cargo package` writes them to target/package.
    packaged = runner(["cargo", "package", "--no-verify", "--locked", *flags], tree, env)
    if packaged.returncode != 0:
        return problems + [f"`cargo package` failed:\n{tail(packaged.stdout)}"]

    by_name = {package["name"]: package for package in packages}
    sizes: dict[str, int | None] = {}
    for crate in crates:
        path = target_dir / "package" / f"{crate}-{by_name[crate]['version']}.crate"
        if not path.is_file():
            sizes[crate] = None
            continue
        sizes[crate] = path.stat().st_size
        files = read_tarball(path)
        problems += content_problems(crate, files, CRATES[crate].large_files)
        problems += crate_readme_problems(crate, by_name[crate].get("readme"), files)
    return problems + crate_size_problems(sizes)


# ---------------------------------------------------------------- npm


@dataclass(frozen=True)
class NpmPackage:
    """An npm package this repository publishes.

    `build` is run in `directory` before packing, in order, and needs the
    `tools` on PATH beyond `npm` and `node`. `smoke` is a
    CommonJS snippet run with Node against the packed tarball installed into
    an empty project; it must throw if the package does not work. Packages
    Node cannot load without a bundler or a native compile leave it empty and
    are covered by the entry-point check alone.
    """

    name: str
    directory: str
    build: tuple[tuple[str, ...], ...] = ()
    tools: tuple[str, ...] = ()
    large_files: tuple[str, ...] = ()
    smoke: str = ""


WASM_SMOKE = """
const m = require(PACKAGE);
const text = m.render_text("{title: Smoke}\\n[C]Hello");
if (!text.includes("Smoke")) throw new Error("render_text lost the title: " + text);
"""

NAPI_SMOKE = """
const m = require(PACKAGE);
if (typeof m.version() !== "string") throw new Error("version() did not return a string");
if (!m.renderText("{title: Smoke}\\n[C]Hello").includes("Smoke")) throw new Error("renderText lost the title");
"""

NODE_TRIPLES = ("linux-x64-gnu", "linux-arm64-gnu", "darwin-x64", "darwin-arm64", "win32-x64-msvc")
NAPI_PACKAGE = "@chordsketch/node"
TSUP_BUILD = (("npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"), ("npm", "run", "build"))

NPM_PACKAGES: dict[str, NpmPackage] = {
    package.name: package
    for package in (
        NpmPackage(
            "@chordsketch/wasm",
            "packages/npm",
            build=(("npm", "run", "build"),),
            tools=("wasm-pack",),
            smoke=WASM_SMOKE,
        ),
        NpmPackage(
            "@chordsketch/wasm-export",
            "packages/npm-export",
            build=(("npm", "run", "build"),),
            tools=("wasm-pack",),
            # The PDF / PNG renderers are the reason this package exists.
            large_files=("web/chordsketch_wasm_bg.wasm", "node/chordsketch_wasm_bg.wasm"),
            smoke=WASM_SMOKE,
        ),
        # A grammar-source package: editors and the tree-sitter CLI read its
        # committed `src/` and `queries/`, so there is nothing to build and
        # no Node entry point to load.
        NpmPackage("tree-sitter-chordpro", "packages/tree-sitter-chordpro"),
        NpmPackage("@chordsketch/react-ui", "packages/react-ui", build=TSUP_BUILD),
        # The source maps of the editor bundle, which inlines CodeMirror.
        NpmPackage("@chordsketch/react", "packages/react", build=TSUP_BUILD, large_files=("dist/index.js.map", "dist/index.cjs.map")),
        NpmPackage("@chordsketch/vue", "packages/vue", build=TSUP_BUILD),
        NpmPackage("@chordsketch/svelte", "packages/svelte", build=TSUP_BUILD),
        NpmPackage(
            "@chordsketch/chordpro-lite",
            "packages/chordpro-lite",
            build=TSUP_BUILD,
            smoke='if (require(PACKAGE).detectFormat("{title: Smoke}") !== "chordpro") throw new Error("detectFormat");',
        ),
        # The resolver and its platform packages are packed from staged
        # prebuilt binaries by crates/napi/scripts/stage-release-tarballs.sh,
        # not from their directories, so they have no build here.
        NpmPackage(NAPI_PACKAGE, "crates/napi", smoke=NAPI_SMOKE),
        *(
            # The prebuilt addon is the whole package.
            NpmPackage(f"{NAPI_PACKAGE}-{triple}", f"crates/napi/npm/{triple}", large_files=(f"chordsketch-napi.{triple}.node",))
            for triple in NODE_TRIPLES
        ),
    )
}

REQUIRED_NPM_METADATA = ("description", "license", "repository")


def is_napi(package: str) -> bool:
    return package == NAPI_PACKAGE or package.startswith(NAPI_PACKAGE + "-")


def npm_tarball_name(package: str, version: str) -> str:
    """The file `npm pack` names a package's tarball."""
    return f"{package.removeprefix('@').replace('/', '-')}-{version}.tgz"


def npm_manifest_problems(manifest: dict, files: list[PackedFile]) -> list[str]:
    """Metadata and entry points of a packed `package.json`.

    npm rewrites a `repository.url` that is not in its canonical form while
    publishing and warns about it; that is caught by the warning check, so
    here only presence is required.
    """
    name = manifest.get("name", "<unnamed>")
    problems = [f"{name} has no `{key}` in its package.json" for key in REQUIRED_NPM_METADATA if not manifest.get(key)]
    paths = {packed.path for packed in files}
    if not any(path.lower().startswith("readme") and "/" not in path for path in paths):
        problems.append(f"{name} would publish without a README")
    for entry in sorted(set(entry_points(manifest))):
        target = entry.removeprefix("./")
        if target in paths or any(path.startswith(target.rstrip("/") + "/") for path in paths):
            continue
        # A directory entry such as `bindings/node` resolves to its index.
        if any(f"{target}/{index}" in paths for index in ("index.js", "index.cjs", "index.mjs", "package.json")):
            continue
        problems.append(f"{name} points `{entry}` at a file the packed tarball does not contain")
    return problems


def entry_points(manifest: dict) -> list[str]:
    """Every file path `main`, `module`, `types`, `bin` and `exports` name."""
    found: list[str] = []
    for key in ("main", "module", "types", "typings", "svelte"):
        if isinstance(manifest.get(key), str):
            found.append(manifest[key])
    bins = manifest.get("bin")
    if isinstance(bins, str):
        found.append(bins)
    elif isinstance(bins, dict):
        found.extend(v for v in bins.values() if isinstance(v, str))

    def walk(node: object) -> None:
        if isinstance(node, str):
            if "*" not in node:
                found.append(node)
        elif isinstance(node, dict):
            for value in node.values():
                walk(value)
        elif isinstance(node, list):
            for value in node:
                walk(value)

    walk(manifest.get("exports"))
    return found


def npm_dependency_problems(manifest: dict, released_together: dict[str, str], view: Callable[[str, str], bool]) -> list[str]:
    """Dependencies a user installing the package could not resolve.

    `released_together` maps the npm packages of this repository to the
    version on disk: a dependency on exactly that version, or on its caret
    range, is published in the same release. The release commit raises the
    `@chordsketch/wasm` ranges of the packages built on it to the version it
    releases (ADR-0073), so they name a version npm does not serve until the
    release publishes it. Anything else must already be satisfiable from the
    registry, which `view(name, range)` answers.
    """
    name = manifest.get("name", "<unnamed>")
    problems = []
    for field in ("dependencies", "peerDependencies", "optionalDependencies"):
        for dependency, spec in (manifest.get(field) or {}).items():
            on_disk = released_together.get(dependency)
            if NON_REGISTRY_SPEC.match(spec):
                problems.append(f"{name} {field} `{dependency}` is `{spec}`, which does not resolve from the npm registry")
            elif on_disk is not None and spec in (on_disk, f"^{on_disk}"):
                continue
            elif not view(dependency, spec):
                problems.append(f"{name} {field} `{dependency}@{spec}` matches no version published on npm")
    return problems


def npm_view(dependency: str, spec: str) -> bool:
    """Whether any published version of `dependency` satisfies `spec`."""
    result = subprocess.run(
        ["npm", "view", f"{dependency}@{spec}", "version", "--json"],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    return result.returncode == 0 and result.stdout.strip() not in ("", "[]")


def repo_npm_versions(tree: Path) -> dict[str, str]:
    return {
        name: json.loads((tree / package.directory / "package.json").read_text())["version"]
        for name, package in NPM_PACKAGES.items()
    }


def pack_npm(package: NpmPackage, tree: Path, out: Path, runner: Runner = run) -> tuple[Path | None, list[str]]:
    """Build `package` from `tree` and pack it into `out`."""
    directory = tree / package.directory
    for command in package.build:
        built = runner(list(command), directory)
        if built.returncode != 0:
            return None, [f"`{' '.join(command)}` failed for {package.name}:\n{tail(built.stdout)}"]
    packed = runner(["npm", "pack", "--json", "--pack-destination", str(out)], directory)
    if packed.returncode != 0:
        return None, [f"`npm pack` failed for {package.name}:\n{tail(packed.stdout)}"]
    version = json.loads((directory / "package.json").read_text())["version"]
    tarball = out / npm_tarball_name(package.name, version)
    if not tarball.is_file():
        return None, [f"`npm pack` for {package.name} did not write {tarball.name}"]
    return tarball, []


def npm_tarball_problems(
    package: NpmPackage,
    tarball: Path,
    released_together: dict[str, str],
    runner: Runner = run,
    view: Callable[[str, str], bool] = npm_view,
) -> list[str]:
    """Everything this module can check about publishing one packed tarball.

    The content checks read the tarball itself — the exact bytes the real
    publish uploads.
    """
    files = read_tarball(tarball)
    manifest_file = next((packed for packed in files if packed.path == "package.json"), None)
    if manifest_file is None:
        return [f"{tarball.name} has no package.json"]
    manifest = json.loads(manifest_file.data)
    problems = []
    if manifest.get("name") != package.name:
        problems.append(f"{tarball.name} is `{manifest.get('name')}`, not {package.name}")
    problems += npm_manifest_problems(manifest, files)
    problems += content_problems(package.name, files, package.large_files)
    problems += npm_dependency_problems(manifest, released_together, view)

    with tempfile.TemporaryDirectory(prefix="npm-dry-run-") as scratch:
        config = Path(scratch) / "npmrc"
        config.write_text(NPM_DRY_RUN_CONFIG)
        unpacked = unpack_for_dry_run(files, Path(scratch) / "package")
        dry = runner(["npm", "publish", "--dry-run", "--access", "public"], unpacked, {"npm_config_userconfig": str(config)})
    problems += tool_warnings(f"npm publish --dry-run {tarball.name}", dry.stdout, prefix=NPM_WARNING)
    if dry.returncode != 0:
        problems.append(f"`npm publish --dry-run` failed for {tarball.name}:\n{tail(dry.stdout)}")
    return problems


def unpack_for_dry_run(files: list[PackedFile], directory: Path) -> Path:
    """Lay a packed tarball out as a directory `npm publish --dry-run` can read.

    npm only normalises `package.json` — and warns that it "auto-corrected"
    it, as it did for four packages in 0.6.0 — when it publishes a
    directory; given a tarball it uploads the manifest untouched and says
    nothing. So the dry run runs on the unpacked files. Lifecycle scripts are
    dropped from the copy: `npm publish` runs `prepare` even with
    `--ignore-scripts`, and the build it runs has already happened.
    """
    for packed in files:
        target = directory / packed.path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(packed.data)
    manifest_path = directory / "package.json"
    manifest = json.loads(manifest_path.read_text())
    manifest.pop("scripts", None)
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    return directory


def npm_smoke_problems(package: NpmPackage, tarballs: list[Path], runner: Runner = run) -> list[str]:
    """Install the packed tarballs into an empty project and run the smoke snippet."""
    if not package.smoke:
        return []
    with tempfile.TemporaryDirectory(prefix="npm-smoke-") as scratch:
        project = Path(scratch)
        (project / "package.json").write_text('{"name": "publish-smoke", "private": true}\n')
        installed = runner(["npm", "install", "--no-audit", "--no-fund", *map(str, tarballs)], project)
        if installed.returncode != 0:
            return [f"installing the packed {package.name} failed:\n{tail(installed.stdout)}"]
        script = f"const PACKAGE = {json.dumps(package.name)};\n{package.smoke}"
        smoke = runner(["node", "-e", script], project)
        if smoke.returncode != 0:
            return [f"the packed {package.name} installs but does not work:\n{tail(smoke.stdout)}"]
    return []


def host_napi_triple() -> str | None:
    """The `@chordsketch/node-*` platform package Node on this machine loads."""
    system = {"Linux": "linux", "Darwin": "darwin", "Windows": "win32"}.get(platform.system())
    machine = {"x86_64": "x64", "AMD64": "x64", "arm64": "arm64", "aarch64": "arm64"}.get(platform.machine())
    suffix = {"linux": "-gnu", "win32": "-msvc", "darwin": ""}.get(system or "")
    triple = f"{system}-{machine}{suffix}"
    return triple if triple in NODE_TRIPLES else None


def napi_problems(
    tarball_dir: Path,
    version: str,
    released_together: dict[str, str],
    runner: Runner = run,
    packages: Iterable[str] | None = None,
) -> list[str]:
    """Check the resolver and platform tarballs staged for a release.

    `packages` narrows the check to some of the six, for a publish that
    resumes after the others went out: npm 11's `publish --dry-run` refuses
    a version that is already published. The smoke install then takes the
    host's platform package from the registry when its tarball is not
    among them.
    """
    selected = [name for name in NPM_PACKAGES if is_napi(name) and (packages is None or name in packages)]
    problems = []
    tarballs: dict[str, Path] = {}
    for name in selected:
        tarball = tarball_dir / npm_tarball_name(name, version)
        if not tarball.is_file():
            problems.append(f"no staged tarball {tarball.name} in {tarball_dir}")
            continue
        tarballs[name] = tarball
        problems += npm_tarball_problems(NPM_PACKAGES[name], tarball, released_together, runner)
    host = host_napi_triple()
    host_package = f"{NAPI_PACKAGE}-{host}" if host else ""
    if NAPI_PACKAGE in tarballs and (host_package in tarballs or packages is not None):
        smoke = [tarballs[p] for p in (host_package, NAPI_PACKAGE) if p in tarballs]
        problems += npm_smoke_problems(NPM_PACKAGES[NAPI_PACKAGE], smoke, runner)
    return problems


def npm_problems(package: NpmPackage, tree: Path, out: Path, released_together: dict[str, str], runner: Runner = run) -> list[str]:
    """Build, pack, dry-run and smoke-test one non-napi npm package."""
    tarball, problems = pack_npm(package, tree, out, runner)
    if tarball is None:
        return problems
    return npm_tarball_problems(package, tarball, released_together, runner) + npm_smoke_problems(package, [tarball], runner)


# ---------------------------------------------------------------- VS Code Marketplace / Open VSX


@dataclass(frozen=True)
class VscodeTarget:
    """A platform-specific VSIX: the Marketplace target and the LSP it bundles.

    `server_dir` is where `src/platform.ts` looks for the bundled
    `chordsketch-lsp`; the Alpine targets reuse the Linux directories
    because Node reports `linux` on Alpine.
    """

    vs_target: str
    rust_target: str
    server_dir: str
    ext: str


VSCODE_EXTENSION_DIR = "packages/vscode-extension"
VSCODE_TARGETS = (
    VscodeTarget("linux-x64", "x86_64-unknown-linux-gnu", "linux-x64", ""),
    VscodeTarget("linux-arm64", "aarch64-unknown-linux-gnu", "linux-arm64", ""),
    VscodeTarget("darwin-x64", "x86_64-apple-darwin", "darwin-x64", ""),
    VscodeTarget("darwin-arm64", "aarch64-apple-darwin", "darwin-arm64", ""),
    VscodeTarget("win32-x64", "x86_64-pc-windows-msvc", "win32-x64", ".exe"),
    VscodeTarget("alpine-x64", "x86_64-unknown-linux-musl", "linux-x64", ""),
    VscodeTarget("alpine-arm64", "aarch64-unknown-linux-musl", "linux-arm64", ""),
)
VSIX_LARGE_FILES = (
    # The wasm engine, once for the extension host and once for the webview.
    "extension/dist/node/chordsketch_wasm_bg.wasm",
    "extension/dist/webview/chordsketch_wasm_bg.wasm",
)

# The Marketplace supports only `major.minor.patch`, with no pre-release
# suffix (https://code.visualstudio.com/api/working-with-extensions/publishing-extension#prerelease-extensions).
MARKETPLACE_VERSION = re.compile(r"^\d+\.\d+\.\d+$")
EXTENSION_NAME = re.compile(r"^[a-z0-9][a-z0-9._-]*$")
VSCE_WARNING = re.compile(r"^\s*WARNING\b")
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


def vsix_name(version: str, target: VscodeTarget | None) -> str:
    """The file `vsce package` names a VSIX."""
    return f"chordsketch-{target.vs_target}-{version}.vsix" if target else f"chordsketch-{version}.vsix"


def read_zip(path: Path) -> list[PackedFile]:
    with zipfile.ZipFile(path) as archive:
        return [
            PackedFile(info.filename, info.file_size, archive.read(info))
            for info in archive.infolist()
            if not info.is_dir()
        ]


def png_size(data: bytes) -> tuple[int, int] | None:
    """Width and height from a PNG's IHDR chunk, or None if it is not a PNG."""
    if not data.startswith(PNG_SIGNATURE) or data[12:16] != b"IHDR":
        return None
    return int.from_bytes(data[16:20], "big"), int.from_bytes(data[20:24], "big")


def vsix_manifest_problems(label: str, manifest: dict, files: list[PackedFile]) -> list[str]:
    """What the Marketplace and Open VSX require of `extension/package.json`.

    https://code.visualstudio.com/api/references/extension-manifest and
    https://code.visualstudio.com/api/working-with-extensions/publishing-extension
    (icon, version); Open VSX requires a license
    (https://github.com/EclipseFdn/open-vsx.org/wiki/Publishing-Extensions).
    """
    problems = []
    for key in ("name", "publisher", "version", "license", "repository"):
        if not manifest.get(key):
            problems.append(f"{label} has no `{key}` in its package.json")
    if not (manifest.get("engines") or {}).get("vscode"):
        problems.append(f"{label} has no `engines.vscode` in its package.json")
    if manifest.get("name") and not EXTENSION_NAME.match(manifest["name"]):
        problems.append(f"{label} name `{manifest['name']}` must be lowercase with no spaces")
    if manifest.get("version") and not MARKETPLACE_VERSION.match(manifest["version"]):
        problems.append(f"{label} version `{manifest['version']}` is not major.minor.patch, the only form the Marketplace accepts")
    if len(manifest.get("keywords") or []) > 30:
        problems.append(f"{label} has more than 30 keywords")
    icon = manifest.get("icon")
    if not icon:
        problems.append(f"{label} has no `icon`")
    else:
        packed = next((f for f in files if f.path == f"extension/{icon}"), None)
        size = png_size(packed.data) if packed else None
        if packed is None:
            problems.append(f"{label} names icon `{icon}` but the VSIX does not contain it")
        elif size is None:
            problems.append(f"{label} icon `{icon}` is not a PNG; the Marketplace refuses SVG icons")
        elif min(size) < 128:
            problems.append(f"{label} icon `{icon}` is {size[0]}x{size[1]}; the Marketplace requires at least 128x128")
    return problems


def vsix_problems(path: Path, target: VscodeTarget | None) -> list[str]:
    """Everything checkable about one packaged VSIX."""
    label = path.name
    files = read_zip(path)
    manifest_file = next((f for f in files if f.path == "extension/package.json"), None)
    if manifest_file is None:
        return [f"{label} has no extension/package.json"]
    problems = vsix_manifest_problems(label, json.loads(manifest_file.data), files)
    large = VSIX_LARGE_FILES
    servers = sorted(f.path for f in files if f.path.startswith("extension/server/"))
    if target is None and servers:
        problems.append(f"{label} is the universal VSIX but bundles {', '.join(servers)}")
    if target is not None:
        server = f"extension/server/{target.server_dir}/chordsketch-lsp{target.ext}"
        if server not in servers:
            problems.append(f"{label} does not bundle `{server}`, so the extension has no language server on {target.vs_target}")
        if others := [path for path in servers if path != server]:
            problems.append(f"{label} also bundles {', '.join(others)}, which belong to other targets")
        if server in servers:
            large = (*large, server)
        vsixmanifest = next((f for f in files if f.path == "extension.vsixmanifest"), None)
        if vsixmanifest is None or f'TargetPlatform="{target.vs_target}"'.encode() not in vsixmanifest.data:
            problems.append(f"{label} is not marked as the {target.vs_target} build in extension.vsixmanifest")
    return problems + content_problems(label, files, large)


def vsce_package_problems(directory: Path, target: VscodeTarget | None, lsp: Path | None = None, runner: Runner = run) -> list[str]:
    """Package one VSIX the way the release does and check it.

    For a platform-specific VSIX, `lsp` is that target's `chordsketch-lsp`;
    it is placed alone in `server/`, since `vsce` packages whatever is
    there.
    """
    server_root = directory / "server"
    if server_root.exists():
        shutil.rmtree(server_root)
    if target is not None:
        if lsp is None or not lsp.is_file():
            return [f"no chordsketch-lsp binary to bundle into the {target.vs_target} VSIX (got {lsp})"]
        destination = server_root / target.server_dir / f"chordsketch-lsp{target.ext}"
        destination.parent.mkdir(parents=True)
        shutil.copyfile(lsp, destination)
        destination.chmod(0o755)
    command = ["./node_modules/.bin/vsce", "package", "--no-dependencies"]
    if target is not None:
        command += ["--target", target.vs_target]
    packaged = runner(command, directory)
    problems = tool_warnings(" ".join(command[1:]), packaged.stdout, prefix=VSCE_WARNING)
    if packaged.returncode != 0:
        return problems + [f"`vsce package` failed:\n{tail(packaged.stdout)}"]
    version = json.loads((directory / "package.json").read_text())["version"]
    path = directory / vsix_name(version, target)
    if not path.is_file():
        return problems + [f"`vsce package` did not write {path.name}"]
    return problems + vsix_problems(path, target)


def vsix_set_problems(directory: Path) -> list[str]:
    """The set of VSIXes the publish jobs upload: one universal and one per target, nothing else."""
    version = json.loads((directory / "package.json").read_text())["version"]
    expected = {vsix_name(version, None): None, **{vsix_name(version, t): t for t in VSCODE_TARGETS}}
    present = {path.name for path in directory.glob("*.vsix")}
    problems = []
    if missing := sorted(set(expected) - present):
        problems.append(f"missing VSIX(es): {', '.join(missing)}")
    if extra := sorted(present - set(expected)):
        problems.append(f"unexpected VSIX(es) that would also be published: {', '.join(extra)}")
    for name in sorted(set(expected) & present):
        problems += vsix_problems(directory / name, expected[name])
    return problems


# ---------------------------------------------------------------- PyPI


# https://docs.pypi.org/project-management/storage-limits/
PYPI_MAX_FILE = 100 * MIB
# PEP 440 public version, as PyPI accepts it
# (https://packaging.python.org/en/latest/specifications/version-specifiers/).
PEP440_VERSION = re.compile(
    r"^(?:\d+!)?\d+(?:\.\d+)*(?:(?:a|b|rc)\d+)?(?:\.post\d+)?(?:\.dev\d+)?$"
)
PYTHON_DIST_DIR = "crates/ffi"
PYTHON_SMOKE = "scripts/smoke-test-python.py"
# The sdist carries the workspace crates the wheel is built from, including
# the PDF renderer's embedded CJK subset font.
SDIST_LARGE_FILES = ("*/crates/render-pdf/assets/NotoSansCJK-subset.otf",)
# The native library is the wheel.
WHEEL_LARGE_FILES = ("chordsketch/*libchordsketch_ffi.so", "chordsketch/*libchordsketch_ffi.dylib", "chordsketch/*chordsketch_ffi.dll")
REQUIRED_PYTHON_METADATA = ("Name", "Version", "Summary", "Requires-Python")


def core_metadata(text: str) -> dict[str, list[str]]:
    """Header fields of a METADATA / PKG-INFO file (the body is the description)."""
    fields: dict[str, list[str]] = {}
    for line in text.split("\n\n", 1)[0].splitlines():
        if ":" in line and not line.startswith((" ", "\t")):
            key, value = line.split(":", 1)
            fields.setdefault(key.strip(), []).append(value.strip())
    return fields


def python_metadata_problems(label: str, metadata: dict[str, list[str]], has_description: bool) -> list[str]:
    problems = [f"{label} has no `{key}` in its metadata" for key in REQUIRED_PYTHON_METADATA if key not in metadata]
    if not ("License" in metadata or "License-Expression" in metadata):
        problems.append(f"{label} declares no license (`License` or `License-Expression`)")
    if "Project-URL" not in metadata and "Home-page" not in metadata:
        problems.append(f"{label} has no project URL")
    if not has_description:
        problems.append(f"{label} has no long description; PyPI would show an empty project page")
    for version in metadata.get("Version", []):
        if not PEP440_VERSION.match(version):
            problems.append(f"{label} version `{version}` is not a PEP 440 version PyPI accepts")
    return problems


def python_dist_problems(dist: Path, runner: Runner = run) -> list[str]:
    """Everything checkable about the sdist and wheels `maturin` wrote to `dist`."""
    sdists = sorted(dist.glob("*.tar.gz"))
    wheels = sorted(dist.glob("*.whl"))
    problems = []
    if not sdists:
        problems.append(f"no sdist in {dist}")
    if not wheels:
        problems.append(f"no wheel in {dist}")
    for path in [*sdists, *wheels]:
        if path.stat().st_size > PYPI_MAX_FILE:
            problems.append(f"{path.name} is {path.stat().st_size / MIB:.1f} MiB, over PyPI's {PYPI_MAX_FILE // MIB} MiB file limit")
    for path in wheels:
        # PyPI refuses the bare `linux_*` platform tag; Linux wheels must
        # carry a manylinux or musllinux tag (PEP 600, PEP 656).
        if re.search(r"-linux_[^-]+\.whl$", path.name):
            problems.append(f"{path.name} has a bare linux platform tag, which PyPI refuses; build it manylinux-compliant")
        files = read_zip(path)
        metadata_file = next((f for f in files if f.path.endswith(".dist-info/METADATA")), None)
        if metadata_file is None:
            problems.append(f"{path.name} has no METADATA")
            continue
        text = metadata_file.data.decode()
        description = text.split("\n\n", 1)[1].strip() if "\n\n" in text else ""
        problems += python_metadata_problems(path.name, core_metadata(text), bool(description))
        # A wheel is built for one platform, so it carries one of the libraries.
        libraries = tuple(glob for glob in WHEEL_LARGE_FILES if any(fnmatch.fnmatch(f.path, glob) for f in files))
        if not libraries:
            problems.append(f"{path.name} contains no chordsketch_ffi native library")
        problems += content_problems(path.name, files, libraries)
    for path in sdists:
        files = read_tarball(path, strip_top_level=False)
        pkg_info = next((f for f in files if f.path.count("/") == 1 and f.path.endswith("/PKG-INFO")), None)
        if pkg_info is None:
            problems.append(f"{path.name} has no PKG-INFO")
        problems += content_problems(path.name, files, SDIST_LARGE_FILES)

    with tempfile.TemporaryDirectory(prefix="twine-") as scratch:
        venv = Path(scratch) / "venv"
        python = venv / "bin" / "python"
        steps = [
            [os.environ.get("PYTHON", "python3"), "-m", "venv", str(venv)],
            [str(python), "-m", "pip", "install", "--quiet", "twine"],
        ]
        for step in steps:
            done = runner(step, Path(scratch))
            if done.returncode != 0:
                return problems + [f"could not set up twine:\n{tail(done.stdout)}"]
        # `--strict` turns twine's warnings (such as a missing or
        # unrenderable long description) into failures.
        checked = runner([str(python), "-m", "twine", "check", "--strict", *map(str, [*sdists, *wheels])], Path(scratch))
        if checked.returncode != 0:
            problems.append(f"`twine check --strict` failed:\n{tail(checked.stdout)}")

        installed = runner([str(python), "-m", "pip", "install", "--quiet", "--no-index", "--find-links", str(dist), "chordsketch"], Path(scratch))
        if installed.returncode != 0:
            problems.append(f"the built wheel does not install:\n{tail(installed.stdout)}")
        else:
            smoke = runner([str(python), str(REPO_ROOT / PYTHON_SMOKE)], Path(scratch))
            if smoke.returncode != 0:
                problems.append(f"the built wheel installs but does not work:\n{tail(smoke.stdout)}")
    return problems


# ---------------------------------------------------------------- RubyGems


RUBY_GEM_DIR = "packages/ruby"
# https://guides.rubygems.org/specification-reference/ — the required
# attributes, plus the license and homepage rubygems.org shows.
REQUIRED_GEM_ATTRIBUTES = ("name", "version", "summary", "authors", "files", "licenses", "homepage")
GEM_WARNING = re.compile(r"^WARNING:")
# The platform native libraries are the gem.
GEM_LARGE_FILES = ("lib/*/libchordsketch_ffi.so", "lib/*/libchordsketch_ffi.dylib", "lib/*/chordsketch_ffi.dll")
GEM_PLATFORM_LIBRARIES = (
    "lib/x86_64-linux/libchordsketch_ffi.so",
    "lib/aarch64-linux/libchordsketch_ffi.so",
    "lib/aarch64-darwin/libchordsketch_ffi.dylib",
    "lib/x86_64-darwin/libchordsketch_ffi.dylib",
    "lib/x86_64-windows/chordsketch_ffi.dll",
)
GEM_SMOKE = 'require "chordsketch"; raise "render lost the title" unless Chordsketch.parse_and_render_text("{title: Smoke}\\n[C]Hello", nil, nil).include?("Smoke")'
GEM_SPEC_JSON = 'require "json"; require "rubygems/package"; s = Gem::Package.new(ARGV[0]).spec; puts JSON.dump(%w[name version summary authors files licenses homepage].to_h { |k| [k, s.send(k)] })'


def gem_spec_problems(label: str, spec: dict) -> list[str]:
    problems = [f"{label} has no `{key}` in its gemspec" for key in REQUIRED_GEM_ATTRIBUTES if not spec.get(key)]
    missing = [path for path in GEM_PLATFORM_LIBRARIES if path not in (spec.get("files") or [])]
    if missing:
        problems.append(f"{label} would publish without {', '.join(missing)}, so it cannot load on those platforms")
    return problems


def gem_problems(directory: Path, runner: Runner = run) -> list[str]:
    """Build the gem from `directory` the way the release does, and check it."""
    for stale in directory.glob("*.gem"):
        stale.unlink()
    built = runner(["gem", "build", "chordsketch.gemspec"], directory)
    problems = tool_warnings("gem build", built.stdout, prefix=GEM_WARNING)
    if built.returncode != 0:
        return problems + [f"`gem build` failed:\n{tail(built.stdout)}"]
    gems = sorted(directory.glob("*.gem"))
    if len(gems) != 1:
        return problems + [f"`gem build` should write one .gem, found {[g.name for g in gems]}"]
    gem = gems[0]

    spec = runner(["ruby", "-e", GEM_SPEC_JSON, str(gem)], directory)
    if spec.returncode != 0:
        return problems + [f"could not read the gemspec out of {gem.name}:\n{tail(spec.stdout)}"]
    document = next(line for line in reversed(spec.stdout.splitlines()) if line.startswith("{"))
    problems += gem_spec_problems(gem.name, json.loads(document))

    with tarfile.open(gem) as outer:
        member = outer.extractfile("data.tar.gz")
        data = member.read() if member else b""
    with tempfile.TemporaryDirectory(prefix="gem-") as scratch:
        data_path = Path(scratch) / "data.tar.gz"
        data_path.write_bytes(data)
        problems += content_problems(gem.name, read_tarball(data_path, strip_top_level=False), GEM_LARGE_FILES)

        home = Path(scratch) / "gems"
        installed = runner(["gem", "install", "--no-document", "--install-dir", str(home), str(gem)], Path(scratch))
        if installed.returncode != 0:
            return problems + [f"{gem.name} does not install:\n{tail(installed.stdout)}"]
        smoke = runner(["ruby", "-e", GEM_SMOKE], Path(scratch), {"GEM_HOME": str(home), "GEM_PATH": str(home)})
        if smoke.returncode != 0:
            problems.append(f"{gem.name} installs but does not work:\n{tail(smoke.stdout)}")
    return problems


# ---------------------------------------------------------------- Maven Central


KOTLIN_DIR = "packages/kotlin"
MAVEN_GROUP, MAVEN_ARTIFACT = "me.koeda", "chordsketch"
MAVEN_CENTRAL = "https://repo1.maven.org/maven2"
MAVEN_DEPENDENCY_MAX = 50 * MIB
# JNA loads bundled libraries from `<os>-<arch>/` on the classpath
# (https://java-native-access.github.io/jna/5.17.0/javadoc/com/sun/jna/NativeLibrary.html).
JAR_NATIVE_LIBRARIES = (
    "linux-x86-64/libchordsketch_ffi.so",
    "linux-aarch64/libchordsketch_ffi.so",
    "darwin-aarch64/libchordsketch_ffi.dylib",
    "darwin-x86-64/libchordsketch_ffi.dylib",
    "win32-x86-64/chordsketch_ffi.dll",
)
JAR_LARGE_FILES = JAR_NATIVE_LIBRARIES
# https://central.sonatype.org/publish/requirements/
REQUIRED_POM_ELEMENTS = (
    "name",
    "description",
    "url",
    "licenses/license/name",
    "developers/developer/name",
    "scm/url",
    "scm/connection",
    "scm/developerConnection",
)
JAVA_SMOKE = """
public class Smoke {
    public static void main(String[] args) throws Exception {
        String version = uniffi.chordsketch.ChordsketchKt.version();
        if (version.isEmpty()) throw new AssertionError("version() is empty");
        String text = uniffi.chordsketch.ChordsketchKt.parseAndRenderText("{title: Smoke}\\n[C]Hello", null, null);
        if (!text.contains("Smoke")) throw new AssertionError("render lost the title: " + text);
    }
}
"""


def pom_problems(label: str, pom: bytes) -> list[str]:
    root = ElementTree.fromstring(pom)
    namespace = {"m": "http://maven.apache.org/POM/4.0.0"}

    def text(path: str) -> str:
        node = root.find("/".join(f"m:{part}" for part in path.split("/")), namespace)
        return (node.text or "").strip() if node is not None else ""

    problems = [f"{label} has no <{path}>" for path in REQUIRED_POM_ELEMENTS if not text(path)]
    for key in ("groupId", "artifactId", "version"):
        if not text(key):
            problems.append(f"{label} has no <{key}>")
    if text("version").endswith("-SNAPSHOT"):
        problems.append(f"{label} is a SNAPSHOT, which Maven Central refuses")
    return problems


def pom_runtime_dependencies(pom: bytes) -> list[tuple[str, str, str]]:
    namespace = {"m": "http://maven.apache.org/POM/4.0.0"}
    found = []
    for dependency in ElementTree.fromstring(pom).findall("m:dependencies/m:dependency", namespace):
        scope = dependency.findtext("m:scope", "compile", namespace)
        if scope in ("compile", "runtime"):
            found.append(tuple(dependency.findtext(f"m:{key}", "", namespace) for key in ("groupId", "artifactId", "version")))
    return found  # type: ignore[return-value]


def maven_repository_problems(repository: Path, version: str, runner: Runner = run) -> list[str]:
    """Check what `publishToMavenLocal` wrote, the artifact set the Central Portal receives."""
    directory = repository / MAVEN_GROUP.replace(".", "/") / MAVEN_ARTIFACT / version
    base = f"{MAVEN_ARTIFACT}-{version}"
    # Every non-pom artifact needs sources and javadoc jars, and every file a
    # signature (https://central.sonatype.org/publish/requirements/).
    required = [f"{base}.pom", f"{base}.jar", f"{base}-sources.jar", f"{base}-javadoc.jar"]
    problems = []
    for name in required:
        if not (directory / name).is_file():
            problems.append(f"the Maven publication has no {name}")
        elif not (directory / f"{name}.asc").is_file():
            problems.append(f"the Maven publication has no signature {name}.asc")
    if problems:
        return problems

    pom = (directory / f"{base}.pom").read_bytes()
    problems += pom_problems(f"{base}.pom", pom)
    jar = read_zip(directory / f"{base}.jar")
    paths = {f.path for f in jar}
    for library in JAR_NATIVE_LIBRARIES:
        if library not in paths:
            problems.append(f"{base}.jar has no `{library}`, where JNA looks for the native library on that platform")
    problems += content_problems(f"{base}.jar", jar, JAR_LARGE_FILES)

    with tempfile.TemporaryDirectory(prefix="maven-smoke-") as scratch:
        classpath = [str(directory / f"{base}.jar")]
        for group, artifact, dependency_version in pom_runtime_dependencies(pom):
            target = Path(scratch) / f"{artifact}-{dependency_version}.jar"
            url = f"{MAVEN_CENTRAL}/{group.replace('.', '/')}/{artifact}/{dependency_version}/{artifact}-{dependency_version}.jar"
            try:
                with urllib.request.urlopen(url, timeout=60) as response:
                    # A runtime dependency jar is a few hundred KiB; cap the
                    # read well above that instead of buffering an
                    # unbounded response in memory.
                    data = response.read(MAVEN_DEPENDENCY_MAX + 1)
                    if len(data) > MAVEN_DEPENDENCY_MAX:
                        return problems + [f"{group}:{artifact}:{dependency_version} is over {MAVEN_DEPENDENCY_MAX // MIB} MiB, more than a runtime dependency should be"]
                    target.write_bytes(data)
            except OSError as exc:
                return problems + [f"{base}.pom depends on {group}:{artifact}:{dependency_version}, which Maven Central does not serve ({exc})"]
            classpath.append(str(target))
        source = Path(scratch) / "Smoke.java"
        source.write_text(JAVA_SMOKE)
        smoke = runner(["java", "-cp", os.pathsep.join(classpath), str(source)], Path(scratch))
        if smoke.returncode != 0:
            problems.append(f"{base}.jar does not work from a clean classpath:\n{tail(smoke.stdout)}")
    return problems


def maven_problems(directory: Path, runner: Runner = run) -> list[str]:
    """Publish the Kotlin library to a scratch Maven repository and check it."""
    version = cargo_package_version(REPO_ROOT / "crates/ffi/Cargo.toml")
    with tempfile.TemporaryDirectory(prefix="maven-repo-") as scratch:
        published = runner(
            ["./gradlew", "publishToMavenLocal", "--no-configuration-cache", f"-Dmaven.repo.local={scratch}"],
            directory,
        )
        if published.returncode != 0:
            return [f"`gradlew publishToMavenLocal` failed:\n{tail(published.stdout, 40)}"]
        return maven_repository_problems(Path(scratch), version, runner)


def cargo_package_version(manifest: Path) -> str:
    return tomllib.loads(manifest.read_text())["package"]["version"]


# ---------------------------------------------------------------- GHCR / Docker Hub


CONTAINER_IMAGE = "ghcr.io/koedame/chordsketch"
# The tag grammar of the distribution reference
# (https://github.com/distribution/reference/blob/main/reference.go).
IMAGE_TAG = re.compile(r"^[\w][\w.-]{0,127}$")


def container_tag_problems(release_tag: str, tags: list[str]) -> list[str]:
    """The tags docker.yml pushes to GHCR, which its Docker Hub job copies by name.

    The copy step reads `<image>:X.Y.Z`, `<image>:X.Y` and, for the newest
    release, `<image>:latest`; a tag that is not pushed is a copy that
    fails after the GHCR half of the release is out.
    """
    version = release_tag.removeprefix("v")
    expected = {f"{CONTAINER_IMAGE}:{version}", f"{CONTAINER_IMAGE}:{'.'.join(version.split('.')[:2])}", f"{CONTAINER_IMAGE}:latest"}
    problems = []
    for reference in tags:
        name, _, tag = reference.rpartition(":")
        if name != name.lower():
            problems.append(f"image name `{name}` must be lowercase")
        if not IMAGE_TAG.match(tag):
            problems.append(f"`{tag}` is not a valid image tag")
    if missing := sorted(expected - set(tags)):
        problems.append(f"the image would not be tagged {', '.join(missing)}, which the Docker Hub copy reads")
    return problems


def container_image_problems(image: str, version: str, runner: Runner = run) -> list[str]:
    """Run the built image the way the README tells users to, and inspect its config."""
    problems = []
    ran = runner(["docker", "run", "--rm", image, "--version"], REPO_ROOT)
    if ran.returncode != 0:
        problems.append(f"the image does not run:\n{tail(ran.stdout)}")
    elif version not in ran.stdout:
        problems.append(f"the image's `--version` does not report {version}: {ran.stdout.strip()}")
    inspected = runner(["docker", "image", "inspect", "--format", "{{json .Config}}", image], REPO_ROOT)
    if inspected.returncode != 0:
        return problems + [f"could not inspect the image:\n{tail(inspected.stdout)}"]
    config = json.loads(next(line for line in reversed(inspected.stdout.splitlines()) if line.startswith("{")))
    if config.get("User") in (None, "", "0", "root"):
        problems.append("the image runs as root")
    if not config.get("Entrypoint"):
        problems.append("the image has no entrypoint")
    return problems


# ---------------------------------------------------------------- package managers
#
# Homebrew, Scoop, Chocolatey, AUR, Snap, CocoaPods and the Swift
# package are published by filling a template with the release's version and
# checksums. The checks below run the release's own generating step — lifted
# out of the workflow, so there is no second copy to drift — against a
# fabricated `checksums.txt`, then lint what it wrote with the channel's tool.


RELEASE_REPOSITORY_URL = "https://github.com/koedame/chordsketch/releases/download/"
DESKTOP_DMG_ARCHES = ("aarch64", "x64")


def release_targets() -> list[str]:
    """The targets release.yml's `build` job archives, read from its matrix."""
    text = (REPO_ROOT / ".github/workflows/release.yml").read_text()
    build = text[text.index("\n  build:\n") : text.index("\n  release:\n")]
    return re.findall(r"^\s+- target: (\S+)$", build, flags=re.MULTILINE)


def release_assets(version: str) -> set[str]:
    """Every download URL a release publishes that a package manager may point at."""
    tag = f"v{version}"
    cli = {
        f"{RELEASE_REPOSITORY_URL}{tag}/chordsketch-{tag}-{target}.{'zip' if 'windows' in target else 'tar.gz'}"
        for target in release_targets()
    }
    swift = {f"{RELEASE_REPOSITORY_URL}{tag}/chordsketch-xcframework.zip"}
    desktop = {f"{RELEASE_REPOSITORY_URL}desktop-v{version}/ChordSketch_{version}_{arch}.dmg" for arch in DESKTOP_DMG_ARCHES}
    return cli | swift | desktop | {f"{RELEASE_REPOSITORY_URL}{tag}/checksums.txt"}


def fake_sha256(name: str) -> str:
    return hashlib.sha256(name.encode()).hexdigest()


def fabricated_release(directory: Path, version: str) -> None:
    """Lay out what a release job has downloaded before it generates a manifest.

    `checksums.txt` and `SHA256SUMS` list every asset the release publishes,
    each with a distinct checksum, and `packaging/` is the repository's.
    """
    names = sorted(url.rsplit("/", 1)[1] for url in release_assets(version) if not url.endswith(".txt"))
    (directory / "checksums.txt").write_text("".join(f"{fake_sha256(n)}  {n}\n" for n in names if n.startswith("chordsketch-v")))
    (directory / "SHA256SUMS").write_text("".join(f"{fake_sha256(n)}  {n}\n" for n in names if n.endswith(".dmg")))
    if not (directory / "packaging").exists():
        (directory / "packaging").symlink_to(REPO_ROOT / "packaging")


def run_release_step(workflow: str, job: str, step: str, directory: Path, env: dict[str, str], runner: Runner = run, shell: str = "bash") -> subprocess.CompletedProcess[str]:
    """Run one `run:` step of a release workflow, the way the runner does.

    `shell` is the step's `shell:` — `bash` (the runner's `bash -eo pipefail`)
    or `pwsh`.
    """
    body = extract_job_step_run((REPO_ROOT / ".github/workflows" / workflow).read_text(), job, step)
    if shell == "pwsh":
        script = directory / f"{job}.ps1"
        script.write_text(body + "\n")
        return runner(["pwsh", "-NoLogo", "-NoProfile", "-NonInteractive", "-File", str(script)], directory, env)
    script = directory / f"{job}.sh"
    script.write_text(body + "\n")
    return runner(["bash", "--noprofile", "--norc", "-eo", "pipefail", str(script)], directory, env)


def download_url_problems(label: str, text: str, version: str) -> list[str]:
    """Every release download URL in a generated manifest must be an asset the release publishes."""
    expanded = text.replace("#{version}", version).replace("$version", version)
    urls = set(re.findall(r"https://github\.com/koedame/chordsketch/releases/download/[^\s\"'()<>]+", expanded))
    if not urls:
        return [f"{label} points at no release download"]
    # Scoop's `autoupdate.hash.url` legitimately reads checksums.txt.
    unknown = sorted(url for url in urls if url not in release_assets(version))
    return [f"{label} downloads {url}, which the release does not publish" for url in unknown]


def checksum_problems(label: str, text: str, version: str) -> list[str]:
    """Every downloaded asset must be paired with that asset's checksum.

    The fabricated release gives every asset a distinct checksum, so a
    template that pairs a URL with another target's checksum — or leaves a
    placeholder unfilled — shows up as a mismatch. A URL is paired with the
    closest checksum within three lines of it, which covers every layout the
    templates use (a checksum on the line before or after the URL).
    """
    problems = []
    if "{{" in text:
        problems.append(f"{label} still has an unfilled `{{{{...}}}}` placeholder")
    lines = text.replace("#{version}", version).replace("$version", version).splitlines()
    for number, line in enumerate(lines):
        for url in re.findall(r"https://github\.com/koedame/chordsketch/releases/download/[^\s\"'()<>]+", line):
            name = url.rsplit("/", 1)[1]
            if name == "checksums.txt":
                continue
            nearby = sorted(
                (abs(other - number), sha)
                for other in range(max(0, number - 3), min(len(lines), number + 4))
                for sha in re.findall(r"\b[0-9a-fA-F]{64}\b", lines[other])
            )
            if not nearby:
                problems.append(f"{label} has no checksum next to {name}")
            elif nearby[0][1].lower() != fake_sha256(name):
                problems.append(f"{label} pairs {name} with a checksum that is not that asset's")
    return problems


def generated(workflow: str, job: str, step: str, outputs: tuple[str, ...], version: str, runner: Runner = run, extra_env: dict[str, str] | None = None, prepare: Callable[[Path], None] | None = None) -> tuple[dict[str, str], list[str], Path]:
    """Run a generating step in a fabricated release directory and read what it wrote.

    `prepare` adds what the job downloads besides the release's checksums.
    """
    directory = Path(tempfile.mkdtemp(prefix=f"{job}-"))
    fabricated_release(directory, version)
    if prepare:
        prepare(directory)
    done = run_release_step(workflow, job, step, directory, {"VERSION": version, **(extra_env or {})}, runner)
    if done.returncode != 0:
        return {}, [f"{workflow} `{job}` / `{step}` failed:\n{tail(done.stdout)}"], directory
    missing = [name for name in outputs if not (directory / name).is_file()]
    if missing:
        return {}, [f"{workflow} `{job}` / `{step}` did not write {', '.join(missing)}"], directory
    return {name: (directory / name).read_text() for name in outputs}, [], directory


def expand_shell_variables(text: str, values: dict[str, str]) -> str:
    for name, value in values.items():
        text = text.replace(f"${{{name}}}", value).replace(f"${name}", value)
    return text


def homebrew_problems(version: str, runner: Runner = run) -> list[str]:
    """The CLI formula and the desktop cask, as their release jobs generate them.

    Both are audited and style-checked from a scratch tap, since `brew style`
    outside a tap applies Homebrew's own repository rules rather than a tap's.
    """
    formula, problems, formula_dir = generated("post-release.yml", "update-homebrew", "Generate formula", ("chordsketch.rb",), version, runner)
    cask, cask_problems, cask_dir = generated("desktop-release.yml", "update-cask", "Generate cask", ("chordsketch.rb",), version, runner)
    try:
        problems += cask_problems
        repository = runner(["brew", "--repository"], REPO_ROOT)
        if repository.returncode != 0:
            return problems + [f"`brew` is not available:\n{tail(repository.stdout)}"]
        tap = Path(repository.stdout.strip().splitlines()[-1]) / "Library/Taps/publish-check/homebrew-local"
        env = {"HOMEBREW_NO_AUTO_UPDATE": "1"}
        # https://docs.brew.sh/Formula-Cookbook and https://docs.brew.sh/Cask-Cookbook
        for kind, label, generated_files, required, folder in (
            ("formula", "Homebrew formula", formula, ("desc", "homepage", "license"), "Formula"),
            ("cask", "Homebrew cask", cask, ("name", "desc", "homepage"), "Casks"),
        ):
            if not generated_files:
                continue
            text = generated_files["chordsketch.rb"]
            problems += download_url_problems(label, text, version) + checksum_problems(label, text, version)
            problems += [f"{label} has no `{field}`" for field in required if not re.search(rf"^\s+{field} \"", text, flags=re.MULTILINE)]
            (tap / folder).mkdir(parents=True, exist_ok=True)
            (tap / folder / "chordsketch.rb").write_text(text)
            for command in (["brew", "audit", "--strict", f"--{kind}"], ["brew", "style", f"--{kind}"]):
                checked = runner([*command, "publish-check/local/chordsketch"], REPO_ROOT, env)
                if checked.returncode != 0:
                    problems.append(f"`{' '.join(command)}` refuses the {kind}:\n{tail(checked.stdout)}")
        return problems
    finally:
        shutil.rmtree(formula_dir, ignore_errors=True)
        shutil.rmtree(cask_dir, ignore_errors=True)


# https://github.com/ScoopInstaller/Scoop/wiki/App-Manifests
REQUIRED_SCOOP_FIELDS = ("version", "description", "homepage", "license")


def scoop_problems(version: str, runner: Runner = run) -> list[str]:
    outputs, problems, directory = generated("post-release.yml", "update-scoop", "Generate manifest", ("chordsketch.json",), version, runner)
    try:
        if not outputs:
            return problems
        try:
            manifest = json.loads(outputs["chordsketch.json"])
        except ValueError as exc:
            return [f"the Scoop manifest is not valid JSON: {exc}"]
        problems += [f"the Scoop manifest has no `{field}`" for field in REQUIRED_SCOOP_FIELDS if not manifest.get(field)]
        if manifest.get("version") != version:
            problems.append(f"the Scoop manifest's version is {manifest.get('version')!r}, not {version}")
        for arch, entry in (manifest.get("architecture") or {}).items():
            label = f"Scoop manifest ({arch})"
            pinned = json.dumps({"url": entry.get("url"), "hash": entry.get("hash")}, indent=1)
            problems += download_url_problems(label, pinned, version) + checksum_problems(label, pinned, version)
        autoupdate = json.dumps((manifest.get("autoupdate") or {}))
        problems += download_url_problems("Scoop manifest (autoupdate)", autoupdate, version)
        if not manifest.get("bin"):
            problems.append("the Scoop manifest has no `bin`, so nothing is put on PATH")
        return problems
    finally:
        shutil.rmtree(directory, ignore_errors=True)


# https://wiki.archlinux.org/title/PKGBUILD
AUR_PKGNAME = re.compile(r"^[a-z0-9@._+][a-z0-9@._+-]*$")
AUR_PKGVER = re.compile(r"^[A-Za-z0-9._]+$")
# The package bases `update-aur` pushes: the tagged source, and the release's
# prebuilt archive under the `-bin` name the AUR submission guidelines ask
# for when a source build exists (ADR-0071).
AUR_SOURCE_PACKAGE = "chordsketch"
AUR_BINARY_PACKAGE = "chordsketch-bin"
AUR_PACKAGES = (AUR_SOURCE_PACKAGE, AUR_BINARY_PACKAGE)


def aur_source_url(version: str) -> str:
    return f"https://github.com/koedame/chordsketch/archive/refs/tags/v{version}.tar.gz"


def aur_naming_problems(pkg: str, pkgbuild: str) -> list[str]:
    """A PKGBUILD without `build()` repackages a prebuilt binary, which the AUR wants named `-bin`."""
    builds = re.search(r"^build\(\)", pkgbuild, flags=re.MULTILINE) is not None
    if builds and pkg.endswith("-bin"):
        return [f"{pkg}/PKGBUILD builds from source, but its name ends in -bin"]
    if not builds and not pkg.endswith("-bin"):
        return [f"{pkg}/PKGBUILD repackages a prebuilt binary, which the AUR wants under a -bin name"]
    return []


def aur_problems(version: str, runner: Runner = run) -> list[str]:
    """Both AUR packages as the release generates them, and the source package built with makepkg.

    The tag archive the source package downloads does not exist before the
    release, so `git archive` of this checkout stands in for it, under the
    name and top directory GitHub gives it.
    """
    archive = f"chordsketch-{version}.tar.gz"

    def source_archive(directory: Path) -> None:
        runner(["git", "archive", f"--prefix=chordsketch-{version}/", "-o", str(directory / archive), "HEAD"], REPO_ROOT)

    files = tuple(f"aur/{pkg}/{name}" for pkg in AUR_PACKAGES for name in ("PKGBUILD", ".SRCINFO"))
    outputs, problems, directory = generated("post-release.yml", "update-aur", "Generate PKGBUILD and .SRCINFO", files, version, runner, prepare=source_archive)
    try:
        if not outputs:
            return problems
        for pkg in AUR_PACKAGES:
            pkgbuild = outputs[f"aur/{pkg}/PKGBUILD"]
            fields = dict(re.findall(r"^(pkgname|pkgver|pkgrel)=(\S+)$", pkgbuild, flags=re.MULTILINE))
            pkgname = fields.get("pkgname", "")
            if pkgname != pkg:
                problems.append(f"{pkg}/PKGBUILD names the package {pkgname!r}, but the release pushes it to the {pkg} package base")
            if not AUR_PKGNAME.match(pkgname) or pkgname.startswith(("-", ".")):
                problems.append(f"{pkg}/PKGBUILD pkgname {pkgname!r} breaks the AUR naming rules")
            if not AUR_PKGVER.match(fields.get("pkgver", "")):
                problems.append(f"{pkg}/PKGBUILD pkgver {fields.get('pkgver')!r} is not a valid pkgver")
            if f"pkgbase = {pkg}" not in outputs[f"aur/{pkg}/.SRCINFO"]:
                problems.append(f"{pkg}/.SRCINFO does not describe the {pkg} package base")
            expanded = expand_shell_variables(pkgbuild, {"pkgver": version, "pkgname": pkgname, "CARCH": "x86_64"})
            problems += aur_naming_problems(pkg, pkgbuild)
            if pkg == AUR_BINARY_PACKAGE:
                problems += download_url_problems(f"{pkg}/PKGBUILD", expanded, version) + checksum_problems(f"{pkg}/PKGBUILD", expanded, version)
            else:
                if f'"{archive}::{aur_source_url(version)}"' not in expanded:
                    problems.append(f"{pkg}/PKGBUILD does not download the tag archive as {archive}::{aur_source_url(version)}")
                if hashlib.sha256((directory / archive).read_bytes()).hexdigest() not in expanded:
                    problems.append(f"{pkg}/PKGBUILD does not carry the tag archive's checksum")
                if "/releases/download/" in expanded:
                    problems.append(f"{pkg}/PKGBUILD downloads a release asset, but builds from source")

        # makepkg refuses root; `-s` installs what the PKGBUILD declares, so
        # an undeclared build dependency fails here. namcap reads both
        # PKGBUILDs and the built package, which is where it finds the
        # shared libraries missing from `depends`.
        script = (
            "set -euo pipefail; pacman -Sy --noconfirm --needed namcap >/dev/null; "
            "useradd -m builder; echo 'builder ALL=(ALL) NOPASSWD: ALL' > /etc/sudoers.d/builder; "
            f"cp -r /work/aur/{AUR_SOURCE_PACKAGE} /work/aur/{AUR_BINARY_PACKAGE} /home/builder/; "
            f"cp /work/{archive} /home/builder/{AUR_SOURCE_PACKAGE}/; chown -R builder /home/builder; "
            f"for pkg in {' '.join(AUR_PACKAGES)}; do namcap /home/builder/$pkg/PKGBUILD >> /work/namcap.txt; done; "
            f"su builder -c 'cd /home/builder/{AUR_SOURCE_PACKAGE} && makepkg -s --noconfirm'; "
            f"namcap /home/builder/{AUR_SOURCE_PACKAGE}/*.pkg.tar.zst >> /work/namcap.txt"
        )
        container = runner(["docker", "run", "--rm", "-v", f"{directory}:/work", "archlinux:base-devel", "bash", "-c", script], directory)
        if container.returncode != 0:
            return problems + [f"makepkg / namcap failed on the {AUR_SOURCE_PACKAGE} PKGBUILD:\n{tail(container.stdout)}"]
        namcap = (directory / "namcap.txt").read_text().strip()
        if namcap:
            problems += [f"namcap: {line}" for line in namcap.splitlines()]
        return problems
    finally:
        shutil.rmtree(directory, ignore_errors=True)


# https://snapcraft.io/docs/snapcraft-top-level-metadata
SNAP_NAME = re.compile(r"^(?=.*[a-z])[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,39}$")


def snap_problems(version: str, binary: Path, runner: Runner = run) -> list[str]:
    """Generate snapcraft.yaml as the release does and pack it with `binary` staged."""
    outputs, problems, directory = generated("post-release.yml", "update-snap", "Generate snapcraft.yaml", ("snap/snapcraft.yaml",), version, runner)
    try:
        if not outputs:
            return problems
        text = outputs["snap/snapcraft.yaml"]
        top = dict(re.findall(r"^([a-z-]+):[ \t]*(.*)$", text, flags=re.MULTILINE))
        if not SNAP_NAME.match(top.get("name", "")):
            problems.append(f"snap name {top.get('name')!r} breaks the Snap Store's naming rules")
        if len(top.get("summary", "")) > 78:
            problems.append("the snap summary is over 78 characters")
        for key in ("version", "summary", "description", "license", "base", "confinement", "grade"):
            if key not in top:
                problems.append(f"snapcraft.yaml has no `{key}`")
        if top.get("version", "").strip("'\"") != version:
            problems.append(f"snapcraft.yaml version is {top.get('version')!r}, not {version}")
        stage = directory / "stage"
        stage.mkdir()
        shutil.copyfile(binary, stage / "chordsketch")
        (stage / "chordsketch").chmod(0o755)
        # The release job's own build command.
        packed = runner(["snapcraft", "--destructive-mode"], directory)
        if packed.returncode != 0:
            return problems + [f"`snapcraft --destructive-mode` failed:\n{tail(packed.stdout, 30)}"]
        if not list(directory.glob("chordsketch_*.snap")):
            problems.append("`snapcraft --destructive-mode` wrote no chordsketch_*.snap")
        return problems
    finally:
        shutil.rmtree(directory, ignore_errors=True)


# https://guides.cocoapods.org/syntax/podspec.html
REQUIRED_PODSPEC_ATTRIBUTES = ("name", "version", "summary", "license", "homepage", "authors", "source")


def cocoapods_problems(version: str, runner: Runner = run) -> list[str]:
    """The podspec is the tag's own source plus the XCFramework the release uploads.

    A pod built from the XCFramework zip alone has no Swift API: the bindings
    are a source file, so the podspec has to name the tag that holds them, and
    fetch the binary that was pinned with them.
    """
    checksum = fake_sha256("chordsketch-xcframework.zip")
    outputs, problems, directory = generated("swift.yml", "update-cocoapods", "Generate podspec", ("ChordSketch.podspec",), version, runner, extra_env={"SHA256": checksum})
    try:
        if not outputs:
            return problems
        spec_json = runner(["pod", "ipc", "spec", "ChordSketch.podspec"], directory)
        if spec_json.returncode != 0:
            return problems + [f"`pod ipc spec` cannot read the podspec:\n{tail(spec_json.stdout)}"]
        spec = json.loads(spec_json.stdout[spec_json.stdout.find("{") :])
        problems += [f"the podspec has no `{key}`" for key in REQUIRED_PODSPEC_ATTRIBUTES if not spec.get(key)]
        if len(spec.get("summary", "")) > 140:
            problems.append("the podspec summary is over 140 characters")
        if spec.get("version") != version:
            problems.append(f"the podspec version is {spec.get('version')!r}, not {version}")
        source = spec.get("source") or {}
        if source.get("git") != "https://github.com/koedame/chordsketch.git" or source.get("tag") != f"v{version}":
            problems.append(f"the podspec source is {source!r}, not the git tag v{version}: the Swift bindings are a source file the tag holds")
        prepare = spec.get("prepare_command", "")
        problems += download_url_problems("podspec prepare_command", prepare, version)
        if checksum not in prepare:
            problems.append("the podspec's prepare_command does not verify the XCFramework against the checksum Package.swift pins")
        source_files = spec.get("source_files") or ""
        if not source_files or not any(REPO_ROOT.glob(source_files)):
            problems.append(f"the podspec's source_files {source_files!r} match nothing in the repository: the pod would have no Swift API")
        license_entry = spec.get("license") or {}
        if isinstance(license_entry, dict) and license_entry.get("file") and not (REPO_ROOT / license_entry["file"]).is_file():
            problems.append(f"the podspec names license file `{license_entry['file']}`, which the tag does not contain")
        return problems
    finally:
        shutil.rmtree(directory, ignore_errors=True)


def swift_package_problems(version: str, runner: Runner = run) -> list[str]:
    """The `Package.swift` a consumer resolves from the tag names this release's XCFramework.

    SwiftPM reads the manifest from the tag's own checkout, so the release
    commit has to carry the URL and checksum already: `swift.yml`'s `pin` job
    commits them onto the release branch (ADR-0080).
    """
    manifest_path = REPO_ROOT / "Package.swift"
    if not manifest_path.is_file():
        return ["Package.swift is missing from the repository root: SwiftPM reads the manifest from the root of the tag"]
    text = manifest_path.read_text()
    try:
        url, checksum = swift_package.read_pin(text)
    except swift_package.SwiftPackageError as exc:
        return [str(exc)]
    problems = []
    expected = swift_package.asset_url(f"v{version}")
    if url != expected:
        problems.append(
            f"Package.swift pins {url}, not {expected}: run `gh workflow run swift.yml --ref <release branch> -f pin={version}` (docs/releasing.md step 3)"
        )
    if not re.fullmatch(r"[0-9a-f]{64}", checksum):
        problems.append(f"Package.swift pins the checksum {checksum!r}, which is not a SHA-256")
    if not (REPO_ROOT / "packages/swift/Sources/ChordSketch/chordsketch.swift").is_file():
        problems.append("packages/swift/Sources/ChordSketch/chordsketch.swift is missing: the package would have no bindings")
    directory = Path(tempfile.mkdtemp(prefix="swift-package-"))
    try:
        (directory / "Package.swift").write_text(text)
        dumped = runner(["swift", "package", "dump-package"], directory)
        if dumped.returncode != 0:
            return problems + [f"`swift package dump-package` cannot read Package.swift:\n{tail(dumped.stdout)}"]
        manifest = json.loads(dumped.stdout[dumped.stdout.find("{") :])
        binaries = [t for t in manifest.get("targets", []) if t.get("type") == "binary"]
        if len(binaries) != 1 or binaries[0].get("checksum") != checksum:
            problems.append("Package.swift does not declare one binary target with the pinned checksum")
        return problems
    finally:
        shutil.rmtree(directory, ignore_errors=True)


# https://learn.microsoft.com/en-us/windows/package-manager/package/manifest
REQUIRED_WINGET_FIELDS = {
    "koedame.chordsketch.yaml": ("PackageIdentifier", "PackageVersion", "DefaultLocale", "ManifestType", "ManifestVersion"),
    "koedame.chordsketch.locale.en-US.yaml": ("PackageIdentifier", "PackageVersion", "PackageLocale", "Publisher", "PackageName", "License", "ShortDescription", "ManifestType", "ManifestVersion"),
    "koedame.chordsketch.installer.yaml": ("PackageIdentifier", "PackageVersion", "InstallerType", "Installers", "ManifestType", "ManifestVersion"),
}


def winget_problems(version: str) -> list[str]:
    """The winget manifests submitted by hand to microsoft/winget-pkgs."""
    problems = []
    directory = REPO_ROOT / "packaging/winget"
    for name, fields in REQUIRED_WINGET_FIELDS.items():
        text = (directory / name).read_text()
        present = set(re.findall(r"^([A-Za-z]+):", text, flags=re.MULTILINE))
        problems += [f"{name} has no `{field}`" for field in fields if field not in present]
        versions = re.findall(r"^PackageVersion:\s*(\S+)", text, flags=re.MULTILINE)
        if versions and versions[0] != version:
            problems.append(f"{name} is at PackageVersion {versions[0]}, not {version}")
        if name.endswith("installer.yaml"):
            for url in re.findall(r"InstallerUrl:\s*(\S+)", text):
                problems += download_url_problems(name, url, version)
            for sha in re.findall(r"InstallerSha256:\s*(\S+)", text):
                if not re.fullmatch(r"[0-9A-F]{64}", sha):
                    problems.append(f"{name} InstallerSha256 must be 64 uppercase hex digits")
    return problems


# https://docs.chocolatey.org/en-us/create/create-packages/ and the
# community repository's moderation requirements
# (https://docs.chocolatey.org/en-us/community-repository/moderation/).
REQUIRED_NUSPEC_FIELDS = ("id", "version", "title", "authors", "projectUrl", "packageSourceUrl", "description", "summary", "tags")
CHOCOLATEY_ID = re.compile(r"^[a-z0-9][a-z0-9.-]*$")


def chocolatey_problems(workspace: Path, version: str, runner: Runner = run) -> list[str]:
    """Pack `workspace/choco-pkg` with the release's Pack step and check the package.

    The generating step is the `chocolatey-generate-package` composite, which
    the workflow runs before this.
    """
    body = extract_step_run((REPO_ROOT / ".github/actions/chocolatey-pack-push/action.yml").read_text(), "Pack")
    script = workspace / "choco-pack.ps1"
    script.write_text(body + "\n")
    packed = runner(["pwsh", "-NoLogo", "-NoProfile", "-File", str(script)], workspace, {"VERSION": version})
    if packed.returncode != 0:
        return [f"the release's `choco pack` step failed:\n{tail(packed.stdout)}"]
    nupkg = workspace / "choco-pkg" / f"chordsketch.{version}.nupkg"
    files = read_zip(nupkg)
    nuspec = next((f for f in files if f.path.endswith(".nuspec")), None)
    install = next((f for f in files if f.path.lower().endswith("tools/chocolateyinstall.ps1")), None)
    problems = []
    if nuspec is None:
        return [f"{nupkg.name} has no .nuspec"]
    root = ElementTree.fromstring(nuspec.data)
    metadata = next((child for child in root if child.tag.endswith("metadata")), None)
    values = {child.tag.split("}")[-1]: (child.text or "").strip() for child in (metadata if metadata is not None else [])}
    problems += [f"the Chocolatey nuspec has no `{field}`" for field in REQUIRED_NUSPEC_FIELDS if not values.get(field)]
    if not CHOCOLATEY_ID.match(values.get("id", "")):
        problems.append(f"the Chocolatey id {values.get('id')!r} must be lowercase")
    if values.get("version") != version:
        problems.append(f"the Chocolatey package is version {values.get('version')!r}, not {version}")
    if not (values.get("licenseUrl") or values.get("license")):
        problems.append("the Chocolatey nuspec declares no license")
    if install is None:
        problems.append(f"{nupkg.name} has no tools/chocolateyInstall.ps1")
    else:
        text = install.data.decode("utf-8-sig")
        problems += download_url_problems("chocolateyInstall.ps1", text, version) + checksum_problems("chocolateyInstall.ps1", text, version)
    return problems + content_problems(nupkg.name, files, ())


# ---------------------------------------------------------------- GitHub Release archives


# What each consumer takes out of a CLI archive: the tarball's top directory
# is stripped by the VS Code and Snap steps, entered by AUR's
# `package()` and named by docker.yml.
CLI_ARCHIVE_FILES = ("chordsketch", "chordsketch-lsp", "LICENSE", "README.md")
CLI_ARCHIVE_LARGE_FILES = ("*/chordsketch", "*/chordsketch-lsp")


def cli_archive_problems(version: str, target: str, binaries: Path, runner: Runner = run) -> list[str]:
    """Package release.yml's archive for `target` from `binaries` and check its layout and checksum line.

    Windows targets go through the `Package (Windows)` step (`pwsh`,
    `Compress-Archive`), which puts the files at the zip's root; the others
    through `Package (Unix)`, which wraps them in a top directory.
    """
    windows = "windows" in target
    exe = ".exe" if windows else ""
    directory = Path(tempfile.mkdtemp(prefix="cli-archive-"))
    try:
        (directory / f"target/{target}/release").mkdir(parents=True)
        for name in ("chordsketch", "chordsketch-lsp"):
            shutil.copyfile(binaries / f"{name}{exe}", directory / f"target/{target}/release/{name}{exe}")
        for name in ("LICENSE", "README.md"):
            shutil.copyfile(REPO_ROOT / name, directory / name)
        tag = f"v{version}"
        github_env = directory / "github-env"
        github_env.touch()
        step = "Package (Windows)" if windows else "Package (Unix)"
        env = {"VERSION": tag, "TARGET": target, "GITHUB_ENV": str(github_env)}
        packaged = run_release_step("release.yml", "build", step, directory, env, runner, shell="pwsh" if windows else "bash")
        if packaged.returncode != 0:
            return [f"release.yml `{step}` failed:\n{tail(packaged.stdout)}"]
        archive = directory / f"chordsketch-{tag}-{target}.{'zip' if windows else 'tar.gz'}"
        if not archive.is_file():
            return [f"release.yml `{step}` did not write {archive.name}"]
        problems = []
        if f"{RELEASE_REPOSITORY_URL}{tag}/{archive.name}" not in release_assets(version):
            problems.append(f"{archive.name} is not an asset the package managers download")
        if windows:
            # Scoop's `bin`, Chocolatey's unzip and winget's
            # `RelativeFilePath` all expect the executables at the root.
            files = read_zip(archive)
            expected = {f"{name}.exe" if name.startswith("chordsketch") else name for name in CLI_ARCHIVE_FILES}
            large = tuple(f"{name}.exe" for name in ("chordsketch", "chordsketch-lsp"))
        else:
            files = read_tarball(archive, strip_top_level=False)
            expected = {f"chordsketch-{tag}-{target}/{name}" for name in CLI_ARCHIVE_FILES}
            large = CLI_ARCHIVE_LARGE_FILES
        present = {f.path for f in files}
        if missing := sorted(expected - present):
            problems.append(f"{archive.name} lacks {', '.join(missing)}")
        # Declared only where they are, so a wrong layout is reported once, as missing files.
        problems += content_problems(archive.name, files, tuple(glob for glob in large if any(fnmatch.fnmatch(path, glob) for path in present)))
        if windows:
            # The checksum step runs once, in the `release` job on Linux,
            # over every archive; the Linux archive check exercises it.
            return problems

        # The `release` job's checksum step, over the artifact layout
        # `download-artifact` gives it (one directory per target).
        artifacts = directory / "release" / "artifacts" / target
        artifacts.mkdir(parents=True)
        shutil.copyfile(archive, artifacts / archive.name)
        summed = run_release_step("release.yml", "release", "Generate checksums", directory / "release", {}, runner)
        if summed.returncode != 0:
            return problems + [f"release.yml `Generate checksums` failed:\n{tail(summed.stdout)}"]
        lines = (directory / "release/checksums.txt").read_text().splitlines()
        wanted = f"{hashlib.sha256(archive.read_bytes()).hexdigest()}  {archive.name}"
        if lines != [wanted]:
            problems.append(f"checksums.txt reads {lines}, not the `<sha256>  <asset name>` line the package managers look up")
        return problems
    finally:
        shutil.rmtree(directory, ignore_errors=True)


# ---------------------------------------------------------------- desktop updater


DESKTOP_UPDATER_PLATFORMS = {
    "darwin-aarch64": "aarch64.app.tar.gz",
    "darwin-x86_64": "x64.app.tar.gz",
    "linux-x86_64": "amd64.AppImage",
    "windows-x86_64": "x64-setup.exe",
}
DESKTOP_UPDATER_ENDPOINT = "https://raw.githubusercontent.com/koedame/chordsketch/desktop-updater-manifest/latest.json"


def desktop_updater_problems(version: str, runner: Runner = run) -> list[str]:
    """Build latest.json with desktop-release.yml's step and check what the Tauri updater reads."""
    directory = Path(tempfile.mkdtemp(prefix="desktop-updater-"))
    try:
        sigs = directory / "sigs"
        sigs.mkdir()
        signature = "untrusted comment: signature from tauri secret key\nRUQ=\ntrusted comment: timestamp:0\tfile:x\nZmFrZQ==\n"
        for suffix in DESKTOP_UPDATER_PLATFORMS.values():
            (sigs / f"ChordSketch_{version}_{suffix}.sig").write_text(signature)
        shim = directory / "bin"
        shim.mkdir()
        # The step reads the release notes with `gh release view`; nothing else.
        (shim / "gh").write_text("#!/bin/sh\necho 'Release notes'\n")
        (shim / "gh").chmod(0o755)
        tag = f"desktop-v{version}"
        env = {"VERSION": version, "TAG": tag, "REPO": "koedame/chordsketch", "PATH": f"{shim}{os.pathsep}{os.environ['PATH']}"}
        built = run_release_step("desktop-release.yml", "publish-updater-manifest", "Build latest.json", directory, env, runner)
        if built.returncode != 0:
            return [f"desktop-release.yml `Build latest.json` failed:\n{tail(built.stdout)}"]
        manifest = json.loads((sigs / "latest.json").read_text())
        problems = []
        if manifest.get("version") != version:
            problems.append(f"latest.json version is {manifest.get('version')!r}, not {version}")
        platforms = manifest.get("platforms") or {}
        if set(platforms) != set(DESKTOP_UPDATER_PLATFORMS):
            problems.append(f"latest.json covers {sorted(platforms)}, not {sorted(DESKTOP_UPDATER_PLATFORMS)}")
        for key, suffix in DESKTOP_UPDATER_PLATFORMS.items():
            entry = platforms.get(key) or {}
            expected_url = f"{RELEASE_REPOSITORY_URL}{tag}/ChordSketch_{version}_{suffix}"
            if entry.get("url") != expected_url:
                problems.append(f"latest.json {key} url is {entry.get('url')!r}, not {expected_url}")
            if entry.get("signature") != signature:
                problems.append(f"latest.json {key} signature is not the signature file's full minisign text")
        tauri = json.loads((REPO_ROOT / "apps/desktop/src-tauri/tauri.conf.json").read_text())
        endpoints = ((tauri.get("plugins") or {}).get("updater") or {}).get("endpoints") or []
        if DESKTOP_UPDATER_ENDPOINT not in endpoints:
            problems.append(f"tauri.conf.json's updater does not read {DESKTOP_UPDATER_ENDPOINT}, where the release publishes latest.json")
        return problems
    finally:
        shutil.rmtree(directory, ignore_errors=True)


# ---------------------------------------------------------------- Flathub


FLATPAK_APP_ID = "io.github.koedame.chordsketch"
# The image flatpak/flatpak-github-actions builds in: flatpak-builder,
# flatpak-builder-lint, Xvfb and the GNOME runtime the manifest names.
FLATPAK_IMAGE = "ghcr.io/flathub-infra/flatpak-github-actions:gnome-50"
# The desktop app writes this title once its startup has finished (the menu
# bar, the close prompt, then the title), and this one when startup failed.
FLATPAK_STARTED_TITLE = "Untitled — ChordSketch"
FLATPAK_FAILED_TITLE = "ChordSketch failed to start"


RUNTIME_UPDATE_WARNING = re.compile(r"^runtime-update-available-to-(?P<runtime>org\.gnome\.Platform)-(?P<version>[0-9.]+)$")


def flatpak_sdk_extensions(manifest: str) -> list[str]:
    """The `sdk-extensions` a Flatpak manifest lists."""
    block = re.search(r"^sdk-extensions:\n((?:[ \t]+-[^\n]*\n)+)", manifest, flags=re.MULTILINE)
    return re.findall(r"-\s*(\S+)", block.group(1)) if block else []


def flatpak_runtime_update_blockers(output: str) -> dict[str, list[str]]:
    """Read the probe that looks for every SDK extension on the newer runtime's branch.

    Each line is `<runtime version> <extension ref>`, for an extension Flathub
    does not serve on the branch that runtime's SDK extension point names.
    """
    blockers: dict[str, list[str]] = {}
    for line in output.splitlines():
        version, _, ref = line.strip().partition(" ")
        if ref:
            blockers.setdefault(version, []).append(ref)
    return blockers


def flatpak_lint_problems(kind: str, output: str, returncode: int, update_blockers: dict[str, list[str]] | None = None) -> list[str]:
    """Read `flatpak-builder-lint manifest|repo`, which prints a JSON report only when it finds something.

    `runtime-update-available-to-org.gnome.Platform-N` is not a problem while
    `update_blockers` names an SDK extension the manifest needs that Flathub does
    not serve for runtime N yet: the manifest cannot move to N until it does.
    It is reported, with what it waits for, in the check's output instead.

    https://docs.flathub.org/docs/for-app-authors/linter
    """
    document = output[output.find("{") :] if "{" in output else ""
    try:
        report = json.loads(document) if document else {}
    except ValueError:
        report = {}
    # `info` holds the explanation of a finding, as "<finding>: <detail>".
    details = {}
    for line in report.get("info", []):
        finding, _, detail = line.partition(": ")
        # A failed URL check carries the start of the response body; the status is what matters.
        details.setdefault(finding, []).append(detail if len(detail) <= 200 else detail[:200] + "…")

    def described(finding: str) -> str:
        return " — ".join([finding, *details.get(finding, [])])

    problems = [f"flatpak-builder-lint {kind} error: {described(e)}" for e in report.get("errors", [])]
    for warning in report.get("warnings", []):
        update = RUNTIME_UPDATE_WARNING.match(warning)
        waiting = (update_blockers or {}).get(update.group("version"), []) if update else []
        if waiting:
            print(f"note: flatpak-builder-lint {kind} warning {warning} is not counted: Flathub does not serve {', '.join(waiting)} yet", flush=True)
            continue
        problems.append(f"flatpak-builder-lint {kind} warning: {described(warning)}")
    if returncode != 0 and not problems:
        problems.append(f"flatpak-builder-lint {kind} failed:\n{tail(output)}")
    return problems


def flatpak_launch_problems(titles: list[str]) -> list[str]:
    if FLATPAK_FAILED_TITLE in titles:
        return [f"the Flatpak shows \"{FLATPAK_FAILED_TITLE}\" on launch"]
    if FLATPAK_STARTED_TITLE not in titles:
        return [f"the Flatpak did not reach the window title {FLATPAK_STARTED_TITLE!r} within 90 s; its windows: {titles}"]
    return []


def flathub_problems(version: str, runner: Runner = run) -> list[str]:
    """The Flathub files as desktop-release.yml generates them, linted, built without network, and launched.

    The generated manifest builds the release tag from GitHub, which does not
    exist yet, so it is only linted; the build uses the same manifest pointed at
    this checkout. The repository is mounted at its own path because the
    manifest names it by absolute path.
    """
    directory = Path(tempfile.mkdtemp(prefix="update-flathub-"))
    try:
        fabricated_release(directory, version)
        commit = runner(["git", "rev-parse", "HEAD"], REPO_ROOT).stdout.strip().splitlines()[-1]
        env = {"TAG": f"desktop-v{version}", "COMMIT": commit}
        generated_files = run_release_step("desktop-release.yml", "update-flathub", "Generate Flathub files", directory, env, runner)
        if generated_files.returncode != 0:
            return [f"desktop-release.yml `update-flathub` / `Generate Flathub files` failed:\n{tail(generated_files.stdout)}"]
        problems = []
        source = json.loads((directory / "flathub/chordsketch-source.json").read_text())
        if source != [{"type": "git", "url": "https://github.com/koedame/chordsketch.git", "tag": env["TAG"], "commit": commit}]:
            problems.append(f"the Flathub manifest does not build {env['TAG']} at {commit}: {source}")
        local = runner([sys.executable, str(REPO_ROOT / "packaging/flatpak/prepare.py"), "--out", str(directory / "local")], REPO_ROOT)
        if local.returncode != 0:
            return problems + [f"packaging/flatpak/prepare.py failed:\n{tail(local.stdout)}"]

        manifest = f"{FLATPAK_APP_ID}.yml"
        flatpak = f"{REPO_ROOT}/packaging/flatpak"
        extensions = " ".join(flatpak_sdk_extensions((REPO_ROOT / "packaging/flatpak" / manifest).read_text()))
        # The build runs in the container's own filesystem: the sandbox
        # flatpak-builder starts cannot read a bind-mounted directory owned by
        # the runner's user. Only reports are written back to /work.
        script = (
            "set -uo pipefail; mkdir -p /var/tmp/flatpak && cd /var/tmp/flatpak; "
            f"flatpak-builder-lint manifest /work/flathub/{manifest} > /work/lint-manifest.txt 2>&1; echo $? > /work/lint-manifest.status; "
            f"flatpak-builder-lint appstream {flatpak}/{FLATPAK_APP_ID}.metainfo.xml > /work/lint-appstream.txt 2>&1; echo $? > /work/lint-appstream.status; "
            f"desktop-file-validate {flatpak}/{FLATPAK_APP_ID}.desktop > /work/desktop-file.txt 2>&1; echo $? > /work/desktop-file.status; "
            # The screenshot mirror options are Flathub's (its `flathub-build`); the repo lint expects them.
            "flatpak-builder --install-deps-from=flathub --disable-rofiles-fuse --mirror-screenshots-url=https://dl.flathub.org/media --compose-url-policy=full "
            f"--repo=repo build /work/local/{manifest} > /work/build.txt 2>&1 || exit 10; "
            "flatpak-builder-lint repo repo > /work/lint-repo.txt 2>&1; echo $? > /work/lint-repo.status; "
            # For each newer GNOME runtime the lint points at, the SDK extensions Flathub does not serve on the
            # branch that runtime's `org.freedesktop.Sdk.Extension` extension point names.
            "for n in $(grep -ohE 'runtime-update-available-to-org\\.gnome\\.Platform-[0-9.]+' /work/lint-manifest.txt /work/lint-repo.txt | sed 's/.*-//' | sort -u); do "
            "b=$(flatpak remote-info -m flathub org.gnome.Sdk//$n | awk '/^\\[/ {s = ($0 == \"[Extension org.freedesktop.Sdk.Extension]\")} s && $1 == \"version\" {print $3}'); "
            f"[ -n \"$b\" ] && for e in {extensions}; do flatpak remote-info flathub $e//$b > /dev/null 2>&1 || echo \"$n $e//$b\"; done; "
            "done > /work/runtime-update-blockers.txt; "
            f"{{ flatpak remote-add --no-gpg-verify built /var/tmp/flatpak/repo && flatpak install -y --noninteractive built {FLATPAK_APP_ID}; }} > /work/install.txt 2>&1 || exit 11; "
            # Xvfb directly: `xvfb-run` waits for a SIGUSR1 that can get lost when it runs under the container's init.
            "Xvfb :99 -screen 0 1280x1024x24 -nolisten tcp > /work/xvfb.txt 2>&1 & "
            "for i in $(seq 30); do [ -S /tmp/.X11-unix/X99 ] && break; sleep 1; done; "
            "DISPLAY=:99 dbus-run-session -- sh -c '"
            f"flatpak run {FLATPAK_APP_ID} > /work/app.txt 2>&1 & app=$!; "
            f"for i in $(seq 90); do sleep 1; python3 {flatpak}/window-titles.py > /work/titles.txt; "
            f"grep -qx -e \"{FLATPAK_STARTED_TITLE}\" -e \"{FLATPAK_FAILED_TITLE}\" /work/titles.txt && break; done; kill $app 2>/dev/null; true'"
        )
        container = runner(["docker", "run", "--rm", "--privileged", "-v", f"{REPO_ROOT}:{REPO_ROOT}:ro", "-v", f"{directory}:/work", FLATPAK_IMAGE, "bash", "-c", script], directory)
        if container.returncode == 10:
            return problems + [f"flatpak-builder failed:\n{tail((directory / 'build.txt').read_text(), 40)}"]
        if container.returncode == 11:
            return problems + [f"installing the built Flatpak failed:\n{tail((directory / 'install.txt').read_text())}"]
        if container.returncode != 0:
            return problems + [f"the Flatpak build container failed:\n{tail(container.stdout)}"]

        def result(name: str) -> tuple[str, int]:
            return (directory / f"{name}.txt").read_text(), int((directory / f"{name}.status").read_text())

        blockers = flatpak_runtime_update_blockers((directory / "runtime-update-blockers.txt").read_text())
        problems += flatpak_lint_problems("manifest", *result("lint-manifest"), blockers)
        problems += flatpak_lint_problems("repo", *result("lint-repo"), blockers)
        # `appstreamcli validate` counts warnings as failures; so does its exit status.
        appstream, status = result("lint-appstream")
        if status != 0:
            problems.append(f"flatpak-builder-lint appstream failed:\n{tail(appstream)}")
        desktop_file, status = result("desktop-file")
        if status != 0 or desktop_file.strip():
            problems.append(f"desktop-file-validate: {desktop_file.strip() or 'failed'}")
        launch = flatpak_launch_problems((directory / "titles.txt").read_text().splitlines())
        if launch:
            launch[-1] += f"\n{tail((directory / 'app.txt').read_text())}"
        return problems + launch
    finally:
        shutil.rmtree(directory, ignore_errors=True)


# ---------------------------------------------------------------- JetBrains Marketplace


JETBRAINS_DIR = "packages/jetbrains-plugin"
# https://plugins.jetbrains.com/docs/marketplace/uploading-a-new-plugin.html
JETBRAINS_MAX_PLUGIN = 400 * MIB


def jetbrains_problems(runner: Runner = run) -> list[str]:
    """Build the plugin distribution and check what the Marketplace reads from it.

    https://plugins.jetbrains.com/docs/intellij/plugin-configuration-file.html
    """
    directory = REPO_ROOT / JETBRAINS_DIR
    built = runner(["./gradlew", "buildPlugin", "verifyPluginProjectConfiguration", "--no-configuration-cache"], directory)
    if built.returncode != 0:
        return [f"`gradlew buildPlugin verifyPluginProjectConfiguration` failed:\n{tail(built.stdout, 40)}"]
    problems = [line.strip() for line in built.stdout.splitlines() if "[org.jetbrains.intellij.platform]" in line and "warn" in line.lower()]
    distributions = sorted((directory / "build/distributions").glob("*.zip"))
    if len(distributions) != 1:
        return problems + [f"expected one plugin zip in build/distributions, found {[d.name for d in distributions]}"]
    plugin = distributions[0]
    if plugin.stat().st_size > JETBRAINS_MAX_PLUGIN:
        problems.append(f"{plugin.name} is over the Marketplace's 400 MB limit")
    files = read_zip(plugin)
    plugin_xml = None
    for packed in files:
        if packed.path.endswith(".jar") and "/lib/" in packed.path:
            with zipfile.ZipFile(io.BytesIO(packed.data)) as jar:
                if "META-INF/plugin.xml" in jar.namelist():
                    plugin_xml = jar.read("META-INF/plugin.xml")
    if plugin_xml is None:
        return problems + [f"{plugin.name} has no META-INF/plugin.xml in its jars"]
    root = ElementTree.fromstring(plugin_xml)
    for element in ("id", "name", "version", "vendor", "description"):
        if not (root.findtext(element) or "").strip():
            problems.append(f"plugin.xml has no <{element}>")
    if len((root.findtext("name") or "").strip()) > 60:
        problems.append("plugin.xml <name> is over the Marketplace's 60 characters")
    if not re.fullmatch(r"\d+\.\d+\.\d+", (root.findtext("version") or "").strip()):
        problems.append(f"plugin.xml <version> {root.findtext('version')!r} is not SemVer")
    idea_version = root.find("idea-version")
    if idea_version is None or not idea_version.get("since-build"):
        problems.append("plugin.xml has no <idea-version since-build>")
    return problems + content_problems(plugin.name, files, ())


# ---------------------------------------------------------------- nixpkgs


NIX_PACKAGE = "packaging/nix/package.nix"


def nixpkgs_problems(version: str) -> list[str]:
    """The `meta` nixpkgs requires of the derivation submitted by hand.

    https://github.com/NixOS/nixpkgs/blob/master/pkgs/README.md#meta-attributes
    """
    text = (REPO_ROOT / NIX_PACKAGE).read_text()
    problems = []
    found = re.search(r'^\s*version = "([^"]+)";', text, flags=re.MULTILINE)
    if not found or found.group(1) != version:
        problems.append(f"{NIX_PACKAGE} version is {found.group(1) if found else None!r}, not {version}")
    meta_start = text.find("meta = {")
    if meta_start < 0:
        return problems + [f"{NIX_PACKAGE} has no `meta = {{` block"]
    meta = text[meta_start:]
    for attribute in ("description", "homepage", "license", "mainProgram", "platforms"):
        if not re.search(rf"^\s*{attribute} =", meta, flags=re.MULTILINE):
            problems.append(f"{NIX_PACKAGE} meta has no `{attribute}`")
    description = re.search(r'^\s*description = "([^"]*)";', meta, flags=re.MULTILINE)
    if description:
        value = description.group(1)
        if value.endswith(".") or re.match(r"(?i)^(a|an|the)\s", value) or value.lower().startswith("chordsketch"):
            problems.append(f"{NIX_PACKAGE} meta.description {value!r} breaks nixpkgs' description rules")
    # `maintainers`, `hash` and `cargoHash` are filled in at submission time,
    # by the submitter and by the first build (see the file's header), so
    # only their presence is checked.
    for attribute in ("maintainers", "hash", "cargoHash"):
        if not re.search(rf"^\s*{attribute} =", text, flags=re.MULTILINE):
            problems.append(f"{NIX_PACKAGE} has no `{attribute}`")
    return problems


# ---------------------------------------------------------------- coverage


# How `publishable.yml` checks each channel of `ci/release-channels.toml`:
# the `check-publishable.py` subcommand it runs, or the workflow it calls.
# `scripts/test_publish_checks.py` fails when a channel has no entry here or
# its entry is not in `publishable.yml`, so a channel cannot be added — or a
# job dropped — without the required check noticing.
CHANNEL_CHECKS: dict[str, str] = {
    "crates-io": "check-publishable.py crates-io",
    "npm": "check-publishable.py npm",
    "napi": "check-publishable.py napi",
    "ghcr": "check-publishable.py container-image",
    "docker-hub": "check-publishable.py container-image",
    "vscode-marketplace": "check-publishable.py vsix",
    "open-vsx": "check-publishable.py vsix",
    "pypi": "check-publishable.py python",
    "rubygems": "check-publishable.py gem",
    "maven-central": "check-publishable.py maven",
    "homebrew-tap": "check-publishable.py homebrew",
    "scoop-bucket": "check-publishable.py scoop",
    "chocolatey": "check-publishable.py chocolatey",
    "aur": "check-publishable.py aur",
    "snap": "check-publishable.py snap",
    "cocoapods": "check-publishable.py cocoapods",
    "nixpkgs": "./.github/workflows/nix.yml",
    "winget": "check-publishable.py winget",
    "macports": "./.github/workflows/macports-smoke.yml",
}


def channel_check(channel_id: str, kind: str, package: str) -> str | None:
    """The CHANNEL_CHECKS entry for a manifest channel.

    Most channels are keyed by kind; the napi packages by package name, and
    the `manual` channels (pull requests to other projects) by id.
    """
    if kind == "npm" and is_napi(package):
        return CHANNEL_CHECKS.get("napi")
    if kind == "manual":
        return CHANNEL_CHECKS.get(channel_id)
    return CHANNEL_CHECKS.get(kind)


# ------------------------------------------------ what a pull request reaches

# `publishable.yml` runs every job above on a pull request only when the pull
# request changes one of these paths or adds a file over LARGE_FILE_BYTES.
# The merge queue, `main` and the nightly run always run every job
# (ADR-0079), so a change this list misses is still stopped before it lands;
# the list only decides whether the author hears about it while the pull
# request is open. A pattern without a `/` matches a file name anywhere in
# the tree; a pattern with one matches the whole path. Every pattern has to
# match a file in the tree (`test_publish_checks.py`), so a rename that
# orphans one fails rather than silently narrowing the list.
PACKAGING_PATHS = (
    # What a package declares: its manifest, lockfile, build and the files it
    # ships or leaves out.
    "Cargo.toml",
    "Cargo.lock",
    "build.rs",
    "package.json",
    "package-lock.json",
    ".vscodeignore",
    "tsconfig*.json",
    "tsup.config.*",
    "pyproject.toml",
    "*.gemspec",
    "Package.swift",
    "*.gradle.kts",
    "gradle.properties",
    "plugin.xml",
    "tauri.conf.json",
    "Dockerfile*",
    "flake.nix",
    "flake.lock",
    # The workflows whose release steps the checks lift and run, the
    # workflows publishable.yml calls, and the composite actions its jobs use.
    ".github/workflows/publishable.yml",
    ".github/workflows/release.yml",
    ".github/workflows/post-release.yml",
    ".github/workflows/desktop-release.yml",
    ".github/workflows/swift.yml",
    ".github/workflows/nix.yml",
    ".github/workflows/macports-smoke.yml",
    ".github/actions/chocolatey-generate-package/*",
    ".github/actions/chocolatey-pack-push/*",
    ".github/actions/cli-render-smoke/*",
    ".github/actions/docker-release-image/*",
    ".github/actions/install-macports/*",
    ".github/actions/install-wasm-pack/*",
    ".github/actions/rust-cache/*",
    ".github/actions/vscode-extension-build/*",
    ".github/actions/vscode-extension-publish-setup/*",
    "ci/release-channels.toml",
    "packaging/*",
    "crates/*/scripts/*",
    "packages/*/scripts/*",
    # The checks themselves.
    "scripts/_action_yml.py",
    "scripts/_publish_checks.py",
    "scripts/_release_channels.py",
    "scripts/check-publishable.py",
    "scripts/macports-regen-cargo-crates.py",
    "scripts/publish-registries.py",
    "scripts/release.py",
    "scripts/smoke-test-python.py",
    "scripts/swift_package.py",
    "scripts/test_publish_checks.py",
    "scripts/test_publish_registries.py",
    "scripts/test_release.py",
    "scripts/test_swift_package.py",
)


def packaging_path_matches(path: str, pattern: str) -> bool:
    """Whether `path` falls under one PACKAGING_PATHS pattern."""
    return fnmatch.fnmatchcase(path if "/" in pattern else path.rsplit("/", 1)[-1], pattern)


def packaging_reasons(changes: dict[str, int | None]) -> list[str]:
    """Why a change needs the publish checks on its pull request; empty if nothing.

    `changes` maps each changed path to its size after the change, or None
    when the change deletes it.
    """
    reasons = []
    for path, size in sorted(changes.items()):
        pattern = next((p for p in PACKAGING_PATHS if packaging_path_matches(path, p)), None)
        if pattern is not None:
            reasons.append(f"`{path}` matches `{pattern}`")
        elif size is not None and size > LARGE_FILE_BYTES:
            # A large file can push a package over a registry's limit wherever
            # it lives: v0.6.0's render-pdf crate grew through test fixtures.
            reasons.append(f"`{path}` is {size / MIB:.1f} MiB, over the {LARGE_FILE_BYTES // MIB} MiB a package may carry undeclared")
    return reasons


def changed_files(base: str, head: str = "HEAD", tree: Path = REPO_ROOT) -> dict[str, int | None]:
    """Every path `head` changes relative to `base`, with its size in `head`.

    Raises `subprocess.CalledProcessError` when git cannot tell, so a caller
    never mistakes an unreadable diff for an empty one.
    """
    def git(*args: str) -> str:
        return subprocess.run(["git", *args], cwd=tree, check=True, text=True, stdout=subprocess.PIPE).stdout

    changes: dict[str, int | None] = {
        path: None for path in git("diff", "--name-only", "--no-renames", "-z", base, head).split("\0") if path
    }
    if not changes:
        return changes
    for entry in git("--literal-pathspecs", "ls-tree", "-r", "-l", "-z", head, "--", *changes).split("\0"):
        if not entry:
            continue
        meta, path = entry.split("\t", 1)
        size = meta.split()[3]
        # A submodule has no size; it is not a file a package carries.
        changes[path] = int(size) if size.isdigit() else 0
    return changes
