#!/usr/bin/env bash
# Configures and builds Roar.app into build/src/Release/Roar.app.
set -euo pipefail
ROOT="${ROAR_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
BUILD="${ROAR_BUILD_DIR:-$ROOT/build}"
# ROAR_ARCH=x64 builds the Intel app into build-x64 against third_party/cef-x64
# (build-cef-codecs.sh with ROAR_CEF_ARCH=x64). Each Mac gets its own DMG, never a universal one.
ARCH="${ROAR_ARCH:-arm64}"
CMAKE_ARCH=()
if [[ "$ARCH" == x64 ]]; then
  [[ -d "$ROOT/third_party/cef-x64" ]] || { echo "build.sh: no third_party/cef-x64; build it with ROAR_CEF_ARCH=x64 scripts/build-cef-codecs.sh" >&2; exit 1; }
  BUILD="$BUILD-x64"
  CMAKE_ARCH=(-DPROJECT_ARCH=x86_64 -DCEF_ROOT="$ROOT/third_party/cef-x64")
fi
"$ROOT/scripts/fetch-cef.sh"
"$ROOT/scripts/fetch-ubol.sh"
"$ROOT/scripts/fetch-sparkle.sh"
cmake -S "$ROOT" -B "$BUILD" -G Ninja -DCMAKE_BUILD_TYPE=Release -DROAR_RELEASE="${ROAR_RELEASE:-OFF}" ${CMAKE_ARCH[@]+"${CMAKE_ARCH[@]}"}  # empty-array-safe on bash 3.2
cmake --build "$BUILD" --target roar
# The post-build copy only runs when the binary relinks; refresh resources every time.
RES="$BUILD/src/Release/Roar.app/Contents/Resources"
rm -rf "$RES/ui"
cp -R "$ROOT/resources/ui" "$RES/ui"
cp "$ROOT/resources/roar-mcp.sh" "$RES/"
# The MCP server (mcp/roar-mcp.mjs) ships as an executable so agents need no
# Node.js. Build-time dependency only: bun (https://bun.sh, `brew install bun`) compiles it
# per arch and installs the pinned chrome-devtools-mcp, which ships unbundled beside it.
command -v bun >/dev/null || { echo "build.sh: bun is needed to build roar-mcp (brew install bun)" >&2; exit 1; }
(cd "$ROOT/mcp" && bun install --frozen-lockfile --production)
bun build --compile --target="bun-darwin-$ARCH" "$ROOT/mcp/roar-mcp.mjs" --outfile "$RES/roar-mcp"
rm -rf "$RES/roar-mcp-modules" "$RES/roar-mcp.mjs"
cp -R "$ROOT/mcp/node_modules" "$RES/roar-mcp-modules"
rm -rf "$RES/extensions"
mkdir -p "$RES/extensions"
cp -R "$ROOT/third_party/ubol" "$RES/extensions/ubol"
cp "$ROOT/resources/Roar.sdef" "$ROOT/resources/roar.icns" "$RES/"
# Intel builds update from their own feed, so Sparkle never offers them an Apple Silicon DMG.
[[ "$ARCH" == x64 ]] && /usr/libexec/PlistBuddy -c "Set :SUFeedURL https://raw.githubusercontent.com/roarbrowser/roar/main/appcast-intel.xml" "$RES/../Info.plist"
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
# Sign by hash: the same certificate in two keychains makes its name ambiguous to codesign.
SIGN_HASH="$(grep -F "\"$SIGN_ID\"" <<<"$IDS" | awk '{print $2; exit}' || true)"  # no match for ad-hoc "-"
SIGN_HASH="${SIGN_HASH:-$SIGN_ID}"
if [[ "$SIGN_ID" == "Developer ID Application"* || "${ROAR_HARDENED:-}" == 1 ]]; then
  # --deep skips loose dylibs in CEF's Libraries folder (SwiftShader, Vulkan, the sandbox); notarization rejects them unsigned.
  find "$BUILD/src/Release/Roar.app/Contents/Frameworks" -path '*/Libraries/*.dylib' -type f -print0 |
    xargs -0 codesign --force --options runtime --timestamp --sign "$SIGN_HASH"
  # --deep skips executables in Resources; roar-mcp (bun) needs the JIT entitlements too.
  for t in "$RES/roar-mcp" "$BUILD/src/Release/Roar.app"; do
    codesign --force --deep --options runtime --timestamp --entitlements "$ROOT/resources/Roar.entitlements" \
      --sign "$SIGN_HASH" "$t"
  done
else
  codesign --force --sign "${SIGN_HASH:--}" "$RES/roar-mcp"  # --deep skips Resources
  codesign --force --deep --sign "${SIGN_HASH:--}" "$BUILD/src/Release/Roar.app"
fi
echo "$BUILD/src/Release/Roar.app"
