#!/usr/bin/env bash
# Configures and builds Roar.app into build/src/Release/Roar.app.
set -euo pipefail
ROOT="${ROAR_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
BUILD="${ROAR_BUILD_DIR:-$ROOT/build}"
"$ROOT/scripts/fetch-cef.sh"
cmake -S "$ROOT" -B "$BUILD" -G Ninja -DCMAKE_BUILD_TYPE=Release
cmake --build "$BUILD" --target roar
codesign --force --deep --sign - "$BUILD/src/Release/Roar.app"
echo "$BUILD/src/Release/Roar.app"
