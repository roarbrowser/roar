#!/usr/bin/env bash
# Pins fetch-cef.sh to the newest stable CEF (latest Chromium) for macOS arm64,
# then refetches and rebuilds. Usage: scripts/update-cef.sh [--check]
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
rm -rf "$ROOT/third_party/cef" "${ROAR_BUILD_DIR:-$ROOT/build}"
"$ROOT/scripts/build.sh"
