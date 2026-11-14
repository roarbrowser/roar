#!/bin/bash
# Ghost tabs as the off-the-record copy of their space (Mac): extensions allowed in incognito run there, cookies
# stay in the session, against a headless scratch Roar (needs a build).
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
exec node "$root/tests/ghost_incognito_test.mjs" "${ROAR_BIN:-$root/build/src/Release/Roar.app/Contents/MacOS/Roar}"
