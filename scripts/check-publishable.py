#!/usr/bin/env python3
"""Fail when a package this repository publishes could not be published.

    python3 scripts/check-publishable.py crates-io
    python3 scripts/check-publishable.py npm --package @chordsketch/wasm
    python3 scripts/check-publishable.py napi --tarballs release-staging

Run by `.github/workflows/publishable.yml` on every pull request, every
push to `main` and nightly. The conditions, and the reason each exists, are
in `docs/publishing-requirements.md`; the checks themselves live in
`scripts/_publish_checks.py`, which `scripts/release.py` runs too, so a
release is held to exactly what every pull request was held to.

Subcommands:

  crates-io   `cargo publish --dry-run` over every published crate together,
              then the packaged size, metadata and contents of each.
  npm         Build, pack, `npm publish --dry-run` and smoke-install one npm
              package (`--package`), or every one that is not a napi package.
  napi        Check the `@chordsketch/node` resolver and platform tarballs that
              `crates/napi/scripts/stage-release-tarballs.sh` staged.
  npm-matrix  Print the non-napi npm packages as a JSON job matrix, so the
              workflow's matrix is read from the same definition.

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
    args = parser.parse_args(argv)

    if args.command == "npm-matrix":
        packages = [p for name, p in checks.NPM_PACKAGES.items() if not checks.is_napi(name)]
        print(json.dumps([{"package": p.name, "tools": list(p.tools)} for p in packages]))
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
    else:
        version = json.loads((tree / checks.NPM_PACKAGES[checks.NAPI_PACKAGE].directory / "package.json").read_text())["version"]
        problems = checks.napi_problems(args.tarballs.resolve(), version, checks.repo_npm_versions(tree))

    if problems:
        print(f"\n{len(problems)} problem(s) would stop this from being published:", file=sys.stderr)
        for problem in problems:
            print(f"  - {problem}", file=sys.stderr)
        return 1
    print("\nPublishable.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
