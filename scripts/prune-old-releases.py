#!/usr/bin/env python3
"""Delete the GitHub Releases older than the one just published.

ChordSketch is pre-1.0, and an old release can carry a vulnerability that
a newcomer would then install, so only the newest release of each tag
family stays on the Releases page (ADR-0091). The two families are the
library / CLI (`v<X.Y.Z>`) and the desktop app (`desktop-v<X.Y.Z>`);
they ship independently, so one family's newest release is never
touched by the other's prune.

What is deleted is the release and its assets. The git tag stays: the
registries (crates.io, the Homebrew `desktop` formula, MacPorts, AUR's
source package) resolve source archives through it.

Selection, given the tag that was just published (`--tag`):

* Only tags of the same family are considered; `beta-channel`-style tags
  and the other family's tags are ignored.
* If a *newer* release of the family exists (a re-run for an old tag),
  nothing is deleted.
* A release older than `--tag` is deleted. When `--tag` is itself a
  prerelease (`-rc.1`), only older prereleases go: publishing a
  prerelease never removes the newest stable release.

Usage: prune-old-releases.py --tag v0.10.0 [--repo OWNER/REPO] [--dry-run]
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from typing import Callable, Optional

TAG_RE = re.compile(
    r"^(?P<family>(?:desktop-)?)v(?P<major>\d+)\.(?P<minor>\d+)\.(?P<patch>\d+)"
    r"(?:-(?P<pre>[0-9A-Za-z.-]+))?$"
)

Runner = Callable[[list[str]], str]


def parse_tag(tag: str) -> Optional[tuple[str, tuple]]:
    """Return `(family, sort_key)` for a release tag, or None if it is not one."""
    m = TAG_RE.match(tag)
    if m is None:
        return None
    pre = m.group("pre")
    # SemVer precedence: a prerelease sorts below its release; numeric
    # identifiers sort below alphanumeric ones and compare as numbers.
    if pre is None:
        pre_key: tuple = (1,)
    else:
        pre_key = (
            0,
            tuple((0, int(p), "") if p.isdigit() else (1, 0, p) for p in pre.split(".")),
        )
    key = (int(m.group("major")), int(m.group("minor")), int(m.group("patch")), pre_key)
    return m.group("family"), key


def is_prerelease(tag: str) -> bool:
    m = TAG_RE.match(tag)
    return m is not None and m.group("pre") is not None


def plan(release_tags: list[str], current: str) -> tuple[list[str], Optional[str]]:
    """Decide what to delete: `(tags_to_delete, reason_for_deleting_nothing)`."""
    parsed_current = parse_tag(current)
    if parsed_current is None:
        raise ValueError(f"not a release tag: {current!r}")
    family, current_key = parsed_current
    if current not in release_tags:
        raise ValueError(f"release {current!r} does not exist; refusing to prune")

    siblings = {
        tag: parsed[1]
        for tag in release_tags
        if (parsed := parse_tag(tag)) is not None and parsed[0] == family and tag != current
    }
    newest = max(siblings, key=siblings.__getitem__, default=None)
    if newest is not None and siblings[newest] > current_key:
        return [], f"{newest} is newer than {current}; {current} is not the newest release"

    stale: list[str] = []
    for tag in siblings:
        if is_prerelease(current) and not is_prerelease(tag):
            continue
        stale.append(tag)
    return sorted(stale, key=siblings.__getitem__), None


def _gh(args: list[str]) -> str:
    return subprocess.run(
        ["gh", *args], check=True, capture_output=True, text=True
    ).stdout


def main(argv: Optional[list[str]] = None, gh: Runner = _gh) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--tag", required=True, help="the release just published, e.g. v0.10.0")
    parser.add_argument("--repo", default="koedame/chordsketch")
    parser.add_argument("--dry-run", action="store_true", help="print the plan, delete nothing")
    args = parser.parse_args(argv)

    listing = json.loads(
        gh(["release", "list", "-R", args.repo, "--limit", "1000", "--json", "tagName"])
    )
    tags = [r["tagName"] for r in listing]
    try:
        stale, reason = plan(tags, args.tag)
    except ValueError as e:
        print(f"::error::{e}", file=sys.stderr)
        return 1
    if reason:
        print(f"::notice::Nothing deleted: {reason}")
        return 0
    if not stale:
        print(f"No release older than {args.tag} to delete.")
        return 0

    failed = 0
    for tag in stale:
        if args.dry_run:
            print(f"would delete release {tag} (tag kept)")
            continue
        try:
            # No `--cleanup-tag`: the git tag must survive.
            gh(["release", "delete", tag, "-R", args.repo, "--yes"])
            print(f"deleted release {tag} (tag kept)")
        except subprocess.CalledProcessError as e:
            failed += 1
            print(f"::error::could not delete release {tag}: {e.stderr}", file=sys.stderr)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
