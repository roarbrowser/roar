#!/usr/bin/env bash
# Downloads the pinned CEF minimal distribution into third_party/cef.
set -euo pipefail
ROOT="${ROAR_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
NAME='cef_binary_156.0.30+g6028375+chromium-156.0.8078.96_macosarm64_minimal'
SHA1='6393d8a838d3b29f6b6939b970b5931dde2082aa'
DEST="$ROOT/third_party"
[[ -d "$DEST/cef" ]] && { echo "CEF already at $DEST/cef"; exit 0; }
mkdir -p "$DEST"
curl -sfL -o "$DEST/cef.tar.bz2" "https://cef-builds.spotifycdn.com/${NAME//+/%2B}.tar.bz2"
echo "$SHA1  $DEST/cef.tar.bz2" | shasum -c -
tar xjf "$DEST/cef.tar.bz2" -C "$DEST"
mv "$DEST/$NAME" "$DEST/cef"
rm "$DEST/cef.tar.bz2"
