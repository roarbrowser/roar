#!/bin/bash
# Renamed Claude Code sessions in the sidebar, in a headless scratch Roar (needs a build).
root="$(cd "$(dirname "$0")/.." && pwd)"
exec node "$root/tests/agent_rename_test.mjs" "${ROAR_BIN:-$root/build/src/Release/Roar.app/Contents/MacOS/Roar}" "$@"
