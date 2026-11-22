#!/bin/bash
# Hermit service rows, against a fake Hermit service (tests/fake_hermitd.mjs) and a headless scratch Roar (needs a
# build). It saves a test password in the login Keychain and removes it at the end, so it needs a session where the
# Keychain is unlocked (not a bare SSH shell).
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
exec node "$root/tests/hermit_sessions_test.mjs" "${ROAR_BIN:-$root/build/src/Release/Roar.app/Contents/MacOS/Roar}" "$@"
