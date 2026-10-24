#!/bin/bash
# Claude Desktop only (no claude CLI): install notice, Copy, no false Connected, against a headless scratch Roar (needs a build).
# Optional $1: a directory for CDP screenshots.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
exec node "$root/tests/agent_desktop_test.mjs" "${ROAR_BIN:-$root/build/src/Release/Roar.app/Contents/MacOS/Roar}" "$@"
