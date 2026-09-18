#!/usr/bin/env python3
"""Read and rewrite the `chordsketchFFI` binary target in `Package.swift`.

    scripts/swift_package.py show                                  # url and checksum
    scripts/swift_package.py pin --tag v0.8.0 --sha256 <64 hex>    # point it at a release asset
    scripts/swift_package.py use-local --path chordsketchFFI.xcframework

SwiftPM reads `Package.swift` from the repository root of the tag a consumer
resolves, so that file has to name the XCFramework of the release it is
tagged for, checksum included (ADR-0080). `pin` writes the URL and checksum;
`use-local` swaps the remote binary for a locally built XCFramework so
`swift test` can run against a build that is not published yet.

The target is found by counting parentheses, skipping any inside a Swift
string literal, so a URL or checksum containing `)` cannot end it early.

Stdlib only.
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

ASSET = "chordsketch-xcframework.zip"
RELEASE_URL = "https://github.com/koedame/chordsketch/releases/download/"

_HEADER = re.compile(r'\.binaryTarget\(\s*name:\s*"chordsketchFFI"')
_TAG = re.compile(r"v[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?")
_SHA256 = re.compile(r"[0-9a-f]{64}")
_URL_FIELD = re.compile(r'url:\s*"([^"]*)"')
_CHECKSUM_FIELD = re.compile(r'checksum:\s*"([^"]*)"')


class SwiftPackageError(Exception):
    pass


def binary_target_span(text: str) -> tuple[int, int]:
    """Where the `.binaryTarget(...)` for `chordsketchFFI` starts and ends."""
    match = _HEADER.search(text)
    if match is None:
        raise SwiftPackageError("Package.swift has no .binaryTarget for chordsketchFFI")
    depth = 1
    in_string = False
    i = text.index("(", match.start()) + 1
    while i < len(text) and depth > 0:
        ch = text[i]
        if in_string:
            if ch == "\\":
                i += 2
                continue
            if ch == '"':
                in_string = False
        elif ch == '"':
            in_string = True
        elif ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
        i += 1
    if depth != 0:
        raise SwiftPackageError("Package.swift has unbalanced parentheses in the chordsketchFFI .binaryTarget")
    if _HEADER.search(text, i):
        raise SwiftPackageError("Package.swift has more than one .binaryTarget for chordsketchFFI")
    return match.start(), i


def read_pin(text: str) -> tuple[str, str]:
    """The `(url, checksum)` the binary target is pinned to."""
    start, end = binary_target_span(text)
    block = text[start:end]
    url, checksum = _URL_FIELD.search(block), _CHECKSUM_FIELD.search(block)
    if url is None or checksum is None:
        raise SwiftPackageError("the chordsketchFFI .binaryTarget is not a remote one with `url:` and `checksum:`")
    return url.group(1), checksum.group(1)


def asset_url(tag: str) -> str:
    return f"{RELEASE_URL}{tag}/{ASSET}"


def pin(text: str, tag: str, sha256: str) -> str:
    if not _TAG.fullmatch(tag):
        raise SwiftPackageError(f"not a release tag: {tag!r}")
    if not _SHA256.fullmatch(sha256):
        raise SwiftPackageError(f"not a lowercase SHA-256: {sha256!r}")
    return _replace_binary_target(
        text,
        ".binaryTarget(\n"
        '            name: "chordsketchFFI",\n'
        f'            url: "{asset_url(tag)}",\n'
        f'            checksum: "{sha256}"\n'
        "        )",
    )


def use_local(text: str, path: str) -> str:
    return _replace_binary_target(
        text,
        ".binaryTarget(\n"
        '            name: "chordsketchFFI",\n'
        f'            path: "{path}"\n'
        "        )",
    )


def _replace_binary_target(text: str, replacement: str) -> str:
    start, end = binary_target_span(text)
    return text[:start] + replacement + text[end:]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--manifest", type=Path, default=Path("Package.swift"))
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("show")
    pin_parser = commands.add_parser("pin")
    pin_parser.add_argument("--tag", required=True)
    pin_parser.add_argument("--sha256", required=True)
    local_parser = commands.add_parser("use-local")
    local_parser.add_argument("--path", required=True)
    args = parser.parse_args(argv)

    text = args.manifest.read_text()
    try:
        if args.command == "show":
            url, checksum = read_pin(text)
            print(f"{url} {checksum}")
            return 0
        rewritten = pin(text, args.tag, args.sha256) if args.command == "pin" else use_local(text, args.path)
    except SwiftPackageError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    args.manifest.write_text(rewritten)
    return 0


if __name__ == "__main__":
    sys.exit(main())
