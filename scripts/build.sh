#!/usr/bin/env bash
# Configures and builds Roar.app into build/src/Release/Roar.app.
set -euo pipefail
ROOT="${ROAR_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
BUILD="${ROAR_BUILD_DIR:-$ROOT/build}"
"$ROOT/scripts/fetch-cef.sh"
"$ROOT/scripts/fetch-ubol.sh"
cmake -S "$ROOT" -B "$BUILD" -G Ninja -DCMAKE_BUILD_TYPE=Release
cmake --build "$BUILD" --target roar
# The post-build copy only runs when the binary relinks; refresh resources every time.
RES="$BUILD/src/Release/Roar.app/Contents/Resources"
rm -rf "$RES/ui"
cp -R "$ROOT/resources/ui" "$RES/ui"
rm -rf "$RES/extensions"
mkdir -p "$RES/extensions"
cp -R "$ROOT/third_party/ubol" "$RES/extensions/ubol"
cp "$ROOT/resources/Roar.sdef" "$ROOT/resources/roar.icns" "$RES/"
# Ad-hoc signatures change every build, so macOS forgets privacy grants
# (Screen Recording loops on "Quit & Reopen"). Use a stable identity when one exists.
SIGN_ID="${ROAR_SIGN_IDENTITY:-$(security find-identity -v -p codesigning | awk -F'"' '/Apple Development/{print $2; exit}')}"
codesign --force --deep --sign "${SIGN_ID:--}" "$BUILD/src/Release/Roar.app"
echo "$BUILD/src/Release/Roar.app"
