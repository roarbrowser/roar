#!/bin/bash
# Fill codes from Mail's Gmail source against a stub feed in a headless scratch Roar (needs a build).
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
exec node "$root/tests/gmail_codes_test.mjs" "${ROAR_BIN:-$root/build/src/Release/Roar.app/Contents/MacOS/Roar}"
