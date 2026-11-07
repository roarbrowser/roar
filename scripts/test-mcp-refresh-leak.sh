#!/bin/bash
# roar-mcp leaves exactly one inner chain across Roar relaunches and nothing after the connection ends, against a headless scratch Roar (needs a build).
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
exec node "$root/tests/mcp_refresh_leak_test.mjs" "${ROAR_BIN:-$root/build/src/Release/Roar.app/Contents/MacOS/Roar}"
