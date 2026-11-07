#!/bin/bash
# Model chat: optional API key on an added server, and "Ask about this page with" Model chat, against a headless scratch Roar (needs a build).
# Optional $1: a directory for CDP screenshots.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
exec node "$root/tests/model_chat_ask_test.mjs" "${ROAR_BIN:-$root/build/src/Release/Roar.app/Contents/MacOS/Roar}" "$@"
