#!/usr/bin/env bash
# Generate the UniFFI Ruby bindings into packages/ruby/lib/chordsketch_uniffi.rb.
#
# Usage: packages/ruby/scripts/generate-bindings.sh <libchordsketch_ffi>
#   <libchordsketch_ffi>: a built chordsketch-ffi shared library to read
#                         the UniFFI metadata from
#
# Run by ruby.yml's `generate-and-test` job and by publishable.yml, so the
# bindings a pull request checks are generated the way the release
# generates them.
#
# The generated file loads the native library by name; the gem ships one
# library per platform, so its `ffi_lib` line is rewritten to the path
# `lib/chordsketch.rb` resolves for the running platform.

set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "Usage: $0 <libchordsketch_ffi>" >&2
  exit 2
fi

LIBRARY="$1"
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
OUT=$(mktemp -d)
trap 'rm -rf "$OUT"' EXIT

(cd "$ROOT" && cargo run -p chordsketch-ffi --bin uniffi-bindgen generate \
  --library "$LIBRARY" \
  --language ruby \
  --out-dir "$OUT")

python3 - "$OUT/chordsketch.rb" <<'PYTHON'
import re, sys
path = sys.argv[1]
with open(path) as f:
    content = f.read()
pat = re.compile(
    r'^([ \t]*)ffi_lib[ \t]+[\'"][^\'"]*chordsketch_ffi[^\'"]*[\'"][ \t]*$',
    re.MULTILINE,
)
m = pat.search(content)
if not m:
    sys.stderr.write(
        "ERROR: could not find ffi_lib line for chordsketch_ffi.\n"
        "Lines mentioning ffi_lib in the generated file:\n"
    )
    for i, line in enumerate(content.splitlines(), 1):
        if "ffi_lib" in line:
            sys.stderr.write(f"  {i}: {line!r}\n")
    sys.exit(1)
new_content, n = pat.subn(r"\1ffi_lib Chordsketch::NATIVE_LIB_PATH", content)
if n != 1:
    sys.stderr.write(f"ERROR: expected exactly 1 ffi_lib substitution, got {n}\n")
    sys.exit(1)
with open(path, "w") as f:
    f.write(new_content)
print(f"OK: rewrote 1 ffi_lib line in {path} (matched line was: {m.group(0)!r})")
PYTHON

mv "$OUT/chordsketch.rb" "$ROOT/packages/ruby/lib/chordsketch_uniffi.rb"
