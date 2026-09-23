#!/usr/bin/env bash
# End-to-end check of the Quick Look preview extension in a built
# ChordSketch.app: the bundle is signed the way macOS needs, the
# ChordPro type resolves, `pluginkit` registers the extension, and
# a Quick Look preview view runs it on a `.cho` file.
#
# Usage: quicklook-smoke.sh <path to ChordSketch.app> [screenshot directory]
#
# The screenshot of the preview is written to the second argument when
# given; look at it to confirm the song is rendered (chords above the
# lyrics) rather than shown as source text.
#
# Installs the app into ~/Applications (replacing any copy there) so
# LaunchServices registers it. Run by the macOS cell of
# `.github/workflows/desktop-build.yml`; also the way to check a local
# build — see `apps/desktop/preview-handler/README.md`.
set -euo pipefail

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ] || [ ! -d "$1" ]; then
  echo "usage: $0 <path to ChordSketch.app> [screenshot directory]" >&2
  exit 2
fi
here="$(cd "$(dirname "$0")" && pwd)"

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
# PlistBuddy, not `plutil -extract`: plutil reads the dots in the key
# as a key path.
/usr/libexec/PlistBuddy -c 'Print :com.apple.security.app-sandbox' "$work/entitlements.plist" \
  | grep -qx true || fail "the extension is not signed with the App Sandbox entitlement"

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
cat >"$work/uti.swift" <<'EOF'
import UniformTypeIdentifiers
print(UTType(filenameExtension: "cho")?.identifier ?? "none")
EOF
uti="$(xcrun swift "$work/uti.swift")"
echo "UTType for .cho: $uti"
[ "$uti" = "$CHORDPRO_UTI" ] || fail ".cho resolves to $uti, not $CHORDPRO_UTI"

step "Render through Quick Look"
# Not `qlmanage -p`: it aborts on every app-extension preview on current
# macOS. quicklook-render.swift hosts the view Finder's panel uses.
shots="${2:-$work}"
mkdir -p "$shots"
qlmanage -r >/dev/null 2>&1 || true
xcrun swift "$here/quicklook-render.swift" "$work/smoke.cho" "$shots/quicklook-preview.png" 20 &
render=$!
seen=""
for _ in $(seq 1 80); do
  if pgrep -x "$EXTENSION_NAME" >/dev/null; then
    seen=yes
    break
  fi
  sleep 0.5
done
wait "$render" || fail "the preview window could not be captured"
echo "Screenshot: $shots/quicklook-preview.png"
if [ -z "$seen" ]; then
  log show --last 3m --style compact \
    --predicate "process == \"$EXTENSION_NAME\" OR eventMessage CONTAINS \"$EXTENSION_BUNDLE_ID\"" 2>/dev/null | tail -n 40 || true
  fail "Quick Look never started $EXTENSION_NAME for the .cho file"
fi
echo "$EXTENSION_NAME ran for the preview"
crashes="$(find "$HOME/Library/Logs/DiagnosticReports" -name "$EXTENSION_NAME*" 2>/dev/null || true)"
[ -z "$crashes" ] || fail "$EXTENSION_NAME crashed: $crashes"

step "OK"
