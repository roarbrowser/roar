#!/usr/bin/env bash
# Pins fetch-cef.sh to the newest stable CEF (latest Chromium) for macOS arm64,
# then rebuilds. Usage: scripts/update-cef.sh [--check]
# If third_party/cef is a source build (it has args.gn), the new version is
# compiled the same way (hours), so the update keeps Roar's patches and MP4/H.264
# playback through macOS's decoders. Each CEF bump needs roar_platform_codecs.patch
# rebased: supported_types.cc and audio_toolbox_audio_decoder.cc change often.
set -euo pipefail
ROOT="${ROAR_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
FETCH="$ROOT/scripts/fetch-cef.sh"
read -r NAME SHA1 < <(curl -sfL https://cef-builds.spotifycdn.com/index.json | python3 -c '
import json, sys
vs = json.load(sys.stdin)["macosarm64"]["versions"]
v = next(v for v in vs if v["channel"] == "stable")
f = next(f for f in v["files"] if f["type"] == "minimal")
print(f["name"].removesuffix(".tar.bz2"), f["sha1"])')
CURRENT=$(sed -n "s/^NAME='\(.*\)'$/\1/p" "$FETCH")
if [[ "$NAME" == "$CURRENT" ]]; then
  echo "Already on the latest stable CEF: $CURRENT"
  exit 0
fi
echo "Update available: $CURRENT -> $NAME"
[[ "${1:-}" == "--check" ]] && exit 0
sed -i '' -e "s|^NAME='.*'|NAME='$NAME'|" -e "s|^SHA1='.*'|SHA1='$SHA1'|" "$FETCH"
if [[ -f "$ROOT/third_party/cef/args.gn" ]]; then
  "$ROOT/scripts/build-cef-codecs.sh"
  # A universal build needs both halves on the same CEF, or build.sh lipos mismatched frameworks.
  [[ -d "$ROOT/third_party/cef-x64" ]] && ROAR_CEF_ARCH=x64 "$ROOT/scripts/build-cef-codecs.sh"
else
  rm -rf "$ROOT/third_party/cef"
fi
# Only the build tree and CMake's cache: the release DMG in build/ stays.
B="${ROAR_BUILD_DIR:-$ROOT/build}"
rm -rf "$B/src" "$B/libcef_dll_wrapper" "$B/CMakeCache.txt" "$B/CMakeFiles"
"$ROOT/scripts/build.sh"
