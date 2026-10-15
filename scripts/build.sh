#!/usr/bin/env bash
# Configures and builds Roar.app into build/src/Release/Roar.app.
set -euo pipefail
ROOT="${ROAR_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
BUILD="${ROAR_BUILD_DIR:-$ROOT/build}"
"$ROOT/scripts/fetch-cef.sh"
"$ROOT/scripts/fetch-ubol.sh"
"$ROOT/scripts/fetch-sparkle.sh"
cmake -S "$ROOT" -B "$BUILD" -G Ninja -DCMAKE_BUILD_TYPE=Release
cmake --build "$BUILD" --target roar
# The post-build copy only runs when the binary relinks; refresh resources every time.
RES="$BUILD/src/Release/Roar.app/Contents/Resources"
rm -rf "$RES/ui"
cp -R "$ROOT/resources/ui" "$RES/ui"
cp "$ROOT/resources/roar-mcp.sh" "$ROOT/resources/roar-mcp.mjs" "$RES/"
rm -rf "$RES/extensions"
mkdir -p "$RES/extensions"
cp -R "$ROOT/third_party/ubol" "$RES/extensions/ubol"
cp "$ROOT/resources/Roar.sdef" "$ROOT/resources/roar.icns" "$RES/"
rm -rf "$RES/../Frameworks/Sparkle.framework"
ditto "$ROOT/third_party/Sparkle/Sparkle.framework" "$RES/../Frameworks/Sparkle.framework"
# Ad-hoc signatures change every build, so macOS forgets privacy grants
# (Screen Recording loops on "Quit & Reopen"). Use a stable identity when one exists.
# A Developer ID identity (needed for notarized releases) wins over Apple Development;
# it signs with the hardened runtime, a secure timestamp and Roar.entitlements.
# ROAR_HARDENED=1 does the same with any identity, to test the hardened build locally.
IDS="$(security find-identity -v -p codesigning)"
SIGN_ID="${ROAR_SIGN_IDENTITY:-$(awk -F'"' '/Developer ID Application/{print $2; exit}' <<<"$IDS")}"
SIGN_ID="${SIGN_ID:-$(awk -F'"' '/Apple Development/{print $2; exit}' <<<"$IDS")}"
if [[ "$SIGN_ID" == "Developer ID Application"* || "${ROAR_HARDENED:-}" == 1 ]]; then
  codesign --force --deep --options runtime --timestamp --entitlements "$ROOT/resources/Roar.entitlements" \
    --sign "$SIGN_ID" "$BUILD/src/Release/Roar.app"
else
  codesign --force --deep --sign "${SIGN_ID:--}" "$BUILD/src/Release/Roar.app"
fi
echo "$BUILD/src/Release/Roar.app"
