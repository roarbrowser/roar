#!/bin/bash
# Share cards, against a headless scratch Roar (needs a build). Optional $1: a directory for the card, GIF and screenshots.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
exec node "$root/tests/share_cards_test.mjs" "${ROAR_BIN:-$root/build/src/Release/Roar.app/Contents/MacOS/Roar}" "$@"
