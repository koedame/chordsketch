#!/usr/bin/env python3
"""Write a buildable Flatpak manifest for the desktop app into a directory.

    packaging/flatpak/prepare.py --out build/flatpak
    packaging/flatpak/prepare.py --out flathub --git-tag desktop-v0.7.0 --git-commit <sha>

A Flatpak build has no network, so every file the build reads is listed in
the manifest as a source with a checksum. Most of that list is generated
from the lockfiles, and this script generates it:

  me.koeda.ChordSketch.yml    copied from this directory
  chordsketch-source.json     this checkout (default), or the tagged commit
                              on GitHub (`--git-tag` / `--git-commit`), which
                              is the form Flathub builds
  cargo-sources.json          Cargo.lock
  node-sources.json           apps/desktop and packages/react package-lock.json
  rust-toolchain.json         Rust (`--rust-version`, default: current stable)
                              with the wasm32-unknown-unknown standard library
  wasm-bindgen-cli.json       the wasm-bindgen CLI at Cargo.lock's version

The cargo and npm lists come from flatpak-builder-tools, fetched at
FLATPAK_BUILDER_TOOLS_COMMIT unless `--builder-tools` names a checkout. Its
generators need the Python packages `aiohttp` and `tomlkit`.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import tomllib
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
APP_ID = "me.koeda.ChordSketch"
REPOSITORY_URL = "https://github.com/koedame/chordsketch.git"

FLATPAK_BUILDER_TOOLS = "https://github.com/flatpak/flatpak-builder-tools.git"
FLATPAK_BUILDER_TOOLS_COMMIT = "de2225a6dee4818c1339b3cdbf29f90c471fcb7e"

NPM_LOCKFILES = ("apps/desktop/package-lock.json", "packages/react/package-lock.json")

# Architectures Flathub builds for, as Flatpak and Rust name them.
ARCHES = {"x86_64": "x86_64-unknown-linux-gnu", "aarch64": "aarch64-unknown-linux-gnu"}

# Everything in the checkout a build does not read, and that would otherwise
# be copied into the build directory.
DIR_SOURCE_SKIP = [".git", "target", "node_modules", "build", ".flatpak-builder"]


def fetch(url: str) -> bytes:
    with urllib.request.urlopen(url, timeout=120) as response:
        return response.read()


def write_json(path: Path, value: object) -> None:
    path.write_text(json.dumps(value, indent=4) + "\n")


def source_entry(args: argparse.Namespace) -> dict:
    if args.git_tag:
        return {"type": "git", "url": REPOSITORY_URL, "tag": args.git_tag, "commit": args.git_commit}
    return {"type": "dir", "path": str(REPO), "skip": DIR_SOURCE_SKIP}


def rust_toolchain_module(version: str) -> dict:
    """Rust from static.rust-lang.org, plus the wasm32 standard library.

    The rust-stable SDK extension ships the host and i686 standard libraries
    only, and its rustc refuses a standard library of any other version, so
    the compiler and the wasm32 library are taken from the same release.
    """
    channel = tomllib.loads(fetch(f"https://static.rust-lang.org/dist/channel-rust-{version}.toml").decode())
    packages = channel["pkg"]

    def archive(package: str, target: str, dest: str, arch: str | None = None) -> dict:
        entry = packages[package]["target"][target]
        if not entry.get("available"):
            raise SystemExit(f"Rust {version} has no {package} for {target}")
        source = {"type": "archive", "url": entry["xz_url"], "sha256": entry["xz_hash"], "dest": dest}
        if arch:
            source["only-arches"] = [arch]
        return source

    return {
        "name": "rust-toolchain",
        "buildsystem": "simple",
        # Stripping rustc's LLVM library leaves it unloadable.
        "build-options": {"strip": False, "no-debuginfo": True},
        "cleanup": ["*"],
        "build-commands": [
            "cd rust && ./install.sh --prefix=/app/lib/rust --disable-ldconfig"
            " --components=rustc,cargo,rust-std-$(uname -m)-unknown-linux-gnu",
            "cd rust-std-wasm32 && ./install.sh --prefix=/app/lib/rust --disable-ldconfig",
        ],
        "sources": [archive("rust", target, "rust", arch) for arch, target in ARCHES.items()]
        + [archive("rust-std", "wasm32-unknown-unknown", "rust-std-wasm32")],
    }


def stable_rust_version() -> str:
    channel = tomllib.loads(fetch("https://static.rust-lang.org/dist/channel-rust-stable.toml").decode())
    # "1.98.1 (48a229cea 2026-09-01)"
    return channel["pkg"]["rust"]["version"].split()[0]


def locked_version(lockfile: Path, name: str) -> str:
    versions = {p["version"] for p in tomllib.loads(lockfile.read_text())["package"] if p["name"] == name}
    if len(versions) != 1:
        raise SystemExit(f"{lockfile} must lock exactly one {name}, found {sorted(versions) or 'none'}")
    return versions.pop()


def wasm_bindgen_cli_module(version: str, tools: Path, scratch: Path) -> dict:
    """The CLI must be the version of the wasm-bindgen crate it post-processes."""
    url = f"https://static.crates.io/crates/wasm-bindgen-cli/wasm-bindgen-cli-{version}.crate"
    crate = fetch(url)
    unpacked = scratch / "wasm-bindgen-cli"
    unpacked.mkdir()
    subprocess.run(["tar", "-xzf", "-", "-C", str(unpacked), "--strip-components=1"], input=crate, check=True)
    sources = scratch / "wasm-bindgen-cli-sources.json"
    cargo_generator(tools, unpacked / "Cargo.lock", sources)
    return {
        "name": "wasm-bindgen-cli",
        "buildsystem": "simple",
        "cleanup": ["*"],
        "build-options": {
            "prepend-path": "/app/lib/rust/bin",
            "prepend-ld-library-path": "/app/lib/rust/lib",
            "env": {"CARGO_HOME": "/run/build/wasm-bindgen-cli/cargo", "CARGO_NET_OFFLINE": "true"},
        },
        "build-commands": [
            "cargo build --release --locked --bin wasm-bindgen",
            "install -Dm755 target/release/wasm-bindgen -t /app/lib/wasm-bindgen/bin",
        ],
        "sources": [
            {
                "type": "archive",
                "archive-type": "tar-gzip",
                "url": url,
                "sha256": hashlib.sha256(crate).hexdigest(),
            },
            *json.loads(sources.read_text()),
        ],
    }


def builder_tools(given: Path | None, scratch: Path) -> Path:
    if given:
        return given
    checkout = scratch / "flatpak-builder-tools"
    subprocess.run(["git", "init", "-q", str(checkout)], check=True)
    subprocess.run(["git", "-C", str(checkout), "fetch", "-q", "--depth=1", FLATPAK_BUILDER_TOOLS, FLATPAK_BUILDER_TOOLS_COMMIT], check=True)
    subprocess.run(["git", "-C", str(checkout), "checkout", "-q", "FETCH_HEAD"], check=True)
    return checkout


def cargo_generator(tools: Path, lockfile: Path, output: Path) -> None:
    subprocess.run([sys.executable, str(tools / "cargo" / "flatpak-cargo-generator.py"), str(lockfile), "-o", str(output)], check=True)


def node_generator(tools: Path, output: Path) -> None:
    command = [sys.executable, "-m", "flatpak_node_generator", "npm", "--recursive", str(REPO / "package-lock.json")]
    for lockfile in NPM_LOCKFILES:
        command += ["--recursive-pattern", lockfile]
    environment = dict(os.environ, PYTHONPATH=str(tools / "node"))
    # The generator draws a progress line per package; keep the log to its summary.
    result = subprocess.run(command + ["-o", str(output)], env=environment, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    if result.returncode != 0:
        raise SystemExit(f"flatpak-node-generator failed:\n{result.stdout[-4000:]}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    parser.add_argument("--out", type=Path, required=True, help="directory to write the manifest and its sources into")
    parser.add_argument("--git-tag", help="build this tag of the GitHub repository instead of the checkout")
    parser.add_argument("--git-commit", help="the commit --git-tag points at")
    parser.add_argument("--rust-version", help="Rust release to build with (default: current stable)")
    parser.add_argument("--builder-tools", type=Path, help="a flatpak-builder-tools checkout to use instead of fetching one")
    args = parser.parse_args(argv)
    if bool(args.git_tag) != bool(args.git_commit):
        parser.error("--git-tag and --git-commit go together")

    missing = [name for name in NPM_LOCKFILES if not (REPO / name).is_file()]
    if missing:
        parser.error(f"missing lockfile: {', '.join(missing)}")
    # flatpak-node-generator reads installed packages over the lockfile when
    # node_modules exists, and would list what happens to be installed.
    present = [str(Path(name).parent / "node_modules") for name in NPM_LOCKFILES if (REPO / name).parent.joinpath("node_modules").exists()]
    if present:
        parser.error(f"remove {', '.join(present)} first: the npm sources must come from the lockfiles alone")

    args.out.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as temporary:
        scratch = Path(temporary)
        tools = builder_tools(args.builder_tools, scratch)
        shutil.copyfile(HERE / f"{APP_ID}.yml", args.out / f"{APP_ID}.yml")
        write_json(args.out / "chordsketch-source.json", [source_entry(args)])
        write_json(args.out / "rust-toolchain.json", rust_toolchain_module(args.rust_version or stable_rust_version()))
        write_json(args.out / "wasm-bindgen-cli.json", wasm_bindgen_cli_module(locked_version(REPO / "Cargo.lock", "wasm-bindgen"), tools, scratch))
        cargo_generator(tools, REPO / "Cargo.lock", args.out / "cargo-sources.json")
        node_generator(tools, args.out / "node-sources.json")
    print(f"wrote {args.out}/{APP_ID}.yml and its sources")
    return 0


if __name__ == "__main__":
    sys.exit(main())
