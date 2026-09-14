"""What each registry must accept before a release is attempted, as code.

`docs/publishing-requirements.md` is the table of conditions each
distribution channel imposes on an upload. This module is the one
executable definition of the conditions that can be checked without
publishing, and it is imported by both places that check them:

  - `scripts/check-publishable.py`, which `.github/workflows/publishable.yml`
    runs on every pull request, every push to `main` and nightly;
  - `scripts/release.py`, whose preflight runs the same checks against the
    release commit on the maintainer's machine (ADR-0068).

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
import json
import os
import re
import subprocess
import tarfile
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterable

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


def tool_warnings(label: str, output: str, *, prefix: re.Pattern[str], expected: tuple[re.Pattern[str], ...] = ()) -> list[str]:
    """Every warning line a publish tool printed, except the expected ones."""
    lines = [line.rstrip() for line in output.splitlines()]
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
    result = subprocess.run(
        cmd,
        cwd=cwd,
        env={**os.environ, **(env or {})},
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
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
    version on disk: a dependency pinned to exactly that version is
    published in the same release. Anything else must already be satisfiable
    from the registry, which `view(name, range)` answers.
    """
    name = manifest.get("name", "<unnamed>")
    problems = []
    for field in ("dependencies", "peerDependencies", "optionalDependencies"):
        for dependency, spec in (manifest.get(field) or {}).items():
            if NON_REGISTRY_SPEC.match(spec):
                problems.append(f"{name} {field} `{dependency}` is `{spec}`, which does not resolve from the npm registry")
            elif released_together.get(dependency) == spec:
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
    import platform

    system = {"Linux": "linux", "Darwin": "darwin", "Windows": "win32"}.get(platform.system())
    machine = {"x86_64": "x64", "AMD64": "x64", "arm64": "arm64", "aarch64": "arm64"}.get(platform.machine())
    suffix = {"linux": "-gnu", "win32": "-msvc", "darwin": ""}.get(system or "")
    triple = f"{system}-{machine}{suffix}"
    return triple if triple in NODE_TRIPLES else None


def napi_problems(tarball_dir: Path, version: str, released_together: dict[str, str], runner: Runner = run) -> list[str]:
    """Check the resolver and platform tarballs staged for a release."""
    problems = []
    tarballs: dict[str, Path] = {}
    for name, package in NPM_PACKAGES.items():
        if not is_napi(name):
            continue
        tarball = tarball_dir / npm_tarball_name(name, version)
        if not tarball.is_file():
            problems.append(f"no staged tarball {tarball.name} in {tarball_dir}")
            continue
        tarballs[name] = tarball
        problems += npm_tarball_problems(package, tarball, released_together, runner)
    host = host_napi_triple()
    host_package = f"{NAPI_PACKAGE}-{host}" if host else ""
    if NAPI_PACKAGE in tarballs and host_package in tarballs:
        problems += npm_smoke_problems(NPM_PACKAGES[NAPI_PACKAGE], [tarballs[host_package], tarballs[NAPI_PACKAGE]], runner)
    return problems


def npm_problems(package: NpmPackage, tree: Path, out: Path, released_together: dict[str, str], runner: Runner = run) -> list[str]:
    """Build, pack, dry-run and smoke-test one non-napi npm package."""
    tarball, problems = pack_npm(package, tree, out, runner)
    if tarball is None:
        return problems
    return npm_tarball_problems(package, tarball, released_together, runner) + npm_smoke_problems(package, [tarball], runner)
