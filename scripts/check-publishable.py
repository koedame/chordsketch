#!/usr/bin/env python3
"""Fail when a package this repository publishes could not be published.

    python3 scripts/check-publishable.py crates-io
    python3 scripts/check-publishable.py npm --package @chordsketch/wasm
    python3 scripts/check-publishable.py napi --tarballs release-staging

Run by `.github/workflows/publishable.yml` on every pull request, every
push to `main` and nightly. The conditions, and the reason each exists, are
in `docs/publishing-requirements.md`; the checks themselves live in
`scripts/_publish_checks.py`, which `scripts/publish-registries.py` runs
too before crates.io and npm publish, so a release is held to exactly what
every pull request was held to.

Subcommands:

  crates-io   `cargo publish --dry-run` over every published crate together,
              then the packaged size, metadata and contents of each.
  npm         Build, pack, `npm publish --dry-run` and smoke-install one npm
              package (`--package`), or every one that is not a napi package.
  napi        Check the `@chordsketch/node` resolver and platform tarballs that
              `crates/napi/scripts/stage-release-tarballs.sh` staged.
  npm-matrix  Print the non-napi npm packages as a JSON job matrix, so the
              workflow's matrix is read from the same definition.
  vsce-package
              Package one VSIX of packages/vscode-extension and check it;
              `--target` with `--lsp <binary>` for a platform-specific one.
  vsix        Check the set of VSIXes in a directory before it is published:
              one universal plus one per target, each publishable.
  vscode-matrix
              Print the platform-specific VSIX targets as a JSON job matrix.
  python      Check the sdist and wheels in `--dist`: size, metadata,
              `twine check --strict`, and that the wheel installs and works.
  gem         Build packages/ruby's gem, check it, install it and load it.
  maven       Publish packages/kotlin to a scratch Maven repository and check
              the POM, sources/javadoc jars, signatures, the bundled JNA
              libraries, and that the jar works from a clean classpath.
  container-image
              Check the tags the release image is built with, and run the
              built image.
  fabricate-release
              Write the `checksums.txt` / `SHA256SUMS` a release job has
              downloaded, for a checksum per asset, into `--dir`.
  homebrew, scoop, aur, cocoapods, swift-package, winget
              Generate the channel's manifest with the release's own step and
              check it with the channel's tooling.
  snap        As above, packing the snap with `--binary` staged.
  chocolatey  Pack `--dir`/choco-pkg with the release's Pack step and check
              the package.
  cli-archive Package release.yml's archive for `--target` from `--binaries`
              and check its layout and checksum line.
  desktop-updater
              Build latest.json with desktop-release.yml's step and check it.
  flathub     Generate the desktop app's Flathub files with desktop-release.yml's
              step, lint them, build the Flatpak without network and launch it.
              Needs docker, and the Python packages aiohttp, tomlkit and PyYAML.
  jetbrains   Build the JetBrains plugin distribution and check it.
  nixpkgs     Check the nixpkgs derivation template's metadata.

Exits 1 and lists every problem when any check fails. Stdlib only.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import _publish_checks as checks  # noqa: E402


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("crates-io", help="check every published crate")
    npm = sub.add_parser("npm", help="check npm packages built from this tree")
    npm.add_argument("--package", action="append", help="package name (repeatable); default: every non-napi package")
    napi = sub.add_parser("napi", help="check staged @chordsketch/node tarballs")
    napi.add_argument("--tarballs", type=Path, required=True, help="directory the staging script packed into")
    sub.add_parser("npm-matrix", help="print the npm job matrix as JSON")
    vsce = sub.add_parser("vsce-package", help="package and check one VSIX")
    vsce.add_argument("--target", choices=[t.vs_target for t in checks.VSCODE_TARGETS], help="platform-specific VSIX target")
    vsce.add_argument("--lsp", type=Path, help="the target's chordsketch-lsp binary to bundle (with --target)")
    vsix = sub.add_parser("vsix", help="check the VSIXes about to be published")
    vsix.add_argument("--dir", type=Path, required=True, help="directory holding the VSIXes")
    sub.add_parser("vscode-matrix", help="print the VSIX targets as JSON")
    python = sub.add_parser("python", help="check the built Python distributions")
    python.add_argument("--dist", type=Path, required=True, help="directory maturin wrote the sdist and wheels to")
    sub.add_parser("gem", help="build and check the Ruby gem")
    sub.add_parser("maven", help="publish the Kotlin library locally and check it")
    image = sub.add_parser("container-image", help="check the release image tags and run the image")
    image.add_argument("--tag", required=True, help="the release tag the image was tagged from")
    image.add_argument("--tags", required=True, help="the image references, one per line")
    image.add_argument("--image", required=True, help="a locally loaded build of the image to run")
    fabricate = sub.add_parser("fabricate-release", help="write a fabricated release checksum set")
    fabricate.add_argument("--dir", type=Path, required=True)
    archive = sub.add_parser("cli-archive", help="package and check a release archive")
    archive.add_argument("--binaries", type=Path, required=True, help="directory holding chordsketch and chordsketch-lsp")
    archive.add_argument("--target", default="x86_64-unknown-linux-gnu")
    for channel in ("homebrew", "scoop", "aur", "cocoapods", "swift-package", "winget", "desktop-updater", "flathub", "jetbrains", "nixpkgs"):
        sub.add_parser(channel, help=f"check the {channel} manifest")
    snap = sub.add_parser("snap", help="generate and pack the snap")
    snap.add_argument("--binary", type=Path, required=True, help="a Linux x86_64 chordsketch to stage")
    chocolatey = sub.add_parser("chocolatey", help="pack and check the Chocolatey package")
    chocolatey.add_argument("--dir", type=Path, required=True, help="the workspace holding choco-pkg/")
    args = parser.parse_args(argv)

    if args.command == "npm-matrix":
        packages = [p for name, p in checks.NPM_PACKAGES.items() if not checks.is_napi(name)]
        print(json.dumps([{"package": p.name, "tools": list(p.tools)} for p in packages]))
        return 0
    if args.command == "vscode-matrix":
        print(json.dumps([vars(t) for t in checks.VSCODE_TARGETS]))
        return 0

    tree = checks.REPO_ROOT
    if args.command == "crates-io":
        target = Path(os.environ.get("CARGO_TARGET_DIR", tree / "target"))
        problems = checks.crates_problems(tree, tuple(checks.CRATES), target)
    elif args.command == "npm":
        names = args.package or [name for name in checks.NPM_PACKAGES if not checks.is_napi(name)]
        unknown = [name for name in names if name not in checks.NPM_PACKAGES or checks.is_napi(name)]
        if unknown:
            parser.error(f"not a non-napi npm package defined in scripts/_publish_checks.py: {', '.join(unknown)}")
        released_together = checks.repo_npm_versions(tree)
        problems = []
        with tempfile.TemporaryDirectory(prefix="npm-pack-") as out:
            for name in names:
                print(f"\n==> {name}", flush=True)
                problems += checks.npm_problems(checks.NPM_PACKAGES[name], tree, Path(out), released_together)
    elif args.command == "napi":
        version = json.loads((tree / checks.NPM_PACKAGES[checks.NAPI_PACKAGE].directory / "package.json").read_text())["version"]
        problems = checks.napi_problems(args.tarballs.resolve(), version, checks.repo_npm_versions(tree))
    elif args.command == "vsce-package":
        target = next((t for t in checks.VSCODE_TARGETS if t.vs_target == args.target), None)
        if (target is None) != (args.lsp is None):
            parser.error("--target and --lsp go together")
        problems = checks.vsce_package_problems(tree / checks.VSCODE_EXTENSION_DIR, target, args.lsp.resolve() if args.lsp else None)
    elif args.command == "vsix":
        problems = checks.vsix_set_problems(args.dir.resolve())
    elif args.command == "python":
        problems = checks.python_dist_problems(args.dist.resolve())
    elif args.command == "gem":
        problems = checks.gem_problems(tree / checks.RUBY_GEM_DIR)
    elif args.command == "maven":
        problems = checks.maven_problems(tree / checks.KOTLIN_DIR)
    elif args.command == "container-image":
        tags = [line.strip() for line in args.tags.splitlines() if line.strip()]
        problems = checks.container_tag_problems(args.tag, tags)
        problems += checks.container_image_problems(args.image, args.tag.removeprefix("v"))
    else:
        version = checks.cargo_package_version(tree / "crates/cli/Cargo.toml")
        if args.command == "fabricate-release":
            args.dir.mkdir(parents=True, exist_ok=True)
            checks.fabricated_release(args.dir, version)
            return 0
        simple = {
            "homebrew": checks.homebrew_problems,
            "scoop": checks.scoop_problems,
            "aur": checks.aur_problems,
            "cocoapods": checks.cocoapods_problems,
            "swift-package": checks.swift_package_problems,
            "winget": checks.winget_problems,
            "desktop-updater": checks.desktop_updater_problems,
            "flathub": checks.flathub_problems,
            "nixpkgs": checks.nixpkgs_problems,
        }
        if args.command in simple:
            problems = simple[args.command](version)
        elif args.command == "jetbrains":
            problems = checks.jetbrains_problems()
        elif args.command == "cli-archive":
            problems = checks.cli_archive_problems(version, args.target, args.binaries.resolve())
        elif args.command == "snap":
            problems = checks.snap_problems(version, args.binary.resolve())
        else:
            problems = checks.chocolatey_problems(args.dir.resolve(), version)

    if problems:
        print(f"\n{len(problems)} problem(s) would stop this from being published:", file=sys.stderr)
        for problem in problems:
            print(f"  - {problem}", file=sys.stderr)
        return 1
    print("\nPublishable.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
