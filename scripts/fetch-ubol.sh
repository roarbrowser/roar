#!/usr/bin/env bash
# Downloads the pinned uBlock Origin Lite (MV3) build into third_party/ubol.
set -euo pipefail
ROOT="${ROAR_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
VERSION='2026.1006.1931'
SHA256='1670f92590f5ad5b20f02d0a75e144572567b4ba979b3dc3204c41f651206fe7'
DEST="$ROOT/third_party/ubol"
[[ -f "$DEST/manifest.json" ]] && grep -q "\"$VERSION\"" "$DEST/manifest.json" && { echo "uBO Lite $VERSION already at $DEST"; exit 0; }
ZIP="$ROOT/third_party/ubol.zip"
mkdir -p "$ROOT/third_party"
curl -sfL -o "$ZIP" "https://github.com/uBlockOrigin/uBOL-home/releases/download/$VERSION/uBOLite_$VERSION.chromium.zip"
echo "$SHA256  $ZIP" | shasum -a 256 -c -
rm -rf "$DEST"
unzip -q "$ZIP" -d "$DEST"
rm "$ZIP"
