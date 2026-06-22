#!/usr/bin/env python3
"""Re-extracts the SMuFL glyph data baked into the renderers.

The same pinned Bravura.otf feeds three sister sites, selected with
`--target`:

| `--target` | Output | Consumed by | Glyphs |
|------------|--------|-------------|--------|
| `ireal` (default) | Rust constants | `crates/render-ireal/src/bravura.rs` | segno, coda, fermata |
| `html` | Rust constants | `crates/render-html/src/bravura.rs` | gClef, sharp, flat |
| `react` | TypeScript constants | `packages/react/src/bravura-glyphs.ts` | gClef, sharp, flat, noteheadBlack |

Run this only when upgrading to a newer Bravura release; commit the
refreshed sister files alongside any new font version.

Usage:

    pip install fonttools  # one-time
    python3 scripts/extract-bravura-paths.py                 # ireal (Rust)
    python3 scripts/extract-bravura-paths.py --target html   # render-html (Rust)
    python3 scripts/extract-bravura-paths.py --target react  # @chordsketch/react (TS)

The output goes to stdout in a format compatible with the constants
defined in the matching sister file. The script downloads a
commit-pinned upstream Bravura.otf each invocation; pass
`--source PATH` to use a local file instead.

Upgrading Bravura: bump `PINNED_COMMIT` and `EXPECTED_SHA256` together
to the new release's commit + Bravura.otf hash, re-run each
`--target`, transcribe the resulting blocks into their sister files,
and update ADR-0014's "Watch signals" section if the visual output
shifts noticeably.

ADR-0014 (`docs/adr/0014-bravura-glyphs-as-svg-paths.md`) records why
the renderers bake path data instead of bundling the font.
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

# Glyph sets per `--target`. The codepoints are the SMuFL canonical
# assignments (https://www.smufl.org/version/latest/).
GLYPH_SETS = {
    "ireal": [
        ("SEGNO", 0xE047),
        ("CODA", 0xE048),
        ("FERMATA", 0xE4C0),
    ],
    "html": [
        ("GCLEF", 0xE050),
        ("ACCIDENTAL_SHARP", 0xE262),
        ("ACCIDENTAL_FLAT", 0xE260),
    ],
    "react": [
        ("GCLEF", 0xE050),
        ("ACCIDENTAL_SHARP", 0xE262),
        ("ACCIDENTAL_FLAT", 0xE260),
        ("NOTEHEAD_BLACK", 0xE0A4),
    ],
}


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


def num(value: float) -> str:
    """Render a font-unit measure with no spurious trailing `.0` so
    integer-valued coordinates stay integers in the emitted source."""
    return str(int(value)) if value == int(value) else str(value)


def fnum(value: float) -> str:
    """Render a font-unit measure as a Rust `f32` literal — integer
    values keep an explicit `.0` so the field type is unambiguous."""
    return f"{int(value)}.0" if value == int(value) else str(value)


def main() -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Extract Bravura SMuFL glyph paths into the sister-site "
            "constants. Select the destination with --target."
        ),
    )
    parser.add_argument(
        "--target",
        choices=sorted(GLYPH_SETS),
        default="ireal",
        help="which sister site to emit for (default: ireal)",
    )
    parser.add_argument(
        "--source",
        help="local path to Bravura.otf (default: download upstream)",
    )
    args = parser.parse_args()
    glyphs = GLYPH_SETS[args.target]

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

    dest = {
        "ireal": "crates/render-ireal/src/bravura.rs",
        "html": "crates/render-html/src/bravura.rs",
        "react": "packages/react/src/bravura-glyphs.ts",
    }[args.target]
    emit_ts = args.target == "react"
    print(f"// Re-emit into {dest}")
    print(f"// upem = {upem}")
    print(f"// pinned commit = {PINNED_COMMIT}")
    print()

    # Track partial success: a glyph that is absent from the font
    # (e.g. a future Bravura release that drops a codepoint) must
    # surface as a non-zero exit so the operator does not
    # accidentally redirect a partial extraction over the sister
    # file via shell redirect.
    ok = True
    for label, codepoint in glyphs:
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
        # character that breaks the embedded string literal or the
        # ASCII-only invariant the byte-slicing call sites rely on.
        if "\\" in path_d or '"' in path_d or not path_d.isascii():
            print(
                f"unexpected character in {label} path data; cannot "
                f"emit safely: {path_d!r}",
                file=sys.stderr,
            )
            return 3
        if emit_ts:
            # TypeScript object literal consumed by
            # `packages/react/src/bravura-glyphs.ts`'s `BravuraGlyph`
            # records. Font units, OpenType +Y up convention.
            print(f"// {label} (U+{codepoint:04X})")
            print(f"export const {label}: BravuraGlyph = {{")
            print(f"  advance: {num(glyph.width)},")
            print(
                f"  bbox: {{ minX: {num(bounds[0])}, minY: {num(bounds[1])}, "
                f"maxX: {num(bounds[2])}, maxY: {num(bounds[3])} }},"
            )
            print(f"  cx: {num(cx)},")
            print(f"  cy: {num(cy)},")
            print(f"  d: '{path_d}',")
            print("};")
            print()
        elif args.target == "html":
            # Rust struct literal consumed by
            # `crates/render-html/src/bravura.rs`'s `BravuraGlyph`
            # records. The HTML key-signature glyph needs only the
            # advance + path; bbox / center are TS-only (see the
            # react target). Font units, OpenType +Y up convention.
            print(f"// {label} (U+{codepoint:04X})")
            print(f"pub(crate) const {label}: BravuraGlyph = BravuraGlyph {{")
            print(f"    advance: {fnum(glyph.width)},")
            print(f'    d: "{path_d}",')
            print("};")
            print()
        else:
            # Flat `pub(crate) const` form consumed by
            # `crates/render-ireal/src/bravura.rs`.
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
