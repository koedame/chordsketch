#!/usr/bin/env bash
# Move the downloaded JNI libraries to the classpath directories JNA
# loads native libraries from (`<os>-<arch>/`, e.g. `linux-x86-64/`).
#
# Usage: packages/kotlin/scripts/stage-jni-libs.sh <artifacts-dir>
#   <artifacts-dir>: holds one `jni-<os>-<arch>/` directory per platform
#                    (the layout `actions/download-artifact` gives kotlin.yml's
#                    build artifacts)
#
# Run by kotlin.yml's `publish` job and by publishable.yml. Downloading the
# artifacts straight into src/main/resources/ kept the `jni-` prefix, so
# every published jar up to 0.6.0 carried `jni-linux-x86-64/...`, a path
# JNA never looks at.

set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "Usage: $0 <artifacts-dir>" >&2
  exit 2
fi

ARTIFACTS=$(cd "$1" && pwd)
RESOURCES="$(cd "$(dirname "$0")/.." && pwd)/lib/src/main/resources"

for platform in linux-x86-64 linux-aarch64 darwin-aarch64 darwin-x86-64 win32-x86-64; do
  src="$ARTIFACTS/jni-${platform}"
  if ! compgen -G "$src/*" > /dev/null; then
    echo "::error::no JNI library in $src; the build failed for $platform" >&2
    exit 1
  fi
  mkdir -p "$RESOURCES/$platform"
  cp "$src"/* "$RESOURCES/$platform/"
done
find "$RESOURCES" -type f | sort
