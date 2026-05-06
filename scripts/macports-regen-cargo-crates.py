#!/usr/bin/env python3
"""Regenerate the `cargo.crates` block of `packaging/macports/Portfile`.

MacPorts' canonical regenerator is `cargo2port.py`, which ships with a
local MacPorts install. This script is an in-tree pure-Python
alternative so a non-Mac contributor (CI agent, Linux dev) can refresh
the block without installing MacPorts. The output format matches
`cargo2port.py`'s contract:

    cargo.crates \\
        crate_name version checksum \\
        ...

A `[[package]]` block in `Cargo.lock` is included only when it carries
a `checksum =` line — workspace-local crates have no checksum (their
source is `path = ...` rather than `registry+...`) and the cargo
portgroup expects them to be excluded.

By default `Cargo.lock` is read from the **tag the Portfile points
at** — the version in the Portfile's `github.setup` line, resolved as
`v<VERSION>` via `git show v<VERSION>:Cargo.lock`. This is the
invariant the cargo portgroup actually needs, because every crate
listed in `cargo.crates` is checksummed against the lockfile shipped
inside the source tarball. Reading HEAD's Cargo.lock instead silently
allowed Portfile/tarball drift, surfacing only at upstream build time
as "checksum mismatch on <crate>". See `docs/adr/0012-macports-
portfile-cargo-crates-tag-relative.md` for the full rationale.

Override with `--from-ref REF` (any git revision, e.g. `HEAD`) when
preparing a Portfile bump for a release that has not been tagged yet.

`--check` carries one graceful behaviour the other commands do not:
when the tag is auto-resolved from the Portfile and that tag does
not yet exist (i.e. a release-cut PR has bumped `github.setup` to
the new version but the corresponding `vX.Y.Z` tag is created only
post-merge), the check **falls back to comparing against
`HEAD:Cargo.lock`** with a clear advisory note on stderr. This
keeps the in-PR signal useful (the `cargo.crates` block must still
match SOMETHING coherent — HEAD if the tag is unavailable) without
forcing the maintainer to revert their Portfile bump out of the
release-cut PR. After the tag is pushed, the next normal CI run
validates against the real tagged `Cargo.lock` per the original
invariant. See ADR-0012 §"Release-cut window" and #2413 for the
rationale.

The fallback is intentionally scoped to `--check` with an
auto-resolved tag. If the caller explicitly passes `--from-ref REF`
and `REF` does not exist, the script still fails — explicit
user intent is preserved.

Usage:
    # Print the cargo.crates block we would generate from the
    # Portfile's tagged Cargo.lock
    python3 scripts/macports-regen-cargo-crates.py

    # Update the Portfile in place (rewrites everything between
    # `cargo.crates \\` and the next blank line — same boundaries
    # `cargo2port.py` writes)
    python3 scripts/macports-regen-cargo-crates.py --apply

    # Verify the Portfile matches the tagged Cargo.lock; exits
    # non-zero on drift. The `macports-portfile-sync` CI guard runs
    # this on every PR. Falls back to HEAD when the auto-resolved
    # tag does not yet exist (release-cut window).
    python3 scripts/macports-regen-cargo-crates.py --check

    # Pre-tag refresh: regenerate from a not-yet-tagged ref.
    python3 scripts/macports-regen-cargo-crates.py --apply --from-ref HEAD
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
PORTFILE = REPO_ROOT / "packaging" / "macports" / "Portfile"

# Captured version must start with a digit and only carry semver-ish
# characters. `\S+` would match anything non-whitespace, including
# strings starting with `-` that `git show` could mis-parse as flags.
GITHUB_SETUP_RE = re.compile(
    r"^github\.setup\s+koedame\s+chordsketch\s+([0-9][0-9A-Za-z.+\-]*)\s+v\s*$",
    re.M,
)


def portfile_tag() -> str:
    """Resolve the Portfile's `github.setup` version into a `vX.Y.Z` tag."""
    text = PORTFILE.read_text(encoding="utf-8")
    m = GITHUB_SETUP_RE.search(text)
    if not m:
        raise SystemExit(
            f"could not parse `github.setup koedame chordsketch <VERSION> v` "
            f"from {PORTFILE.relative_to(REPO_ROOT)}"
        )
    return f"v{m.group(1)}"


class GitRefMissingError(Exception):
    """Raised when `git show <ref>:<path>` fails because `<ref>` does not exist.

    Distinct from generic `git show` failures so callers can choose to
    handle "tag not yet created" specifically (see `cmd_check`'s
    release-cut fallback) without swallowing other git errors.
    """

    def __init__(self, ref: str, stderr: str) -> None:
        super().__init__(f"git ref does not exist: {ref!r} ({stderr})")
        self.ref = ref
        self.stderr = stderr


def read_cargo_lock(from_ref: str) -> str:
    """Return the contents of `Cargo.lock` at the given git revision.

    Raises `GitRefMissingError` if `from_ref` does not resolve to any
    object reachable from the local repository. Other failure modes
    (git not installed, permission errors, missing `Cargo.lock` at
    the resolved ref) raise `SystemExit` with a descriptive message.
    """
    # Defense-in-depth: refuse refs that could be mis-parsed by `git
    # show` as a flag. `git show` does not provide a `--` separator
    # for revisions, so the only safe form is to validate the
    # caller-supplied value.
    if from_ref.startswith("-"):
        raise SystemExit(
            f"refusing to use git ref starting with '-': {from_ref!r} "
            "(would be parsed by `git show` as a command-line option)"
        )
    try:
        result = subprocess.run(
            ["git", "show", f"{from_ref}:Cargo.lock"],
            cwd=REPO_ROOT,
            capture_output=True,
            check=True,
            text=True,
        )
    except FileNotFoundError as exc:
        raise SystemExit(f"git is required but not on PATH: {exc}") from exc
    except subprocess.CalledProcessError as exc:
        stderr = exc.stderr.strip()
        # `git show <missing-ref>:<path>` emits one of:
        #   fatal: invalid object name '<ref>'.
        #   fatal: bad revision '<ref>'.
        # depending on what kind of name was passed. Both indicate the
        # ref itself is unreachable, which is the case the release-cut
        # fallback in `cmd_check` wants to detect specifically. Any
        # other CalledProcessError (e.g. ref exists but lacks a
        # `Cargo.lock` at that revision) stays a hard error.
        marker_invalid_ref = (
            "invalid object name" in stderr.lower()
            or "bad revision" in stderr.lower()
        )
        if marker_invalid_ref:
            raise GitRefMissingError(from_ref, stderr) from exc
        raise SystemExit(
            f"git show {from_ref}:Cargo.lock failed (exit {exc.returncode}): "
            f"{stderr}"
        ) from exc
    return result.stdout


def parse_cargo_lock(text: str) -> list[tuple[str, str, str]]:
    blocks = re.split(r"\n\[\[package\]\]\n", text)
    crates: list[tuple[str, str, str]] = []
    for block in blocks:
        name_m = re.search(r'^name = "([^"]+)"', block, re.M)
        ver_m = re.search(r'^version = "([^"]+)"', block, re.M)
        sum_m = re.search(r'^checksum = "([^"]+)"', block, re.M)
        if name_m and ver_m and sum_m:
            crates.append((name_m.group(1), ver_m.group(1), sum_m.group(1)))
    crates.sort()
    return crates


def render_block(crates: list[tuple[str, str, str]]) -> str:
    if not crates:
        return "cargo.crates\n"
    lines = ["cargo.crates \\"]
    for i, (name, ver, checksum) in enumerate(crates):
        suffix = " \\" if i < len(crates) - 1 else ""
        lines.append(f"    {name} {ver} {checksum}{suffix}")
    return "\n".join(lines) + "\n"


def replace_block_in_portfile(portfile_text: str, new_block: str) -> str:
    """Replace the `cargo.crates ...` region in the Portfile with `new_block`.

    The region runs from the `cargo.crates \\` line to the line before
    the next blank line. This matches the layout `cargo2port.py`
    produces and what the in-tree Portfile currently uses.
    """
    lines = portfile_text.splitlines(keepends=True)
    start = None
    end = None
    for i, line in enumerate(lines):
        if start is None and line.startswith("cargo.crates"):
            start = i
            continue
        if start is not None and line.strip() == "":
            end = i
            break
    if start is None:
        raise SystemExit(
            "could not find a line starting with `cargo.crates` in Portfile"
        )
    if end is None:
        raise SystemExit(
            "found `cargo.crates` line in Portfile but no following blank line "
            "— the block must be terminated by a blank line"
        )
    return "".join(lines[:start]) + new_block + "".join(lines[end:])


def cmd_print(from_ref: str) -> int:
    crates = parse_cargo_lock(read_cargo_lock(from_ref))
    sys.stdout.write(render_block(crates))
    return 0


def cmd_apply(from_ref: str) -> int:
    crates = parse_cargo_lock(read_cargo_lock(from_ref))
    new_block = render_block(crates)
    portfile = PORTFILE.read_text(encoding="utf-8")
    updated = replace_block_in_portfile(portfile, new_block)
    if portfile == updated:
        print(f"{PORTFILE.relative_to(REPO_ROOT)} already up to date "
              f"({len(crates)} crates from Cargo.lock@{from_ref}).")
        return 0
    # Write atomically: a temp sibling + Path.replace() guarantees POSIX
    # rename semantics so an interrupted write cannot corrupt the Portfile.
    tmp = PORTFILE.with_suffix(".tmp")
    try:
        tmp.write_text(updated, encoding="utf-8")
        tmp.replace(PORTFILE)
    except Exception:
        tmp.unlink(missing_ok=True)
        raise
    print(
        f"Rewrote {PORTFILE.relative_to(REPO_ROOT)} "
        f"({len(crates)} crates from Cargo.lock@{from_ref})."
    )
    return 0


def cmd_check(from_ref: str, *, allow_tag_fallback: bool) -> int:
    """Verify the Portfile matches `Cargo.lock@from_ref`.

    When `allow_tag_fallback=True` and the auto-resolved tag does not
    yet exist (release-cut window), fall back to comparing against
    `HEAD:Cargo.lock` with an advisory note on stderr instead of
    failing. `--check` invocations without an explicit `--from-ref`
    pass `allow_tag_fallback=True`; explicit refs do not, so user
    intent is preserved.
    """
    effective_ref = from_ref
    try:
        text = read_cargo_lock(from_ref)
    except GitRefMissingError as exc:
        if not allow_tag_fallback:
            sys.stderr.write(
                f"git ref '{exc.ref}' does not exist: {exc.stderr}\n"
            )
            return 1
        sys.stderr.write(
            f"NOTE: tag '{exc.ref}' does not yet exist — assuming this is "
            f"a release-cut PR window (see #2413).\n"
            f"      Falling back to HEAD:Cargo.lock for advisory check; "
            f"the next normal CI run after the tag is pushed will validate "
            f"against the real tagged Cargo.lock.\n"
        )
        effective_ref = "HEAD"
        text = read_cargo_lock(effective_ref)
    crates = parse_cargo_lock(text)
    new_block = render_block(crates)
    portfile = PORTFILE.read_text(encoding="utf-8")
    expected = replace_block_in_portfile(portfile, new_block)
    if portfile == expected:
        return 0
    sys.stderr.write(
        f"{PORTFILE.relative_to(REPO_ROOT)} cargo.crates block drifted from "
        f"Cargo.lock@{effective_ref}.\n"
        "\n"
        f"Refresh with: python3 scripts/macports-regen-cargo-crates.py "
        f"--apply --from-ref {effective_ref}\n"
    )
    return 1


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--apply", action="store_true",
                       help="Rewrite the Portfile in place.")
    group.add_argument("--check", action="store_true",
                       help="Verify the Portfile matches the tagged "
                            "Cargo.lock; exit non-zero on drift.")
    parser.add_argument(
        "--from-ref",
        metavar="REF",
        default=None,
        help="Read Cargo.lock from this git revision (e.g. `HEAD`) via "
             "`git show REF:Cargo.lock`. Defaults to the tag in the "
             "Portfile's `github.setup` line.",
    )
    args = parser.parse_args()

    auto_resolved = args.from_ref is None
    from_ref = args.from_ref if not auto_resolved else portfile_tag()

    if args.apply:
        return cmd_apply(from_ref)
    if args.check:
        # Auto-resolved tag may not yet exist in a release-cut PR; allow
        # graceful fallback to HEAD in that one case (see #2413).
        return cmd_check(from_ref, allow_tag_fallback=auto_resolved)
    return cmd_print(from_ref)


if __name__ == "__main__":
    raise SystemExit(main())
