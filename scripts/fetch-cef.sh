#!/usr/bin/env bash
# Downloads the pinned CEF minimal distribution into third_party/cef.
set -euo pipefail
ROOT="${ROAR_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
NAME='cef_binary_158.0.6+g23f1736+chromium-158.0.8127.89_macosarm64_minimal'
SHA1='63faae7ccd6a497430c06d26b17c4cac20dca387'
DEST="$ROOT/third_party"
[[ -d "$DEST/cef" ]] && { echo "CEF already at $DEST/cef"; exit 0; }
mkdir -p "$DEST"
curl -sfL -o "$DEST/cef.tar.bz2" "https://cef-builds.spotifycdn.com/${NAME//+/%2B}.tar.bz2"
echo "$SHA1  $DEST/cef.tar.bz2" | shasum -c -
tar xjf "$DEST/cef.tar.bz2" -C "$DEST"
mv "$DEST/$NAME" "$DEST/cef"
rm "$DEST/cef.tar.bz2"
