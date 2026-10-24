#!/bin/bash
# Address bar site menu (Allow pop-ups, Turn off blocking) and Ask under AI, against headless scratch Roars (needs a build).
# Optional $1: a directory for CDP screenshots.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
exec node "$root/tests/site_menu_test.mjs" "${ROAR_BIN:-$root/build/src/Release/Roar.app/Contents/MacOS/Roar}" "$@"
