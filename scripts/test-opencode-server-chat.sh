#!/usr/bin/env bash
# Model chat through an OpenCode server, end to end. Needs a built Roar and opencode; skips without opencode.
# Over SSH the Keychain is locked: run it with gui-run to cover the password.
set -euo pipefail
cd "$(dirname "$0")/.."
exe="${ROAR_EXE:-build/src/Release/Roar.app/Contents/MacOS/Roar}"
exec node tests/opencode_server_chat_test.mjs "$PWD/$exe" "$@"
