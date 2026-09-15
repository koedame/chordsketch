"""ChordPro file format parser and renderer."""

# Re-export exactly what the UniFFI-generated module declares public, so a
# function added to `crates/ffi/src/chordsketch.udl` is reachable from
# `import chordsketch` without a second hand-maintained list here. A
# hand-maintained list drifted: 22 of the 36 generated names (every
# `*_with_warnings` variant, the chord-diagram and pitch helpers, ...)
# were documented in the README but raised AttributeError.
from chordsketch._native import chordsketch as _generated
from chordsketch._native.chordsketch import *  # noqa: F401,F403

__all__ = []
__all__ += _generated.__all__
