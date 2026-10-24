#!/usr/bin/env bash
# Downloads the pinned Sparkle 2 release (framework + bin/ tools) into third_party/Sparkle.
set -euo pipefail
ROOT="${ROAR_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
VERSION='2.10.0'
SHA256='c2bf58aa8387266ac179357b1415d6f2635f044da8be41042af32425dae6da0c'
DEST="$ROOT/third_party/Sparkle"
[[ -d "$DEST/Sparkle.framework" ]] && { echo "Sparkle already at $DEST"; exit 0; }
mkdir -p "$DEST"
curl -sfL -o "$DEST.tar.xz" "https://github.com/sparkle-project/Sparkle/releases/download/$VERSION/Sparkle-$VERSION.tar.xz"
echo "$SHA256  $DEST.tar.xz" | shasum -a 256 -c -
tar xJf "$DEST.tar.xz" -C "$DEST"
rm "$DEST.tar.xz"
