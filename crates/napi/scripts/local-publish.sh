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
# npm accepts a publish before the registry serves it ("Your package is
# being processed and may take a few minutes to become available"), so a
# lookup straight after publishing 404s for a package that did publish.
# Poll until every package resolves, and fail if one never does — a
# lookup that only prints its result would report "Done." either way.
VERIFY_ATTEMPTS="${VERIFY_ATTEMPTS:-30}"
VERIFY_INTERVAL="${VERIFY_INTERVAL:-10}"
pending=(
  @chordsketch/node
  @chordsketch/node-linux-x64-gnu
  @chordsketch/node-linux-arm64-gnu
  @chordsketch/node-darwin-x64
  @chordsketch/node-darwin-arm64
  @chordsketch/node-win32-x64-msvc
)
attempt=1
while :; do
  unserved=()
  for pkg in "${pending[@]}"; do
    if [ "$(npm view "$pkg@$VERSION" version 2>/dev/null)" = "$VERSION" ]; then
      printf "%-45s %s\n" "$pkg" "$VERSION"
    else
      unserved+=("$pkg")
    fi
  done
  # `${arr[@]+...}` keeps an empty array from tripping `set -u` on bash 3.2.
  pending=(${unserved[@]+"${unserved[@]}"})
  [ "${#pending[@]}" -eq 0 ] && break
  if [ "$attempt" -ge "$VERIFY_ATTEMPTS" ]; then
    echo "ERROR: the npm registry still does not serve $VERSION of: ${pending[*]}" >&2
    echo "Waited $(((VERIFY_ATTEMPTS - 1) * VERIFY_INTERVAL))s. Re-run this script; published packages are skipped." >&2
    exit 1
  fi
  echo "  waiting for the registry to serve: ${pending[*]}"
  attempt=$((attempt + 1))
  sleep "$VERIFY_INTERVAL"
done

echo
echo "Done."
