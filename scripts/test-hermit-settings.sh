#!/bin/bash
# Settings for a Hermit service (Agents > OpenCode plus its Hermit row in Chat models), against a fake Hermit service
# (tests/fake_hermitd.mjs) and a headless scratch Roar (needs a build). It saves a test password in the login Keychain
# and removes it at the end, so it needs a session where the Keychain is unlocked (gui-run over SSH). An optional folder
# gets screenshots of both parts.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
exec node "$root/tests/hermit_settings_test.mjs" "${ROAR_BIN:-$root/build/src/Release/Roar.app/Contents/MacOS/Roar}" "$@"
