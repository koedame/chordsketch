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
a commit-pinned upstream Bravura.otf each invocation; pass
`--source PATH` to use a local file instead.

Upgrading Bravura: bump `PINNED_COMMIT` and `EXPECTED_SHA256` together
to the new release's commit + Bravura.otf hash, re-run, transcribe
the resulting block into `crates/render-ireal/src/bravura.rs`, and
update ADR-0014's "Watch signals" section if the visual output
shifts noticeably.

ADR-0014 (`docs/adr/0014-bravura-glyphs-as-svg-paths.md`) records why
the renderer bakes path data instead of bundling the font.
"""

from __future__ import annotations

import argparse
import hashlib
import sys
import tempfile
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

# Pin to a specific Bravura release commit so re-extractions are
# bit-reproducible across runs and a compromised steinbergmedia
# `master` cannot silently inject altered glyph data. Update the
# pair below in lockstep when intentionally upgrading Bravura.
PINNED_COMMIT = "02e8ed29a29115df35007d1178cebaeee26c20e1"
EXPECTED_SHA256 = (
    "dca2d90c88437a701b1c2e71fa54e76f9fa41d7deee935d74dc871ea66ecfdd2"
)
UPSTREAM_URL = (
    "https://raw.githubusercontent.com/"
    f"steinbergmedia/bravura/{PINNED_COMMIT}/redist/otf/Bravura.otf"
)

GLYPHS = [
    ("SEGNO", 0xE047),
    ("CODA", 0xE048),
    ("FERMATA", 0xE4C0),
]


def fetch(source: str | None) -> bytes:
    if source:
        return Path(source).read_bytes()
    with urllib.request.urlopen(UPSTREAM_URL) as response:
        return response.read()


def emit_center_constant(label: str, axis: str, value: float) -> str:
    """Returns a Rust `pub(crate) const` declaration whose type is
    chosen by whether `value` is integer-valued. Bbox midpoints are
    `(min + max) / 2`; if `min + max` is even the midpoint is an
    integer and we want `i32`, otherwise the half-unit must survive
    as `f32` (rounding to `i32` would shift the glyph by half a font
    unit, ~0.009 SVG units, breaking byte-stable goldens)."""
    name = f"{label}_FONT_C{axis}"
    if value == int(value):
        return f"pub(crate) const {name}: i32 = {int(value)};"
    return f"pub(crate) const {name}: f32 = {value};"


def main() -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Extract Bravura SMuFL glyph paths into the constants used "
            "by crates/render-ireal/src/bravura.rs."
        ),
    )
    parser.add_argument(
        "--source",
        help="local path to Bravura.otf (default: download upstream)",
    )
    args = parser.parse_args()

    raw = fetch(args.source)

    # Verify SHA-256 only on the network path. Local --source files
    # are typically used during ad-hoc testing where the maintainer
    # picks the bytes themselves; mismatching there is not a
    # supply-chain issue.
    if not args.source:
        digest = hashlib.sha256(raw).hexdigest()
        if digest != EXPECTED_SHA256:
            print(
                f"Bravura.otf SHA-256 mismatch:\n"
                f"  got:      {digest}\n"
                f"  expected: {EXPECTED_SHA256}\n"
                f"  pinned commit: {PINNED_COMMIT}\n"
                f"Refusing to extract — bump PINNED_COMMIT/"
                f"EXPECTED_SHA256 together if this is intentional.",
                file=sys.stderr,
            )
            return 2

    # Use a NamedTemporaryFile in $TMPDIR (atomic creation, no
    # CWD overwrite hazard, no leak into a stray `git add .`).
    with tempfile.NamedTemporaryFile(suffix=".otf", delete=False) as tmp:
        tmp.write(raw)
        tmp_path = Path(tmp.name)
    try:
        font = TTFont(tmp_path)
    finally:
        tmp_path.unlink(missing_ok=True)

    cmap = font.getBestCmap()
    glyph_set = font.getGlyphSet()
    upem = font["head"].unitsPerEm

    print(f"// Re-emit into crates/render-ireal/src/bravura.rs")
    print(f"// upem = {upem}")
    print(f"// pinned commit = {PINNED_COMMIT}")
    print()

    # Track partial success: a glyph that is absent from the font
    # (e.g. a future Bravura release that drops a codepoint) must
    # surface as a non-zero exit so the operator does not
    # accidentally redirect a partial extraction over `bravura.rs`
    # via shell redirect.
    ok = True
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
            ok = False
            continue
        cx = (bounds[0] + bounds[2]) / 2
        cy = (bounds[1] + bounds[3]) / 2
        path_d = path_pen.getCommands()
        # Fail loudly (rather than via `assert`, which is stripped
        # under `python -O`) if the path data ever picks up a
        # character that breaks `&str` literal embedding or the
        # ASCII-only invariant the call sites in `music_symbols.rs`
        # rely on for byte-slicing.
        if "\\" in path_d or '"' in path_d or not path_d.isascii():
            print(
                f"unexpected character in {label} path data; cannot "
                f"emit safely: {path_d!r}",
                file=sys.stderr,
            )
            return 3
        print(f"// {label} (U+{codepoint:04X})")
        print(f"//   advance = {glyph.width}")
        print(f"//   bounds  = {bounds}")
        print(f"//   center  = ({cx}, {cy})")
        print(emit_center_constant(label, "X", cx))
        print(emit_center_constant(label, "Y", cy))
        print(f'pub(crate) const {label}_PATH_D: &str = "{path_d}";')
        print()

    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
