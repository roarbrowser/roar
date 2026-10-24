#!/usr/bin/env bash
# Downloads the pinned CEF minimal distribution into third_party/cef.
set -euo pipefail
ROOT="${ROAR_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
NAME='cef_binary_154.0.34+g14c5a08+chromium-154.0.8037.98_macosarm64_minimal'
SHA1='b7081f6609e5edccf07be96b5d7977329fbe1bdf'
DEST="$ROOT/third_party"
[[ -d "$DEST/cef" ]] && { echo "CEF already at $DEST/cef"; exit 0; }
mkdir -p "$DEST"
curl -sfL -o "$DEST/cef.tar.bz2" "https://cef-builds.spotifycdn.com/${NAME//+/%2B}.tar.bz2"
echo "$SHA1  $DEST/cef.tar.bz2" | shasum -c -
tar xjf "$DEST/cef.tar.bz2" -C "$DEST"
mv "$DEST/$NAME" "$DEST/cef"
rm "$DEST/cef.tar.bz2"
