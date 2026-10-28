#!/bin/bash
# ⌘N opens an in-process window sharing cookies; ⇧⌘W closes it alone, against a headless scratch Roar (needs a build).
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
exec node "$root/tests/new_window_test.mjs" "${ROAR_BIN:-$root/build/src/Release/Roar.app/Contents/MacOS/Roar}"
