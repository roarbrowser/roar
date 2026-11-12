#!/bin/bash
# Unread mail panel (3 rows per inbox, per-account sign-out) against stub Gmail and Google pages in a headless scratch Roar (needs a build).
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
exec node "$root/tests/mail_panel_test.mjs" "${ROAR_BIN:-$root/build/src/Release/Roar.app/Contents/MacOS/Roar}" "$@"
