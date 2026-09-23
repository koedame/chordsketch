#!/usr/bin/env bash
# End-to-end check of the Quick Look preview extension in a built
# ChordSketch.app: the bundle is signed the way macOS needs, the
# ChordPro type resolves, `pluginkit` registers the extension, and
# Quick Look renders a `.cho` file through it.
#
# Usage: quicklook-smoke.sh <path to ChordSketch.app>
#
# Installs the app into ~/Applications (replacing any copy there) so
# LaunchServices registers it. Run by the macOS cell of
# `.github/workflows/desktop-build.yml`; also the way to check a local
# build — see `apps/desktop/preview-handler/README.md`.
set -euo pipefail

if [ "$#" -ne 1 ] || [ ! -d "$1" ]; then
  echo "usage: $0 <path to ChordSketch.app>" >&2
  exit 2
fi

# Must match `apps/desktop/preview-handler/src/quicklook.rs`.
EXTENSION_NAME=ChordSketchQuickLook
EXTENSION_BUNDLE_ID=me.koeda.chordsketch.desktop.quicklook
CHORDPRO_UTI=me.koeda.chordsketch.chordpro
LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

step() { printf '\n==> %s\n' "$*"; }
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

step "Install into ~/Applications"
mkdir -p "$HOME/Applications"
app="$HOME/Applications/ChordSketch.app"
rm -rf "$app"
ditto "$1" "$app"
appex="$app/Contents/PlugIns/$EXTENSION_NAME.appex"
[ -d "$appex" ] || fail "$appex is missing — tauri.macos.conf.json did not embed the extension"

step "Signatures"
# `--strict` with `--deep` also validates the nested extension against
# the app's seal, which is what `pluginkit` relies on.
codesign --verify --deep --strict --verbose=2 "$app"
codesign --display --verbose=2 "$appex" 2>&1 | grep -E '^(Identifier|Signature|CodeDirectory)'
codesign --display --entitlements - --xml "$appex" 2>/dev/null >"$work/entitlements.plist"
plutil -extract com.apple.security.app-sandbox raw "$work/entitlements.plist" | grep -qx true \
  || fail "the extension is not signed with the App Sandbox entitlement"

step "Register with LaunchServices and pluginkit"
"$LSREGISTER" -f -R "$app"
pluginkit -a "$appex"
# pluginkit's database is updated asynchronously.
for _ in $(seq 1 30); do
  if pluginkit -m -i "$EXTENSION_BUNDLE_ID" | grep -q "$EXTENSION_BUNDLE_ID"; then
    break
  fi
  sleep 1
done
pluginkit -m -v -i "$EXTENSION_BUNDLE_ID" | tee "$work/pluginkit.txt"
grep -q "$EXTENSION_BUNDLE_ID" "$work/pluginkit.txt" \
  || fail "pluginkit does not list $EXTENSION_BUNDLE_ID"

step "File type"
cat >"$work/smoke.cho" <<'EOF'
{title: Quick Look Smoke}
{artist: ChordSketch}
[Am]Hello [G]world
EOF
uti="$(swift -e 'import UniformTypeIdentifiers; print(UTType(filenameExtension: "cho")?.identifier ?? "none")')"
echo "UTType for .cho: $uti"
[ "$uti" = "$CHORDPRO_UTI" ] || fail ".cho resolves to $uti, not $CHORDPRO_UTI"

step "Render through Quick Look"
qlmanage -r >/dev/null 2>&1 || true
qlmanage -p -o "$work/out" "$work/smoke.cho" 2>&1 | tee "$work/qlmanage.txt"
find "$work/out" -type f -print
html="$(find "$work/out" -type f -name '*.html' | head -n 1)"
[ -n "$html" ] || fail "Quick Look wrote no HTML preview"
grep -q 'Quick Look Smoke' "$html" || fail "the preview does not carry the song title"
grep -q 'Hello' "$html" || fail "the preview does not carry the lyrics"
grep -q 'Content-Security-Policy' "$html" \
  || fail "the preview is not the extension's document (no CSP) — Quick Look fell back to another previewer"

step "OK"
