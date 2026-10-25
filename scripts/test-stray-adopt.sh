#!/bin/bash
# A CDP client's stray page (createTarget newWindow) becomes one tab once the client leaves; headless scratch Roar (needs a build).
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
exec node "$root/tests/stray_adopt_test.mjs" "${ROAR_BIN:-$root/build/src/Release/Roar.app/Contents/MacOS/Roar}"
