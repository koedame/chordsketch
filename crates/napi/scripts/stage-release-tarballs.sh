#!/usr/bin/env bash
# Stage the @chordsketch/node platform packages with their prebuilt
# binaries and pack them, with the resolver package, into npm tarballs.
#
# Usage: crates/napi/scripts/stage-release-tarballs.sh <artifacts-dir> <version> <out-dir>
#   <artifacts-dir>: holds one `napi-<rust-target>/` directory per target,
#                    each with the `.node` file `napi build` produced (the
#                    layout `actions/download-artifact` gives napi.yml's
#                    build artifacts)
#   <version>:       the version every staged package.json must carry
#   <out-dir>:       where the six tarballs are written
#
# napi.yml's `upload-release-tarballs` job runs this at release time and
# uploads the tarballs for crates/napi/scripts/local-publish.sh to publish.
# publishable.yml runs it on every pull request and hands the tarballs to
# `scripts/check-publishable.py napi`, so the staging a release depends on
# is exercised long before a release needs it.
#
# Writes into crates/napi/npm/<triple>/ (the `.node` files are gitignored).

set -euo pipefail

if [ "$#" -ne 3 ]; then
  echo "Usage: $0 <artifacts-dir> <version> <out-dir>" >&2
  exit 2
fi

ARTIFACTS=$(cd "$1" && pwd)
EXPECTED="$2"
mkdir -p "$3"
OUT=$(cd "$3" && pwd)
NAPI_DIR=$(cd "$(dirname "$0")/.." && pwd)

declare -A TARGET_TO_TRIPLE=(
  [x86_64-unknown-linux-gnu]=linux-x64-gnu
  [aarch64-unknown-linux-gnu]=linux-arm64-gnu
  [x86_64-apple-darwin]=darwin-x64
  [aarch64-apple-darwin]=darwin-arm64
  [x86_64-pc-windows-msvc]=win32-x64-msvc
)

# Each `npm/<triple>/package.json` names one `.node` file in `main` and
# `files`. `npm pack` silently leaves out a file that is missing, so a
# target whose artifact is absent or empty must fail here rather than
# produce a package with nothing to load.
for target in "${!TARGET_TO_TRIPLE[@]}"; do
  triple="${TARGET_TO_TRIPLE[$target]}"
  src_dir="$ARTIFACTS/napi-${target}"
  dst="$NAPI_DIR/npm/${triple}/chordsketch-napi.${triple}.node"
  if [ ! -d "$src_dir" ]; then
    echo "::error::artifact directory $src_dir is missing; the build failed for $target" >&2
    exit 1
  fi
  node_file=$(ls "$src_dir"/*.node 2>/dev/null | head -n1 || true)
  if [ -z "$node_file" ]; then
    echo "::error::no .node file found in $src_dir" >&2
    exit 1
  fi
  cp "$node_file" "$dst"
  if [ ! -s "$dst" ]; then
    echo "::error::$dst is empty" >&2
    exit 1
  fi
done

# Every committed version must equal the one being staged. The
# version-consistency check enforces this on every pull request; this
# catches a tag cut from a commit that edited one out of band.
for dir in "$NAPI_DIR" "$NAPI_DIR"/npm/*/; do
  actual=$(node -p "require('$dir/package.json').version")
  if [ "$actual" != "$EXPECTED" ]; then
    echo "::error::$dir/package.json version=$actual but the staged version is $EXPECTED" >&2
    exit 1
  fi
done

for triple in "${TARGET_TO_TRIPLE[@]}"; do
  (cd "$NAPI_DIR/npm/${triple}" && npm pack --pack-destination "$OUT")
done
(cd "$NAPI_DIR" && npm pack --pack-destination "$OUT")
ls -la "$OUT"
