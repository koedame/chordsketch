#!/usr/bin/env bash
# Maintainer-local publish for @chordsketch/node + 5 platform packages.
#
# Per ADR-0008, npm publishing is a maintainer-local manual operation.
# CI's napi.yml builds the platform .node files and uploads them as
# tarballs to the GitHub Release. This script downloads those
# tarballs and runs `npm publish` for each.
#
# Usage: crates/napi/scripts/local-publish.sh <tag>
#   <tag>: the GitHub Release tag, e.g. v0.3.1
#
# Prerequisites:
#   - `gh` CLI logged in with read access to the release
#   - `npm whoami` returns `unchidev`; if not, `npm login` first
#   - 2FA on the unchidev npm account (you will be prompted per publish)

set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "Usage: $0 <tag>" >&2
  echo "Example: $0 v0.3.1" >&2
  exit 1
fi

TAG="$1"
VERSION="${TAG#v}"
REPO="${REPO:-koedame/chordsketch}"
WORK_DIR=$(mktemp -d)
trap 'rm -rf "$WORK_DIR"' EXIT

echo "==> Verifying npm session"
WHOAMI=$(npm whoami)
if [ "$WHOAMI" != "unchidev" ]; then
  echo "ERROR: npm whoami returned '$WHOAMI', expected 'unchidev'" >&2
  echo "Run \`npm login\` first." >&2
  exit 1
fi

echo "==> Downloading napi platform tarballs from $TAG"
cd "$WORK_DIR"
gh release download "$TAG" -R "$REPO" \
  -p "chordsketch-node-*-${VERSION}.tgz" \
  -p "chordsketch-node-${VERSION}.tgz"
ls -la

# Platform packages first — the meta package's optionalDependencies
# point at them, and installing the meta before the platform packages
# are live causes npm to silently skip them, then `require()` fails at
# runtime.
echo
echo "==> Publishing platform packages"
for triple in linux-x64-gnu linux-arm64-gnu darwin-x64 darwin-arm64 win32-x64-msvc; do
  pkg="@chordsketch/node-${triple}"
  tarball="chordsketch-node-${triple}-${VERSION}.tgz"
  if [ ! -f "$tarball" ]; then
    echo "ERROR: tarball $tarball missing from release $TAG" >&2
    exit 1
  fi
  if npm view "$pkg@$VERSION" version >/dev/null 2>&1; then
    echo "  $pkg@$VERSION already published — skipping"
    continue
  fi
  echo "  publishing $pkg@$VERSION"
  npm publish --access public "$tarball"
done

echo
echo "==> Publishing meta package (@chordsketch/node)"
META_TARBALL="chordsketch-node-${VERSION}.tgz"
if [ ! -f "$META_TARBALL" ]; then
  echo "ERROR: tarball $META_TARBALL missing from release $TAG" >&2
  exit 1
fi
if npm view "@chordsketch/node@$VERSION" version >/dev/null 2>&1; then
  echo "  @chordsketch/node@$VERSION already published — skipping"
else
  npm publish --access public "$META_TARBALL"
fi

echo
echo "==> Verification"
for pkg in \
  @chordsketch/node \
  @chordsketch/node-linux-x64-gnu \
  @chordsketch/node-linux-arm64-gnu \
  @chordsketch/node-darwin-x64 \
  @chordsketch/node-darwin-arm64 \
  @chordsketch/node-win32-x64-msvc; do
  printf "%-45s %s\n" "$pkg" "$(npm view "$pkg@$VERSION" version)"
done

echo
echo "Done."
