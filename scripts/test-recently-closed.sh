#!/bin/bash
# Recently Closed: every close path that should be restorable, and groups/spaces restored whole, against a headless
# scratch Roar (needs a build). Optional: a CDP port as the first argument.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
exec node "$root/tests/recently_closed_test.mjs" "${ROAR_BIN:-$root/build/src/Release/Roar.app/Contents/MacOS/Roar}" "$@"
