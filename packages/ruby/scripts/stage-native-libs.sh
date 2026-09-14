#!/usr/bin/env bash
# Move the downloaded native libraries into the per-platform directories
# `lib/chordsketch.rb` loads them from.
#
# Usage: packages/ruby/scripts/stage-native-libs.sh <artifacts-dir>
#   <artifacts-dir>: holds one `native-<rust-target>/` directory per target
#                    (the layout `actions/download-artifact` gives ruby.yml's
#                    build artifacts)
#
# Run by ruby.yml's `publish` job and by publishable.yml, so the gem a pull
# request checks is laid out the way the released gem is.

set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "Usage: $0 <artifacts-dir>" >&2
  exit 2
fi

ARTIFACTS=$(cd "$1" && pwd)
LIB=$(cd "$(dirname "$0")/../lib" && pwd)

declare -A TARGET_TO_PLATFORM=(
  [x86_64-unknown-linux-gnu]=x86_64-linux
  [aarch64-unknown-linux-gnu]=aarch64-linux
  [aarch64-apple-darwin]=aarch64-darwin
  [x86_64-apple-darwin]=x86_64-darwin
  [x86_64-pc-windows-msvc]=x86_64-windows
)

for target in "${!TARGET_TO_PLATFORM[@]}"; do
  src="$ARTIFACTS/native-${target}"
  dst="$LIB/${TARGET_TO_PLATFORM[$target]}"
  if ! compgen -G "$src/*" > /dev/null; then
    echo "::error::no native library in $src; the build failed for $target" >&2
    exit 1
  fi
  mkdir -p "$dst"
  cp "$src"/* "$dst/"
done
find "$LIB" -type f | sort
