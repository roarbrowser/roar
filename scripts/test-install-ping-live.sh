#!/bin/bash
# Install counting in a headless scratch Roar against a fake Umami (tests/install_ping_live_test.mjs).
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
exec node "$root/tests/install_ping_live_test.mjs" "${1:-$root/build/src/Release/Roar.app/Contents/MacOS/Roar}"
