#!/bin/bash
# Agent pop-ups open Settings › Agents, against headless scratch Roars (needs a build).
# Optional $1: a directory for CDP screenshots.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
exec node "$root/tests/agent_settings_test.mjs" "${ROAR_BIN:-$root/build/src/Release/Roar.app/Contents/MacOS/Roar}" "$@"
