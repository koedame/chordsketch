#!/usr/bin/env python3
"""Enforce the glibc floor of the Linux artifacts this project ships.

A glibc-linked ELF can only be loaded on a host whose glibc is at least
as new as the newest `GLIBC_x.y` symbol version the file references.
Building on a GitHub-hosted `ubuntu-latest` runner therefore bakes that
runner's glibc into the support floor, and the failure is invisible on
the runner itself: the artifact is produced, published and installed
without complaint, and only dies on the user's older distro with

    version `GLIBC_2.39' not found (required by chordsketch)

That applies to every Linux artifact, not just the CLI archives: the
napi-rs `.node` addon, the FFI `.so` inside the gem, and the JNI `.so`
inside the JAR are loaded by the same dynamic linker and were shipping
the same 2.39 floor in v0.5.0.

This script closes the gap from two directions.

Workflow mode (default, runs on every PR via `ci.yml`)
    Assert that every Linux target in `.github/workflows/release.yml`'s
    build matrix carries `cross: true`. `cross` builds inside a pinned
    old-sysroot container, which is what keeps the floor low; a Linux
    target without it silently inherits the runner's glibc.

    Assert the same thing for the desktop bundles, where it takes a
    different form: `desktop-build.yml` and `desktop-release.yml` must
    name a pinned Linux runner rather than `ubuntu-latest`, because a
    Tauri build links the host's webkit2gtk and cannot be containerised
    into an old sysroot at all. `desktop-release.yml` in particular has
    no pull_request trigger, so this is the only per-PR signal on it.

Binary mode (`--target T FILE...`)
    Read the ELF symbol versions of the artifacts that are about to be
    packaged and fail if any of them requires a newer glibc than the
    floor its channel declares. This measures the artifact rather than
    the configuration, so it also catches a `cross` image whose sysroot
    moved forward. For musl targets it asserts the opposite: no glibc
    references at all.

    Run from `release.yml` (CLI archives), `napi.yml` (Node addon),
    `ruby.yml` (gem native library), `kotlin.yml` (JNI library) and
    `.github/actions/desktop-build-steps` (the `.deb` / `.rpm` /
    `.AppImage` bundles), in each case in the build job that the
    publishing job depends on, so a violation blocks publication. The three binding workflows also build
    on pull requests, so for them this is a per-PR check as well — which
    is why they have no workflow-mode counterpart: their Linux builds are
    separate jobs rather than one uniform matrix, and measuring the
    artifact on every PR is the stronger of the two checks anyway.

The desktop bundles are a second channel with its own floor
(`--channel desktop`). They link webkit2gtk and GTK from the build
host, so they cannot be built inside `cross`'s Ubuntu 16.04 sysroot and
cannot reach 2.18; the oldest distribution that ships webkit2gtk 4.1 at
all is Ubuntu 22.04, so 2.35 buys the whole reachable audience. Both
floors are enforced the same way, from configuration on every PR and
from the artifact before publication.

Neither floor is a tuning knob. Raising one drops every distro between
the old and new value; a build that trips this check should be fixed by
restoring the older build host, not by editing the constant.
"""

from __future__ import annotations

import argparse
import re
import shutil
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
RELEASE_WORKFLOW = Path(".github/workflows/release.yml")
# Both desktop workflows declare the same four-cell matrix, and only one
# of them (`desktop-build.yml`) runs on pull requests — a `runs-on` edit
# in the release copy alone would otherwise first be noticed at tag time.
DESKTOP_WORKFLOWS = (
    Path(".github/workflows/desktop-build.yml"),
    Path(".github/workflows/desktop-release.yml"),
)

# The newest glibc symbol version a `*-linux-gnu` artifact may
# reference. 2.18 is what the already-`cross`-built v0.5.0
# `aarch64-unknown-linux-gnu` artifacts require — `chordsketch` tops out
# at GLIBC_2.17 and `chordsketch-lsp` adds a single weak reference to
# `__cxa_thread_atexit_impl@GLIBC_2.18` from Rust's thread-local
# teardown. Every distro still in vendor support is far above it
# (RHEL 8: 2.28, Debian 11: 2.31, Ubuntu 20.04: 2.31). One constant for
# every channel: a user who can run the CLI can load the gem, the JAR and
# the Node addon too.
MAX_GLIBC = (2, 18)

# The desktop bundles cannot reach that floor and are measured against
# their own. A Tauri app links webkit2gtk and GTK from the build host, so
# `cross`'s Ubuntu 16.04 image — which has neither — cannot build it, and
# the AppImage ships copies of the host's own system libraries alongside
# the executable. The floor is therefore whatever the oldest usable build
# host produces, and the oldest distribution carrying webkit2gtk 4.1 (the
# ABI `apps/desktop/src-tauri` builds against, and the one the `.deb` and
# `.rpm` name in their dependencies) is Ubuntu 22.04, glibc 2.35. Below
# that there is nothing to reach: Debian 11 and RHEL 8 have no
# webkit2gtk-4.1 package at any glibc version, so a lower floor would buy
# no additional audience. Ubuntu 22.04 and Debian 12 — which install the
# bundles today and then fail to start — are exactly what it buys.
DESKTOP_MAX_GLIBC = (2, 35)

# `--channel` selects between them. Named rather than free-form (there is
# no `--floor 2.31`) because each value is a published support contract.
CHANNEL_FLOORS = {"cross": MAX_GLIBC, "desktop": DESKTOP_MAX_GLIBC}
DEFAULT_CHANNEL = "cross"

# The runner label the desktop workflows' Linux cell must name. The
# release matrix expresses the same constraint as `cross: true`; here it
# is a pinned runner, because the build needs the host's webkit2gtk.
DESKTOP_LINUX_RUNNER = "ubuntu-22.04"

# How many offending imports to name in the failure message.
MAX_REPORTED_SYMBOLS = 6

GLIBC_VERSION_RE = re.compile(r"GLIBC_(\d+)\.(\d+)(?:\.(\d+))?")
# `readelf --dyn-syms` prints undefined imports as `name@GLIBC_x.y (N)`.
VERSIONED_SYMBOL_RE = re.compile(r"(\S+)@(GLIBC_\d+\.\d+(?:\.\d+)?)")


def parse_glibc_version(text: str) -> tuple[int, ...]:
    """Turn `GLIBC_2.3.4` into `(2, 3, 4)`."""
    match = GLIBC_VERSION_RE.fullmatch(text)
    if match is None:
        raise ValueError(f"not a glibc version: {text!r}")
    return tuple(int(part) for part in match.groups() if part is not None)


def glibc_versions(readelf_output: str) -> set[str]:
    """Every `GLIBC_x.y` token mentioned anywhere in `readelf` output."""
    return {match.group(0) for match in GLIBC_VERSION_RE.finditer(readelf_output)}


def symbols_above(readelf_output: str, ceiling: tuple[int, ...]) -> list[str]:
    """`symbol@GLIBC_x.y` pairs that require a glibc newer than `ceiling`.

    Both the weak and the global imports matter: the loader rejects a
    binary whose `.gnu.version_r` names a version the host glibc does not
    define, regardless of whether the symbols bound to that version are
    weak.
    """
    offenders = set()
    for match in VERSIONED_SYMBOL_RE.finditer(readelf_output):
        if parse_glibc_version(match.group(2)) > ceiling:
            offenders.add(f"{match.group(1)}@{match.group(2)}")
    return sorted(offenders)


def read_symbol_versions(binary: Path) -> str:
    """Dump the dynamic symbol table and version-requirement sections.

    `readelf` reads any ELF regardless of its architecture, so a single
    x86_64 runner can check the aarch64 artifacts too.
    """
    readelf = shutil.which("readelf")
    if readelf is None:
        raise SystemExit("readelf not found; install binutils")
    result = subprocess.run(
        [readelf, "--wide", "--dyn-syms", "--version-info", str(binary)],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise SystemExit(f"readelf failed on {binary}: {result.stderr.strip()}")
    return result.stdout


# --------------------------------------------------------------- binary mode


def check_binaries(
    target: str, binaries: list[Path], ceiling: tuple[int, ...] = MAX_GLIBC
) -> list[str]:
    """Return one error string per binary that violates the contract."""
    errors = []
    for binary in binaries:
        output = read_symbol_versions(binary)
        versions = glibc_versions(output)

        if "-linux-musl" in target:
            if versions:
                errors.append(
                    f"{binary}: musl target references glibc "
                    f"({', '.join(sorted(versions))}) — the archive is "
                    f"advertised as statically linked"
                )
            continue

        if "-linux-gnu" not in target:
            continue

        if not versions:
            continue
        highest = max(versions, key=parse_glibc_version)
        if parse_glibc_version(highest) <= ceiling:
            continue
        # Gate on the highest version *referenced* rather than on the
        # offending imports alone: the loader rejects the binary over the
        # `.gnu.version_r` entry, which can outlive the import that
        # introduced it.
        offenders = symbols_above(output, ceiling)
        # A binary built against a modern sysroot trips dozens of these;
        # a handful is enough to identify the cause, and the full list
        # buries the version number that actually matters.
        shown = offenders[:MAX_REPORTED_SYMBOLS]
        detail = ", ".join(shown) if shown else "(no named imports)"
        if len(offenders) > len(shown):
            detail += f", +{len(offenders) - len(shown)} more"
        declared = ".".join(str(part) for part in ceiling)
        errors.append(
            f"{binary}: requires {highest}, above the declared floor "
            f"GLIBC_{declared} — will not start on any host below it. "
            f"Offending imports: {detail}"
        )
    return errors


# ------------------------------------------------------------- workflow mode


def parse_matrix_targets(
    workflow_text: str, first_key: str = "target"
) -> list[dict[str, str]]:
    """Extract a build matrix's entries.

    `first_key` is the key each list item starts with — `target` in
    `release.yml`'s `include:` block, `label` in the desktop workflows'
    `platform:` block. Everything indented below it until the next
    dedent joins the same entry.

    Deliberately a line scanner rather than a YAML parse: every other
    workflow checker in `scripts/` sticks to the standard library, and
    the block this reads is a flat list of scalar keys.
    """
    entries: list[dict[str, str]] = []
    entry_indent: int | None = None
    item_re = re.compile(rf"-\s+{re.escape(first_key)}:\s*(\S+)")
    for raw in workflow_text.splitlines():
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        indent = len(raw) - len(raw.lstrip())
        item = item_re.match(raw.strip())
        if item is not None:
            entry_indent = indent
            entries.append({first_key: item.group(1)})
            continue
        if entry_indent is None:
            continue
        if indent <= entry_indent:
            # Dedented back out of the include: block.
            entry_indent = None
            continue
        key = re.match(r"(\w+):\s*(\S+)", raw.strip())
        if key is not None:
            entries[-1][key.group(1)] = key.group(2)
    return entries


def check_workflow(workflow_text: str) -> list[str]:
    """Return one error string per Linux target that does not use `cross`."""
    entries = parse_matrix_targets(workflow_text)
    if not entries:
        return [f"{RELEASE_WORKFLOW}: no `- target:` entries found in the build matrix"]

    errors = []
    for entry in entries:
        target = entry["target"]
        if "-linux-" not in target:
            continue
        if entry.get("cross") != "true":
            errors.append(
                f"{RELEASE_WORKFLOW}: `{target}` is missing `cross: true`. "
                f"Without it the binary is linked against the runner's glibc "
                f"and will not start on older distributions."
            )
    return errors


def check_desktop_workflow(workflow_text: str, workflow: Path) -> list[str]:
    """Return one error string per desktop Linux cell on the wrong runner.

    The desktop equivalent of `cross: true`. A Tauri bundle links the
    build host's webkit2gtk and GTK, so the floor is set by the runner
    label rather than by a container: `ubuntu-latest` is an alias that
    moves with GitHub's image promotions, and moving it is invisible in
    the diff of the workflow that inherits the newer glibc.
    """
    entries = parse_matrix_targets(workflow_text, first_key="label")
    if not entries:
        return [f"{workflow}: no `- label:` entries found in the build matrix"]

    errors = []
    for entry in entries:
        target = entry.get("target", "")
        if "-linux-" not in target:
            continue
        runner = entry.get("runner")
        if runner != DESKTOP_LINUX_RUNNER:
            floor = ".".join(str(part) for part in DESKTOP_MAX_GLIBC)
            errors.append(
                f"{workflow}: `{target}` runs on `{runner}`, not "
                f"`{DESKTOP_LINUX_RUNNER}`. The executable links against that "
                f"runner's glibc and the AppImage bundles that runner's system "
                f"libraries, so any newer host raises the floor above "
                f"GLIBC_{floor} and the bundles stop starting on Ubuntu 22.04 "
                f"and Debian 12."
            )
    return errors


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--target",
        help="target triple of the binaries being checked (enables binary mode)",
    )
    parser.add_argument(
        "--channel",
        choices=sorted(CHANNEL_FLOORS),
        default=DEFAULT_CHANNEL,
        help=(
            "which support floor the binaries are held to: `cross` "
            "(CLI archives and language bindings) or `desktop` (Tauri bundles)"
        ),
    )
    parser.add_argument(
        "binaries",
        nargs="*",
        type=Path,
        help="binaries to inspect; requires --target",
    )
    args = parser.parse_args(argv)

    if bool(args.target) != bool(args.binaries):
        parser.error("--target and the binary list must be given together")
    if args.channel != DEFAULT_CHANNEL and not args.target:
        parser.error("--channel selects a floor for binary mode; pass --target too")

    if args.target:
        errors = check_binaries(args.target, args.binaries, CHANNEL_FLOORS[args.channel])
        subject = f"{args.channel} {args.target} binaries"
    else:
        errors = check_workflow((REPO_ROOT / RELEASE_WORKFLOW).read_text(encoding="utf-8"))
        for workflow in DESKTOP_WORKFLOWS:
            errors += check_desktop_workflow(
                (REPO_ROOT / workflow).read_text(encoding="utf-8"), workflow
            )
        subject = ", ".join(str(path) for path in (RELEASE_WORKFLOW, *DESKTOP_WORKFLOWS))

    if errors:
        for error in errors:
            print(f"ERROR: {error}", file=sys.stderr)
        return 1

    print(f"OK: {subject} respect the declared glibc floor")
    return 0


if __name__ == "__main__":
    sys.exit(main())
