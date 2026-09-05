#!/usr/bin/env python3
"""Keep every restatement of the workspace MSRV in step with `Cargo.toml`.

`rust-version` in `[workspace.package]` is the one place this project
declares the Rust it needs, and `cargo` enforces it — a toolchain below
the floor refuses to compile the workspace at all:

    error: rustc 1.85.1 is not supported by the following packages:
      chordsketch@0.5.0 requires rustc 1.88

Two files restate that number, and neither is exercised by anything that
runs on a pull request:

`Dockerfile` pins its builder stage to an exact `rust:<tag>@sha256:<digest>`
pair (#1103). No workflow builds it: `docker.yml` publishes from
`Dockerfile.release`, which copies a prebuilt musl binary and never
compiles Rust. A builder pin left behind by an MSRV bump therefore stays
green until somebody runs `docker build .` by hand — which is how one
survived a bump to 1.88 while still naming `rust:1.85-bookworm`.

`README.md` states "Requires Rust N.M or later." under
`## Installation` → `### From source`. `readme-sync.yml` snapshots the
bash *commands* in that section, not the prose around them, so the
sentence can drift without any check noticing.

Both sites are static text, so this is a text comparison: read the floor
from `Cargo.toml`, read the version out of every `FROM rust:...` line in
every Dockerfile in the tree and out of README's requirement sentence,
and fail when a Dockerfile sits below the floor or the README sentence
does not name it exactly.

Each Dockerfile pin must also keep BOTH halves of the #1103 pair. The
digest is what decides which image actually builds; the tag is what
Dependabot correlates a bump against, what a human reads the version
from — and what this check reads, so a digest-only pin would make the
comparison impossible rather than merely harder.

Deliberately text-only: no network, no `docker pull`, no cargo. It runs
in well under a second on every PR alongside the other guard jobs in
`ci.yml`. The gap that leaves is a pin whose tag and digest disagree,
which no static reading can see; the two halves are written in one token
and bumped together by Dependabot, so the tag is a faithful label of the
digest in practice.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
CARGO_TOML = Path("Cargo.toml")
README = Path("README.md")

# Directories that never hold a Dockerfile this project ships, and that
# are expensive to walk.
SKIP_DIRS = {".git", "node_modules", "target", "dist", ".venv", "vendor"}

# `rust-version = "1.88"` inside `[workspace.package]`. The workspace
# table is the only one that sets it — every crate inherits via
# `rust-version.workspace = true`.
MSRV_RE = re.compile(r'^\s*rust-version\s*=\s*"([^"]+)"', re.MULTILINE)

# `FROM [--platform=...] <image> [AS <stage>]`.
FROM_RE = re.compile(r"^FROM\s+(?:--\S+\s+)*(\S+)", re.IGNORECASE)

# The official Rust image, however it is qualified.
RUST_IMAGE_RE = re.compile(r"^(?:docker\.io/)?(?:library/)?rust(?=[:@]|$)")

# The leading version in an image tag: `1.98-bookworm`, `1.98.0-slim`, `1.88`.
TAG_VERSION_RE = re.compile(r"^(\d+(?:\.\d+)*)")

# README's requirement sentence.
README_MSRV_RE = re.compile(r"Requires Rust (\d+(?:\.\d+)*) or later")


def parse_version(text: str) -> tuple[int, ...]:
    """Turn `1.88` into `(1, 88)`."""
    return tuple(int(part) for part in text.split("."))


def read_msrv(cargo_toml_text: str) -> str:
    """The `rust-version` string declared by `[workspace.package]`."""
    match = MSRV_RE.search(cargo_toml_text)
    if match is None:
        raise SystemExit(f"{CARGO_TOML}: no `rust-version` found in [workspace.package]")
    return match.group(1)


def find_dockerfiles(root: Path) -> list[Path]:
    """Every Dockerfile in the tree, repo-relative and sorted.

    Discovered rather than listed so a Dockerfile added later is covered
    without anyone remembering to extend a constant — the failure mode a
    hand-maintained path list has.
    """
    found = []
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        if any(part in SKIP_DIRS for part in path.relative_to(root).parts):
            continue
        name = path.name
        if name == "Dockerfile" or name.startswith("Dockerfile.") or name.endswith(".Dockerfile"):
            found.append(path.relative_to(root))
    return sorted(found)


def check_dockerfile(text: str, path: Path, msrv: str) -> list[str]:
    """Return one error string per `FROM rust:...` line that breaks the contract."""
    floor = parse_version(msrv)
    errors = []
    for number, line in enumerate(text.splitlines(), start=1):
        match = FROM_RE.match(line.strip())
        if match is None:
            continue
        image = match.group(1)
        if RUST_IMAGE_RE.match(image) is None:
            continue

        reference, _, digest = image.partition("@")
        _, _, tag = reference.partition(":")
        where = f"{path}:{number}"

        if not tag:
            errors.append(
                f"{where}: `{image}` pins the Rust builder by digest alone. "
                f"Keep the `rust:<version>` tag alongside the digest (#1103) — "
                f"it is what names the toolchain version."
            )
            continue

        version_match = TAG_VERSION_RE.match(tag)
        if version_match is None:
            errors.append(
                f"{where}: `{image}` uses the floating tag `{tag}`. Pin an "
                f"explicit `rust:<major>.<minor>` so the toolchain the image "
                f"builds with is readable and cannot move underneath a release."
            )
            continue

        if not digest:
            errors.append(
                f"{where}: `{image}` has no `@sha256:` digest. A tag republish "
                f"on Docker Hub could otherwise swap the builder (#1103)."
            )

        if parse_version(version_match.group(1)) < floor:
            errors.append(
                f"{where}: `{image}` builds with Rust {version_match.group(1)}, "
                f"below the workspace `rust-version = \"{msrv}\"`. `cargo build` "
                f"refuses the workspace outright on that toolchain "
                f"(\"rustc {version_match.group(1)} is not supported by the "
                f"following packages\"), so this image cannot be built at all. "
                f"Bump the tag AND its digest together."
            )
    return errors


def check_readme(text: str, msrv: str) -> list[str]:
    """Return an error if README's from-source requirement is not the MSRV."""
    match = README_MSRV_RE.search(text)
    if match is None:
        return [
            f'{README}: no "Requires Rust <version> or later." sentence found. '
            f"The from-source install section states the toolchain a user needs; "
            f"restore it (currently {msrv}) or update this check."
        ]
    if match.group(1) != msrv:
        return [
            f"{README}: states Rust {match.group(1)}, but the workspace declares "
            f'`rust-version = "{msrv}"`. A user following the from-source '
            f"instructions on {match.group(1)} hits a compile error, not a clear "
            f"message about the floor."
        ]
    return []


def main() -> int:
    msrv = read_msrv((REPO_ROOT / CARGO_TOML).read_text(encoding="utf-8"))

    dockerfiles = find_dockerfiles(REPO_ROOT)
    if not dockerfiles:
        print(f"ERROR: no Dockerfile found under {REPO_ROOT}", file=sys.stderr)
        return 1

    errors = []
    for dockerfile in dockerfiles:
        errors += check_dockerfile(
            (REPO_ROOT / dockerfile).read_text(encoding="utf-8"), dockerfile, msrv
        )
    errors += check_readme((REPO_ROOT / README).read_text(encoding="utf-8"), msrv)

    if errors:
        for error in errors:
            print(f"ERROR: {error}", file=sys.stderr)
        return 1

    listed = ", ".join(str(path) for path in dockerfiles)
    print(f"OK: {listed} and {README} agree with rust-version = {msrv}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
