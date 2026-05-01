#!/usr/bin/env python3
"""Re-extracts the SMuFL glyph data baked into
`crates/render-ireal/src/bravura.rs`.

Run this only when upgrading to a newer Bravura release; commit the
refreshed `bravura.rs` constants alongside any new font version.

Usage:

    pip install fonttools  # one-time
    python3 scripts/extract-bravura-paths.py

The output goes to stdout in a format compatible with the constants
defined in `crates/render-ireal/src/bravura.rs`. The script downloads
the upstream Bravura.otf each invocation; pass `--source PATH` to use
a local file instead.

ADR-0014 (`docs/adr/0014-bravura-glyphs-as-svg-paths.md`) records why
the renderer bakes path data instead of bundling the font. Re-extract
into the existing `bravura.rs` constants by hand — the file carries
documentation around the path strings that this script does not
emit.
"""

from __future__ import annotations

import argparse
import sys
import urllib.request
from pathlib import Path

try:
    from fontTools.pens.boundsPen import BoundsPen
    from fontTools.pens.svgPathPen import SVGPathPen
    from fontTools.ttLib import TTFont
except ImportError:
    print(
        "fontTools is required: pip install fonttools",
        file=sys.stderr,
    )
    sys.exit(1)

UPSTREAM_URL = (
    "https://raw.githubusercontent.com/"
    "steinbergmedia/bravura/master/redist/otf/Bravura.otf"
)

GLYPHS = [
    ("SEGNO", 0xE047),
    ("CODA", 0xE048),
]


def fetch(source: str | None) -> bytes:
    if source:
        return Path(source).read_bytes()
    with urllib.request.urlopen(UPSTREAM_URL) as response:
        return response.read()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--source",
        help="local path to Bravura.otf (default: download upstream)",
    )
    args = parser.parse_args()

    raw = fetch(args.source)
    tmp_path = Path("Bravura.tmp.otf")
    tmp_path.write_bytes(raw)
    try:
        font = TTFont(tmp_path)
    finally:
        tmp_path.unlink(missing_ok=True)

    cmap = font.getBestCmap()
    glyph_set = font.getGlyphSet()
    upem = font["head"].unitsPerEm

    print(f"// Re-emit into crates/render-ireal/src/bravura.rs")
    print(f"// upem = {upem}")
    print()

    for label, codepoint in GLYPHS:
        glyph_name = cmap[codepoint]
        glyph = glyph_set[glyph_name]
        path_pen = SVGPathPen(glyph_set)
        glyph.draw(path_pen)
        bounds_pen = BoundsPen(glyph_set)
        glyph.draw(bounds_pen)
        bounds = bounds_pen.bounds
        if bounds is None:
            print(
                f"// !! {label}: empty bounds — glyph missing from font?",
                file=sys.stderr,
            )
            continue
        cx = (bounds[0] + bounds[2]) / 2
        cy = (bounds[1] + bounds[3]) / 2
        path_d = path_pen.getCommands()
        print(f"// {label} (U+{codepoint:04X})")
        print(f"//   advance = {glyph.width}")
        print(f"//   bounds  = {bounds}")
        print(f"//   center  = ({cx}, {cy})")
        # Bravura's outlines never contain a `\` or `"`, so embedding the
        # raw path string in a Rust `&str` literal is safe without any
        # additional escaping. If that ever changes, this assertion will
        # catch it before we emit a malformed Rust constant.
        assert "\\" not in path_d and '"' not in path_d, path_d
        print(f'const {label}_PATH_D: &str = "{path_d}";')
        print()

    return 0


if __name__ == "__main__":
    sys.exit(main())
